import type { CanvasCommand, CanvasCommandResult, NodeExecutionDescriptor, NodeJobView, WorkspaceEvent } from "./execution";

export type NodeCatalogEntry = Partial<NodeExecutionDescriptor> & {
  name: string;
  displayName: string;
  url: string;
  revision: string;
  enabled?: boolean;
  builtin?: boolean;
  config?: Record<string, unknown>;
  executionStatus?: string | { message?: string };
};

export class ExecutionRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
let clientId: string | undefined;
export function getExecutionClientId() { return clientId ??= crypto.randomUUID(); }

export async function executionRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options);
  const payload = await response.json().catch(error => { if (response.ok) throw error; return null; });
  if (!response.ok || payload?.code !== 200 && payload?.code !== 202) {
    if (response.ok && !(payload?.code >= 400 && payload?.code <= 599)) throw new Error("服务端响应格式无效，原提交结果待确认");
    throw new ExecutionRequestError(payload?.message || `请求失败（${response.status}）`, response.ok ? payload.code : response.status);
  }
  return payload.data as T;
}

export async function* readExecutionEvents<T>(response: Response, signal: AbortSignal): AsyncGenerator<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ExecutionRequestError(payload?.message || `订阅失败（${response.status}）`, response.status);
  }
  if (!response.body) throw new Error("未收到事件流");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let pending = "";
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      pending += value ?? "";
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (done && pending.trim()) lines.push(pending);
      for (const line of lines) if (line.trim()) yield JSON.parse(line) as T;
      if (done) return;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function commandReceipt(result: CanvasCommandResult, commandId: string) {
  if (!result || result.commandId !== commandId || !["accepted", "running", "completed", "failed", "needsReview"].includes(result.status)) throw new Error("命令收据无效，原提交结果待确认");
  return result;
}

