import { relative } from "node:path";
import { z } from "zod";
import type { NodeExecutionSnapshot, NodeJobView } from "@toonflow/nodes-scaffold/execution";
import { runNodeLifecycle } from "@/utils/canvas/context";
import { requestDigest } from "@/utils/canvas/store";
import { acceptNodeJob, ensureNodeJobsReady, getNodeJob, getNodeJobForCommand, getNodeJobRequest, registerNodeJobHandler, waitForNodeJob } from "@/utils/jobs";
import { loadNodeExecution } from "@/utils/plugins/nodeExecution";
import { getNodeConfig, readNode } from "@/utils/plugins/nodes";
import { resolveWorkspaceFile, resolveWorkspacePath } from "@/utils/workspace/files";
import { modifyGraph, readGraph, type GraphChange } from "@/utils/workspace/graph";

type Graph = Awaited<ReturnType<typeof readGraph>>;
const lifecycleSchema = z.object({
  hook: z.enum(["initialize", "remove"]), revision: z.string().regex(/^[a-f0-9]{64}$/),
  config: z.record(z.string(), z.json()),
  node: z.object({ id: z.string().min(1), type: z.string().min(1),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    data: z.record(z.string(), z.unknown()), parentNode: z.string().optional(), version: z.number().int().nonnegative() }),
});
type Lifecycle = z.infer<typeof lifecycleSchema>;
type Modification = {
  canvasPath: string;
  operationId: string;
  intentDigest: string;
  changes: GraphChange[];
  lifecycle: Lifecycle[];
};
const pendingAcceptances = new Map<string, { digest: string; accepted: Promise<NodeJobView> }>();
let registered = false;

function nodeSnapshot(graph: Graph, node: Graph["nodes"][number]): NodeExecutionSnapshot {
  return { id: node.id, type: node.type ?? "", position: structuredClone(node.position) as NodeExecutionSnapshot["position"],
    data: structuredClone(node.data ?? {}), ...(node.parentNode ? { parentNode: node.parentNode } : {}),
    version: graph.toonflowGraph!.nodes[node.id] ?? 0 };
}

function needsReview(message: string, cause: unknown): never {
  throw Object.assign(new Error(message, { cause }), { code: "JOB_NEEDS_REVIEW" });
}

export function registerCanvasLifecycleJobHandlers() {
  if (registered) return;
  registerNodeJobHandler("canvasModify", async (raw, context) => {
    const input = raw as Modification;
    const saved = getNodeJob(context.jobId)?.result as { completedLifecycle?: unknown } | undefined;
    const completedLifecycle = z.array(z.number().int().nonnegative()).safeParse(saved?.completedLifecycle).data ?? [];
    const { path } = await resolveWorkspacePath(context.directory, input.canvasPath);
    context.beginCommit();
    let graph = await modifyGraph(path, input.operationId, input.changes, context.directory);
    context.saveResult({ graph, completedLifecycle });
    // ACT: 完成点保存在同一持久任务；未完成 hook 依赖稳定命令和文件/图回执恢复。
    for (const [index, lifecycle] of input.lifecycle.entries()) {
      if (completedLifecycle.includes(index)) continue;
      const commandId = `${input.operationId}:lifecycle:${index}`;
      try {
        await runNodeLifecycle({ ...lifecycle, directory: context.directory, canvasPath: input.canvasPath, commandId }, context.signal);
        completedLifecycle.push(index);
        context.saveResult({ graph, completedLifecycle });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        needsReview(`画布修改已提交，节点 ${lifecycle.node.id} 的 ${lifecycle.hook} 未完成：${reason}；快照与任务 ${context.jobId} 已保留，请核对后恢复原任务`, error);
      }
    }
    graph = await readGraph(path, context.directory);
    context.saveResult({ graph, completedLifecycle });
    return graph;
  }, "safe");
  registered = true;
}

function existingModification(directory: string, operationId: string, digest: string) {
  const existing = getNodeJobForCommand(directory, operationId, "canvasModify");
  if (!existing) return;
  if (getNodeJobRequest(existing.jobId)?.input.intentDigest !== digest)
    throw Object.assign(new Error("画布操作 ID 已用于其他画布或内容"), { status: 409 });
  return existing;
}

async function freezeModification(directory: string, canvasPath: string, operationId: string, changes: GraphChange[], intentDigest: string): Promise<Modification> {
  const { path } = await resolveWorkspacePath(directory, canvasPath);
  const graph = await readGraph(path, directory);
  const lifecycle: Lifecycle[] = [];
  const frozenChanges = structuredClone(changes);
  for (const change of frozenChanges) {
    if (change.kind !== "node") continue;
    const current = graph.nodes.find(node => node.id === change.id);
    const isAddition = !current && change.value !== null;
    const isRemoval = !!current && change.value === null;
    if (!isAddition && !isRemoval) continue;
    if (change.expectedVersion !== (graph.toonflowGraph!.nodes[change.id] ?? 0))
      throw Object.assign(new Error(`画布版本冲突：node:${change.id}`), { status: 409 });
    const node = isAddition ? change.value! : current!;
    if (node.type === "canvasGroup") continue;
    if (typeof node.type !== "string") throw Object.assign(new Error("节点类型无效"), { status: 400 });
    const name = node.type.startsWith("remote-") ? node.type.slice(7) : node.type;
    const revision = node.data?.executionRevision;
    const loaded = await loadNodeExecution(name, typeof revision === "string" ? revision : undefined);
    const config = getNodeConfig(await readNode(name));
    if (isAddition) {
      node.data = { ...structuredClone(loaded.definition.defaultData), ...node.data,
        handles: structuredClone(loaded.definition.handles), outputs: node.data?.outputs ?? {},
        executionRevision: loaded.revision, stateVersion: loaded.definition.stateVersion };
    }
    const hook = isAddition ? "initialize" : "remove";
    const snapshot = nodeSnapshot(graph, node);
    if (isAddition) snapshot.version = change.expectedVersion + 1;
    lifecycle.push(lifecycleSchema.parse({ hook, revision: loaded.revision, config, node: snapshot }));
  }
  return { canvasPath, operationId, intentDigest, changes: frozenChanges, lifecycle };
}

export async function modifyCanvas(directory: string, canvasPath: string, operationId: string, changes: GraphChange[]): Promise<Graph> {
  registerCanvasLifecycleJobHandlers();
  await ensureNodeJobsReady();
  const resolved = await resolveWorkspaceFile(directory, canvasPath);
  directory = resolved.directory;
  canvasPath = relative(directory, resolved.path).replaceAll("\\", "/");
  const digest = requestDigest({ canvasPath, changes });
  const existing = existingModification(directory, operationId, digest);
  if (existing) {
    await waitForNodeJob(existing.jobId);
    return readGraph(resolved.path, directory);
  }
  const key = `${directory}\0${operationId}`;
  let pending = pendingAcceptances.get(key);
  if (pending && pending.digest !== digest) throw Object.assign(new Error("画布操作 ID 已用于其他内容"), { status: 409 });
  if (!pending) {
    const accepted = (async () => {
      const input = await freezeModification(directory, canvasPath, operationId, changes, digest);
      return acceptNodeJob({ directory, commandId: operationId, request: { kind: "canvasModify", canvasPath, input } });
    })();
    pending = { digest, accepted };
    pendingAcceptances.set(key, pending);
    void accepted.finally(() => { if (pendingAcceptances.get(key)?.accepted === accepted) pendingAcceptances.delete(key); }).catch(() => {});
  }
  const job = await pending.accepted;
  await waitForNodeJob(job.jobId);
  return readGraph(resolved.path, directory);
}