export function createExecutionClient(directory: string) {
  if (!directory.trim()) throw new Error("请先选择工作目录");
  const query = (params: Record<string, string | number>) => new URLSearchParams({ directory, ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])) });
  const json = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json", "X-Toonflow-Protocol": "2" }, body: JSON.stringify(body), signal });

  async function getCommand(commandId: string, signal?: AbortSignal) {
    try {
      const result = await executionRequest<CanvasCommandResult | null>(`/api/workspaces/canvas/command/get?${query({ commandId })}`, { signal });
      return result === null ? null : commandReceipt(result, commandId);
    } catch (error) {
      if (error instanceof ExecutionRequestError && error.status === 404) return null;
      throw error;
    }
  }

  async function command(input: Omit<CanvasCommand, "directory" | "commandId"> & { commandId?: string }, signal?: AbortSignal) {
    // ACT: 同一次提交固定序列化内容与 ID；只在成功对账为未受理后重发一次，不能把未知结果当未执行。
    const body: CanvasCommand = JSON.parse(JSON.stringify({ ...input, directory, commandId: input.commandId ?? crypto.randomUUID(), clientContext: input.clientContext ?? { clientId: getExecutionClientId() } }));
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try {
        const result = await executionRequest<CanvasCommandResult>("/api/workspaces/canvas/command", json(body, signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)));
        return commandReceipt(result, body.commandId);
      } catch (error) {
        if (error instanceof ExecutionRequestError && error.status < 500) throw error;
        signal?.throwIfAborted();
        const accepted = await getCommand(body.commandId, signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)).catch(() => { throw error; });
        if (accepted) return accepted;
        if (attempt) throw error;
      }
    }
    throw new Error("命令未受理");
  }

  async function readContent(path: string, signal?: AbortSignal) {
    const result = await executionRequest<{ content: string; revision: string }>(`/api/workspaces/canvas/content?${query({ path })}`, { signal });
    if (typeof result?.content !== "string" || !/^[a-f0-9]{64}$/.test(result.revision)) throw new Error("正文快照缺少有效内容或版本");
    return result;
  }

  async function execute<T = unknown>(input: Parameters<typeof command>[0], signal?: AbortSignal): Promise<T> {
    let result = await command(input, signal);
    const waitSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
    while (result.status === "accepted" || result.status === "running") {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(waitSignal.reason); };
        const timer = setTimeout(() => { waitSignal.removeEventListener("abort", cancel); resolve(); }, 500);
        waitSignal.addEventListener("abort", cancel, { once: true });
        if (waitSignal.aborted) cancel();
      });
      waitSignal.throwIfAborted();
      result = await getCommand(result.commandId, waitSignal) ?? result;
    }
    if (result.status !== "completed") throw new ExecutionRequestError(result.errorMessage || "后端命令需要核对或已失败", result.status === "needsReview" ? 409 : 422);
    return result.result as T;
  }

  async function writeContent(path: string, content: string, expectedRevision: string, commandId: string = crypto.randomUUID(), signal?: AbortSignal) {
    const request = { ...json({ directory, path, content, expectedRevision, commandId }), method: "PUT" };
    // ACT: 正文接口以原 ID 返回已落盘收据，响应丢失后重发相同 CAS 不会再次覆盖后续编辑。
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try {
        const result = await executionRequest<{ revision: string }>("/api/workspaces/canvas/content/write", { ...request, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
        if (!result || !/^[a-f0-9]{64}$/.test(result.revision)) throw new Error("正文写入收据无效，保存结果待确认");
        return result;
      } catch (error) {
        if (attempt || error instanceof ExecutionRequestError && error.status < 500) throw error;
      }
    }
    throw new Error("正文保存结果待确认，原命令已保留");
  }

  async function subscribe(afterSeq: number, onEvent: (event: WorkspaceEvent) => void | Promise<void>, signal: AbortSignal) {
    const response = await fetch(`/api/workspaces/canvas/events?${query({ afterSeq })}`, { signal });
    let cursor = afterSeq;
    for await (const event of readExecutionEvents<WorkspaceEvent>(response, signal)) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= cursor || event.directory !== directory) continue;
      await onEvent(event);
      cursor = event.seq;
    }
  }

  return {
    directory, command, execute, getCommand, readContent, writeContent, subscribe,
    listJobs: (signal?: AbortSignal) => executionRequest<NodeJobView[]>(`/api/jobs/list?${query({})}`, { signal }),
    listJobSnapshot: (signal?: AbortSignal) => executionRequest<{ jobs: NodeJobView[]; cursor: number }>(`/api/jobs/list?${query({ snapshot: 1 })}`, { signal }),
    getJob: (jobId: string, signal?: AbortSignal) => executionRequest<NodeJobView>(`/api/jobs/get?${query({ jobId })}`, { signal }),
    cancelJob: (jobId: string) => executionRequest<NodeJobView>("/api/jobs/cancel", json({ directory, jobId })),
    resumeJob: (jobId: string) => executionRequest<NodeJobView>("/api/jobs/resume", json({ directory, jobId, confirmed: true })),
  };
}

export async function fetchNodeCatalog(signal?: AbortSignal) {
  const nodes = await executionRequest<NodeCatalogEntry[]>("/api/nodes/get", { signal, headers: { "Cache-Control": "no-cache" } });
  if (!Array.isArray(nodes)) throw new Error("节点列表格式错误");
  return nodes.filter(node => node && /^[a-z][a-zA-Z0-9]*$/.test(node.name) && node.url === `/api/nodes/files?name=${node.name}` && /^[a-f0-9]{64}$/.test(node.revision));
}

export function isExecutableNode(node: NodeCatalogEntry): node is NodeCatalogEntry & NodeExecutionDescriptor {
  return node.protocolVersion === 2 && typeof node.executionRevision === "string" && /^[a-f0-9]{64}$/.test(node.executionRevision)
    && Array.isArray(node.handles) && Array.isArray(node.actions) && !!node.defaultData && !!node.layoutSize;
}
