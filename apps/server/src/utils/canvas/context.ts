import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import type { CanvasContext, NodeToolInfo, NodeToolsContext, MediaGenerationRequest, MediaReference } from "@toonflow/tools-scaffold/runtime";
import type { CanvasCommand, CanvasCommandResult, NodeExecutionContext, NodeExecutionDescriptor, NodeExecutionSnapshot } from "@toonflow/nodes-scaffold/execution";
import { isTypeCompatible } from "@toonflow/nodes-scaffold/connection";
import { canvasSchemas, type CanvasRequest } from "@toonflow/tool-canvas/runtime";
import { imageGenerationSchema, videoGenerationSchema, audioGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { createCanvasQueries, isCanvasRead } from "@toonflow/tool-canvas/queries";
import { readGraph, modifyGraph, type GraphChange } from "@/utils/workspace/graph";
import { resolveWorkspace } from "@/utils/workspace";
import { resolveWorkspacePath, writeWorkspaceFile, renameWorkspaceFile, assertNoManagedGraph } from "@/utils/workspace/files";
import { listNodeExecutions, loadNodeExecution } from "@/utils/plugins/nodeExecution";
import { readNode, getNodeConfig } from "@/utils/plugins/nodes";
import { readVersionedContent, writeVersionedContent, assertNoManagedResource } from "@/utils/canvas/content";
import { acceptCanvasCommand, appendWorkspaceEvent, getCanvasCommand, listIncompleteCanvasCommands, requestDigest, updateCanvasCommand } from "@/utils/canvas/store";
import { acceptNodeJob, activateNodeJob, getNodeJob, getNodeJobRequest, cancelNodeJob, waitForNodeJob } from "@/utils/jobs";
import { arrangeGraph } from "@/utils/canvas/layout";
import { captureNodeInputs, captureInputFile, type NodeInputSnapshot } from "@/utils/canvas/inputs";
import { listAiModels, getConfiguredModel, readAiReferences, aiReferenceSchema } from "@/utils/ai";
import { listMediaModels } from "@/utils/media/generation";
import { acceptMediaJob, getMediaJob, getMediaJobByIdempotency, retryMediaJobCollection } from "@/utils/media/mediaJobs";

type Graph = Awaited<ReturnType<typeof readGraph>>;
type Node = Graph["nodes"][number];
type BackendCommand = CanvasCommand & { inputSnapshot?: NodeInputSnapshot };
const running = new Map<string, Promise<CanvasCommandResult>>();
let recovered = false;

export const canvasCommandSchema = z.strictObject({
  commandId: z.string().min(1).max(80), directory: z.string().min(1).max(4096),
  canvasPath: z.string().max(4096), name: z.string().min(1).max(96), args: z.record(z.string(), z.json()),
  expectedVersions: z.record(z.string(), z.number().int().nonnegative()).optional(),
  clientContext: z.strictObject({ clientId: z.string().min(1).max(128), selectedNodeIds: z.array(z.string().min(1).max(256)).max(1000).optional() }).optional(),
});

function snapshot(graph: Graph, node: Node): NodeExecutionSnapshot {
  return { id: node.id, type: node.type ?? "", position: node.position as { x: number; y: number }, data: structuredClone(node.data ?? {}), parentNode: node.parentNode, version: graph.toonflowGraph!.nodes[node.id] ?? 0 };
}

async function listCanvases(directory: string) {
  const files = await readdir(directory, { withFileTypes: true });
  const items: { id: string; name: string; graph: Graph }[] = [];
  for (const file of files.filter(item => item.isFile() && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
    const { path } = await resolveWorkspacePath(directory, file.name);
    const content = await readFile(path, "utf8");
    let parsed;
    try { parsed = JSON.parse(content); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (parsed?.toonflowCanvas !== true) continue;
    items.push({ id: file.name, name: file.name.slice(0, -5), graph: await readGraph(path, directory) });
  }
  return items;
}

async function resolveCanvas(directory: string, target?: { id?: string; canvasPath?: string }) {
  const canvases = await listCanvases(directory);
  const id = target?.canvasPath ?? target?.id;
  if (!id) return canvases[0]?.id ?? "";
  const matching = canvases.find(item => item.id === id || item.graph.toonflowGraph!.id === id);
  if (matching) return matching.id;
  if (id.endsWith(".json")) {
    const { path } = await resolveWorkspacePath(directory, id);
    await readGraph(path, directory);
    return relative(directory, path).replaceAll("\\", "/");
  }
  throw Object.assign(new Error("目标画布不存在，请刷新项目"), { status: 404 });
}

function nodeType(type: string) { return type.startsWith("remote-") ? type.slice(7) : type; }

function operationId(commandId: string, index: number) {
  return requestDigest([commandId, index]).slice(0, 32);
}

export async function createBackendCanvasContext(directory: string, target?: { id?: string; canvasPath?: string; selectedNodeIds?: string[] }, options: { runId?: string; clientId?: string; onTargetChanged?: (canvasPath: string) => void; command?: BackendCommand } = {}): Promise<CanvasContext & { canvasPath: string }> {
  const cwd = await resolveWorkspace(directory);
  let canvasPath = await resolveCanvas(cwd, target);
  let graph: Graph | undefined;
  let descriptors: NodeExecutionDescriptor[] = [];
  let canvases: { id: string; name: string; graph: Graph }[] = [];
  let selected = new Set(target?.selectedNodeIds ?? []);
  const contextId = options.runId ?? options.clientId ?? cwd;

  async function refresh() {
    descriptors = await listNodeExecutions();
    canvases = await listCanvases(cwd);
    graph = canvasPath ? canvases.find(item => item.id === canvasPath)?.graph ?? await readGraph((await resolveWorkspacePath(cwd, canvasPath)).path, cwd) : undefined;
    if (canvasPath && graph && !canvases.some(item => item.id === canvasPath)) canvases.push({ id: canvasPath, name: canvasPath.slice(0, -5), graph });
  }

  function requireGraph(): Graph {
    if (!graph) throw Object.assign(new Error("请先选择或创建画布"), { status: 409 });
    return graph;
  }

  function requireNode(id: string) {
    const node = requireGraph().nodes.find(item => item.id === id);
    if (!node) throw Object.assign(new Error(`节点不存在：${id}`), { status: 404 });
    return node;
  }

  function toolsFor(nodeIds: string[], names?: string[]): NodeToolInfo[] {
    const infos: NodeToolInfo[] = [];
    for (const id of nodeIds) {
      const node = graph?.nodes.find(item => item.id === id);
      const descriptor = node && descriptors.find(item => item.name === nodeType(node.type ?? ""));
      for (const action of descriptor?.actions ?? []) {
        const name = `node:${action.name}` as const;
        if (names && !names.includes(name)) continue;
        infos.push({ nodeId: id, name, nodeLabel: String(node!.data?.label ?? id), nodeRevision: descriptor!.executionRevision, description: action.description, parameters: action.parameters });
      }
    }
    return infos;
  }

  const nodeTools: NodeToolsContext = {
    get tools() { return toolsFor(graph?.nodes.map(item => item.id) ?? []); },
    get version() { return parseInt(requestDigest(descriptors.map(item => item.executionRevision)).slice(0, 8), 16); },
    *list(ids, names) { yield* toolsFor(ids, names); },
    call(request, signal) { return call({ name: "nodeTools", args: request as unknown as Record<string, unknown> }, signal); },
  };

  const queries = createCanvasQueries({
    scopeId: contextId,
    nodes: () => requireGraph().nodes.map(node => ({ ...node, position: node.position as { x: number; y: number }, selected: selected.has(node.id), data: node.data ?? {} })),
    edges: () => requireGraph().edges,
    findNode: id => { const node = graph?.nodes.find(item => item.id === id); return node ? { ...node, position: node.position as { x: number; y: number }, data: node.data ?? {}, selected: selected.has(id) } : undefined; },
    viewport: () => graph?.viewport ?? { x: 0, y: 0, zoom: 1 },
    selectedCount: () => [...selected].filter(id => graph?.nodes.some(node => node.id === id)).length,
    nodeRevision: () => graph?.toonflowGraph!.revision ?? 0,
    edgeRevision: () => graph?.toonflowGraph!.revision ?? 0,
    canvases: () => canvases.map(({ id, name }) => ({ id, name })),
    nodeTypes: () => [{ type: "canvasGroup", label: "分组" }, ...descriptors.map(item => ({ type: `remote-${item.name}`, label: item.name }))],
    nodeTools: () => nodeTools,
  });

  async function apply(changes: GraphChange[], command: CanvasCommand, step: number) {
    for (const change of changes) {
      const id = change.kind === "node" || change.kind === "edge" ? change.id : change.kind === "output" ? change.nodeId : "viewport";
      const expected = command.expectedVersions?.[id];
      if (expected !== undefined && expected !== change.expectedVersion) throw Object.assign(new Error(`版本冲突：${id}`), { status: 409 });
    }
    const { path } = await resolveWorkspacePath(cwd, canvasPath);
    graph = await modifyGraph(path, operationId(command.commandId, step), changes, cwd);
    return graph;
  }

  function nodeChange(node: Node, value: Node | null): GraphChange {
    const current = requireGraph();
    const parentIds = new Set([node.parentNode, value?.parentNode].filter((id): id is string => !!id));
    return { kind: "node", id: node.id, expectedVersion: current.toonflowGraph!.nodes[node.id] ?? 0, dependencies: Object.fromEntries([...parentIds].map(id => [id, current.toonflowGraph!.nodes[id] ?? 0])), value };
  }

  async function execute(request: CanvasRequest, command: BackendCommand, signal: AbortSignal) {
    await refresh();
    signal.throwIfAborted();
    if (isCanvasRead(request.name)) {
      if (!graph && request.name === "getCanvas") return { id: "unselected", canvasId: "unselected", nodeCount: 0, edgeCount: 0, selectedCount: 0, viewport: { x: 0, y: 0, zoom: 1 }, canvases: canvases.map(({ id, name }) => ({ id, name })), availableNodeTypes: descriptors.map(item => ({ type: `remote-${item.name}`, label: item.name })), hasMore: false, nextCursor: null };
      return queries(request, canvasPath, signal);
    }
    let step = 0;
    switch (request.name) {
      case "addCanvas": {
        let name = request.args.name;
        if (name && /[\\/:*?"<>|]/.test(name)) throw Object.assign(new Error("画布名称无效"), { status: 400 });
        if (!name) { let index = 1; do { name = `画布${index++}`; } while (canvases.some(item => item.id === `${name}.json`)); }
        const nextPath = `${name}.json`;
        const { path } = await resolveWorkspacePath(cwd, nextPath);
        await writeWorkspaceFile(path, JSON.stringify({ toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, null, 2), true);
        canvasPath = nextPath;
        options.onTargetChanged?.(canvasPath);
        appendWorkspaceEvent(cwd, "graphChanged", { path: canvasPath, created: true }, { commandId: command.commandId });
        await refresh();
        return queries({ name: "getCanvas", args: {} }, canvasPath, signal);
      }
      case "switchCanvas": {
        canvasPath = await resolveCanvas(cwd, { id: request.args.canvasId });
        options.onTargetChanged?.(canvasPath);
        await refresh();
        return queries({ name: "getCanvas", args: {} }, canvasPath, signal);
      }
      case "renameCanvas": {
        if (request.args.canvasId && request.args.canvasId !== canvasPath) throw Object.assign(new Error("目标画布已变化"), { status: 409 });
        const name = request.args.name;
        if (/[\\/:*?"<>|]/.test(name)) throw Object.assign(new Error("画布名称无效"), { status: 400 });
        const source = await resolveWorkspacePath(cwd, canvasPath);
        const nextPath = join(dirname(canvasPath), `${name}.json`).replaceAll("\\", "/");
        const destination = await resolveWorkspacePath(cwd, nextPath);
        await renameWorkspaceFile(source.path, destination.path);
        canvasPath = nextPath;
        options.onTargetChanged?.(canvasPath);
        appendWorkspaceEvent(cwd, "graphChanged", { path: canvasPath, renamedFrom: command.canvasPath }, { commandId: command.commandId });
        await refresh();
        return queries({ name: "getCanvas", args: {} }, canvasPath, signal);
      }
      case "addNode": {
        const type = request.args.type;
        const loaded = type === "canvasGroup" ? undefined : await loadNodeExecution(nodeType(type));
        const id = operationId(command.commandId, 0);
        const node = { id, type, position: request.args.position, data: { ...structuredClone(loaded?.definition.defaultData ?? {}), label: request.args.label ?? nodeType(type), handles: structuredClone(loaded?.definition.handles ?? []), outputs: {}, stateVersion: loaded?.definition.stateVersion ?? 1, executionRevision: loaded?.revision } };
        await apply([{ kind: "node", id, expectedVersion: 0, value: node }], command, ++step);
        if (loaded?.definition.initialize) await loaded.definition.initialize(await executionContext(id, loaded.revision, command, signal, () => ++step));
        return { node: snapshot(requireGraph(), requireNode(id)) };
      }
      case "renameNodes": {
        const changes = request.args.renames.map(item => { const node = requireNode(item.nodeId); return nodeChange(node, { ...node, data: { ...node.data, label: item.label } }); });
        await apply(changes, command, ++step);
        return { renamedCount: changes.length };
      }
      case "moveNodes": {
        const changes = request.args.moves.map(item => { const node = requireNode(item.nodeId); return nodeChange(node, { ...node, position: item.position }); });
        await apply(changes, command, ++step);
        return { movedCount: changes.length };
      }
      case "connectNodes": {
        const current = requireGraph();
        const changes: GraphChange[] = [];
        for (const [index, connection] of request.args.connections.entries()) {
          const source = requireNode(connection.source);
          const targetNode = requireNode(connection.target);
          const definition = (await loadNodeExecution(nodeType(targetNode.type ?? ""))).definition;
          if (definition.validateConnection && !definition.validateConnection({ source: snapshot(current, source), sourceHandle: connection.sourceHandle, target: snapshot(current, targetNode), targetHandle: connection.targetHandle })) throw Object.assign(new Error("节点连接业务校验失败"), { status: 400 });
          const id = operationId(command.commandId, index + 1);
          changes.push({ kind: "edge", id, expectedVersion: 0, dependencies: { [source.id]: current.toonflowGraph!.nodes[source.id]!, [targetNode.id]: current.toonflowGraph!.nodes[targetNode.id]! }, value: { id, ...connection } });
        }
        await apply(changes, command, ++step);
        return { connectedCount: changes.length };
      }
      case "deleteEdges": {
        const current = requireGraph();
        const changes = request.args.edgeIds.map(id => { const edge = current.edges.find(item => item.id === id); if (!edge) throw Object.assign(new Error("连接不存在"), { status: 404 }); return { kind: "edge" as const, id, expectedVersion: current.toonflowGraph!.edges[id]!, dependencies: { [edge.source]: current.toonflowGraph!.nodes[edge.source]!, [edge.target]: current.toonflowGraph!.nodes[edge.target]! }, value: null }; });
        await apply(changes, command, ++step);
        return { deletedCount: changes.length };
      }
      case "deleteNodes": {
        const current = requireGraph();
        const ids = new Set(request.args.nodeIds);
        for (const node of current.nodes) { let parent = node.parentNode; while (parent) { if (ids.has(parent)) { ids.add(node.id); break; } parent = current.nodes.find(item => item.id === parent)?.parentNode; } }
        const nodes = [...ids].map(requireNode);
        const changes: GraphChange[] = current.edges.filter(edge => ids.has(edge.source) || ids.has(edge.target)).map(edge => ({ kind: "edge", id: edge.id, expectedVersion: current.toonflowGraph!.edges[edge.id]!, dependencies: { [edge.source]: current.toonflowGraph!.nodes[edge.source]!, [edge.target]: current.toonflowGraph!.nodes[edge.target]! }, value: null }));
        changes.push(...nodes.map(node => nodeChange(node, null)));
        await apply(changes, command, ++step);
        // 成果与在途任务保留；remove hook 不依赖已卸载的 Vue 组件。
        for (const node of nodes) {
          if (node.type === "canvasGroup") continue;
          const loaded = await loadNodeExecution(nodeType(node.type ?? ""));
          if (loaded.definition.remove) await loaded.definition.remove(await executionContext(node.id, loaded.revision, command, signal, () => ++step, snapshot(current, node)));
        }
        return { deletedCount: nodes.length };
      }
      case "selectNodes": {
        request.args.nodeIds.forEach(requireNode);
        selected = new Set(request.args.nodeIds);
        appendWorkspaceEvent(cwd, "uiIntent", { name: "selectNodes", nodeIds: [...selected], clientId: options.clientId }, { commandId: command.commandId, canvasId: canvasPath });
        return { selectedCount: selected.size };
      }
      case "fitCanvas": {
        request.args.nodeIds?.forEach(requireNode);
        appendWorkspaceEvent(cwd, "uiIntent", { name: "fitCanvas", nodeIds: request.args.nodeIds, clientId: options.clientId }, { commandId: command.commandId, canvasId: canvasPath });
        return { fitted: false, queued: true, nodeCount: request.args.nodeIds?.length ?? requireGraph().nodes.length };
      }
      case "arrangeCanvas": {
        const changes = await arrangeGraph(requireGraph(), descriptors);
        if (changes.length) await apply(changes.map(({ nodeId, position }) => { const node = requireNode(nodeId); return nodeChange(node, { ...node, position }); }), command, ++step);
        return { arrangedCount: changes.length, arrangedNodeIds: changes.slice(0, 100).map(item => item.nodeId), truncated: changes.length > 100 };
      }
      case "nodeTools": {
        const node = requireNode(request.args.nodeId);
        const expected = command.expectedVersions?.[node.id];
        if (expected !== undefined && expected !== requireGraph().toonflowGraph!.nodes[node.id]) throw Object.assign(new Error("节点版本冲突，请保留草稿并刷新后重试"), { status: 409 });
        if (command.inputSnapshot && command.inputSnapshot.node.version !== requireGraph().toonflowGraph!.nodes[node.id]) throw Object.assign(new Error("目标节点在受理后已变化，请刷新后重试"), { status: 409 });
        const loaded = await loadNodeExecution(nodeType(node.type ?? ""), command.inputSnapshot?.revision ?? request.args.expectedNodeRevision);
        const action = loaded.definition.actions.find(item => `node:${item.name}` === request.args.name);
        if (!action) throw Object.assign(new Error("节点动作未注册，请重新查询"), { status: 404 });
        const args = await action.parameters.parseAsync(request.args.args);
        const result = await action.execute(args, await executionContext(node.id, loaded.revision, command, signal, () => ++step));
        await refresh();
        return result;
      }
      default: throw Object.assign(new Error("未知画布命令"), { status: 400 });
    }
  }

  async function executionContext(nodeId: string, revision: string, command: BackendCommand, signal: AbortSignal, nextStep: () => number, deleted?: NodeExecutionSnapshot): Promise<NodeExecutionContext> {
    const current = requireGraph();
    const frozen = command.inputSnapshot?.node.id === nodeId ? command.inputSnapshot : undefined;
    let node = deleted ?? frozen?.node ?? snapshot(current, requireNode(nodeId));
    const outputVersions = { ...current.toonflowGraph!.outputs };
    const metadata = await readNode(nodeType(node.type));
    function mediaForJob(jobId: string) {
      const local = getNodeJob(jobId);
      if (local && local.directory !== cwd) return;
      const mediaJobId = local ? getNodeJobRequest(jobId)?.input.mediaJobId : jobId;
      if (typeof mediaJobId !== "string") return;
      const media = getMediaJob(mediaJobId) ?? getMediaJobByIdempotency(cwd, mediaJobId);
      return media?.workspaceDirectory === cwd ? media : undefined;
    }
    const context: NodeExecutionContext = {
      directory: cwd, canvasPath, commandId: command.commandId, revision, get node() { return node; }, config: frozen?.config ?? getNodeConfig(metadata), signal,
      readText: path => frozen?.texts[path] ? Promise.resolve(frozen.texts[path]!) : readVersionedContent(cwd, path),
      async writeText(path, content, expectedRevision) {
        const before = expectedRevision ?? (await context.readText(path)).revision;
        const result = await writeVersionedContent({ directory: cwd, path, content, expectedRevision: before, commandId: `${command.commandId}:${nextStep()}` });
        if (frozen) frozen.texts[path] = { content, revision: result.revision, exists: true };
        return result;
      },
      async read(path) { return new Uint8Array(await readFile(frozen?.files[path] ? join(frozen.directory, frozen.files[path]!) : (await resolveWorkspacePath(cwd, path)).path)); },
      async write(path, content) {
        const resolved = await resolveWorkspacePath(cwd, path, true);
        await assertNoManagedGraph(resolved.path);
        assertNoManagedResource(cwd, path);
        await mkdir(dirname(resolved.path), { recursive: true });
        try { await writeWorkspaceFile(resolved.path, content, true); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !Buffer.from(await readFile(resolved.path)).equals(Buffer.from(content))) throw error; }
      },
      async patchData(data) {
        await refresh();
        const latest = requireNode(nodeId);
        if (requireGraph().toonflowGraph!.nodes[nodeId] !== node.version) throw Object.assign(new Error("节点已被其他操作修改"), { status: 409 });
        await apply([nodeChange(latest, { ...latest, data: { ...latest.data, ...data } })], { ...command, expectedVersions: undefined }, nextStep());
        node = snapshot(requireGraph(), requireNode(nodeId));
        return node;
      },
      async setOutput(slot, output) {
        const definition = (await loadNodeExecution(nodeType(node.type), revision)).definition;
        const handle = definition.handles.find(item => item.id === slot && item.type === "source");
        if (!handle || (output && !isTypeCompatible(output.dataType, handle.dataType))) throw Object.assign(new Error("输出槽位或类型不匹配"), { status: 400 });
        const key = JSON.stringify([nodeId, slot]);
        await apply([{ kind: "output", nodeId, slot, expectedVersion: outputVersions[key] ?? 0, value: output }], { ...command, expectedVersions: undefined }, nextStep());
        outputVersions[key] = requireGraph().toonflowGraph!.outputs[key]!;
        node = { ...node, data: { ...node.data, outputs: structuredClone(requireNode(nodeId).data?.outputs ?? {}) } };
      },
      async getInputs(handleId) {
        if (frozen) {
          if (!frozen.capturedInputs) throw new Error("此节点动作声明不读取输入，不能访问上游输入");
          return structuredClone(frozen.inputs[handleId] ?? []);
        }
        await refresh();
        return (await captureNodeInputs(cwd, canvasPath, requireGraph(), nodeId, revision)).inputs[handleId] ?? [];
      },
      async getModels(type) {
        if (type === "text") return listAiModels();
        return (await listMediaModels()).filter(model => model.type === type).map(model => ({ ...model, mode: z.array(z.union([z.string(), z.array(z.string())])).optional().safeParse(model.mode).data }));
      },
      async runJob(request) {
        const jobCommandId = `${command.commandId}:${nextStep()}`;
        let input: Record<string, unknown> = { ...request.input, commandId: jobCommandId, nodeId, canvasPath, nodeType: nodeType(node.type), pluginRevision: revision };
        if (request.kind === "text") {
          const parsed = z.object({ providerId: z.string().min(1), modelId: z.string().min(1), references: z.array(aiReferenceSchema).optional(), path: z.string().optional() }).parse(input);
          const references = await Promise.all((parsed.references ?? []).flatMap(reference => {
            if (reference.dataType === "STRING" || !frozen?.files[reference.value.url]) return [readAiReferences(cwd, [reference], signal).then(items => items[0]!)];
            return [readAiReferences(frozen.directory, [{ ...reference, value: { ...reference.value, url: frozen.files[reference.value.url]! } }], signal).then(items => items[0]!)];
          }));
          input = { ...input, referenceContents: references, configuredRevision: requestDigest(getConfiguredModel(parsed.providerId, parsed.modelId)), ...(parsed.path ? { expectedRevision: request.input.expectedRevision ?? (await context.readText(parsed.path)).revision } : {}) };
        } else if (request.kind === "media") {
          const mediaType = z.enum(["image", "video", "audio"]).parse(input.mediaType);
          const mediaRequest = (mediaType === "image" ? imageGenerationSchema : mediaType === "video" ? videoGenerationSchema : audioGenerationSchema).parse(input.request) as MediaGenerationRequest;
          const definition = (await loadNodeExecution(nodeType(node.type), revision)).definition;
          const slot = z.object({ outputSlot: z.string().optional() }).parse(input.binding ?? {}).outputSlot ?? definition.handles.find(handle => handle.type === "source" && isTypeCompatible(mediaType.toUpperCase(), handle.dataType))?.id;
          if (!slot) throw Object.assign(new Error("节点没有对应的媒体输出槽"), { status: 400 });
          const key = operationId(jobCommandId, 0);
          let mediaSnapshot: { directory: string; request: MediaGenerationRequest } | undefined;
          if (frozen) {
            const copyReference = async (item: MediaReference) => ({ ...item, path: await captureInputFile(frozen, cwd, item.path) });
            const copyReferences = async (items?: MediaReference[]) => {
              if (!items) return;
              const copies: MediaReference[] = [];
              for (const item of items) copies.push(await copyReference(item));
              return copies;
            };
            mediaSnapshot = { directory: frozen.directory, request: { ...mediaRequest, images: await copyReferences(mediaRequest.images), videos: await copyReferences(mediaRequest.videos), audios: await copyReferences(mediaRequest.audios), firstFrame: mediaRequest.firstFrame && await copyReference(mediaRequest.firstFrame), lastFrame: mediaRequest.lastFrame && await copyReference(mediaRequest.lastFrame) } };
          }
          await context.patchData({ generationJobId: null, pendingMediaJob: { idempotencyKey: key, outputSlot: slot, canvasPath, expectedNodeVersion: node.version + 1, startedAt: Date.now() } });
          try {
            const accepted = await acceptMediaJob({ cwd, mediaType, request: mediaRequest, idempotencyKey: key, binding: { canvasPath, nodeId, outputSlot: slot, expectedNodeVersion: node.version }, snapshot: mediaSnapshot });
            if (accepted.kind === "conflict") throw Object.assign(new Error("媒体命令已用于其他输入"), { status: 409 });
            input = { ...input, mediaJobId: accepted.job.jobId };
          } catch (error) {
            if (!getMediaJobByIdempotency(cwd, key)) {
              await refresh();
              const latest = requireNode(nodeId);
              if ((latest.data?.pendingMediaJob as { idempotencyKey?: unknown } | undefined)?.idempotencyKey === key) {
                await apply([nodeChange(latest, { ...latest, data: { ...latest.data, pendingMediaJob: null } })], { ...command, expectedVersions: undefined }, nextStep());
              }
            }
            throw error;
          }
        }
        const deferStart = request.kind === "text";
        const job = await acceptNodeJob({ directory: cwd, commandId: jobCommandId, request: { ...request, input, pluginRevision: revision, nodeId, canvasPath }, deferStart });
        try {
          if (request.kind === "text" || request.kind === "media") await context.patchData({ generationJobId: job.jobId });
        } catch (error) {
          if (deferStart) await cancelNodeJob(job.jobId);
          throw error;
        }
        return deferStart ? activateNodeJob(job.jobId) : job;
      },
      async getJob(jobId) { const job = getNodeJob(jobId); return job?.directory === cwd ? job : undefined; },
      async cancelJob(jobId) { if (getNodeJob(jobId)?.directory !== cwd) return; return cancelNodeJob(jobId); },
      async getMediaJob(jobId) { const media = mediaForJob(jobId); return media ? { ...media, files: media.files as never, errorMessage: media.errorMessage } : undefined; },
      async retryMediaCollection(jobId) {
        const media = mediaForJob(jobId);
        if (!media) throw Object.assign(new Error("媒体任务不存在"), { status: 404 });
        const retried = await retryMediaJobCollection(media.jobId, cwd);
        const job = await acceptNodeJob({ directory: cwd, commandId: `${command.commandId}:${nextStep()}`, request: { kind: "media", nodeId, canvasPath, pluginRevision: revision, input: { mediaJobId: media.jobId, nodeType: nodeType(node.type), pluginRevision: revision } } });
        await context.patchData({ generationJobId: job.jobId });
        return { ...retried, files: retried.files as never };
      },
      async waitForJob(jobId) { if (getNodeJob(jobId)?.directory !== cwd) throw Object.assign(new Error("任务不存在"), { status: 404 }); return waitForNodeJob(jobId, signal); },
    };
    return context;
  }

  async function call(input: { name: string; args: Record<string, unknown>; commandId?: string }, signal = new AbortController().signal) {
    const schema = canvasSchemas[input.name as keyof typeof canvasSchemas];
    if (!schema) throw Object.assign(new Error("未知画布命令"), { status: 400 });
    const request = { name: input.name, args: schema.parse(input.args) } as CanvasRequest;
    const command: BackendCommand = options.command ?? { commandId: input.commandId ?? crypto.randomUUID(), directory: cwd, canvasPath, name: input.name, args: request.args, clientContext: { clientId: contextId, selectedNodeIds: [...selected] } };
    if (options.command || isCanvasRead(request.name)) return execute(request, command, signal);
    const identity = structuredClone(command);
    const previous = getCanvasCommand(cwd, command.commandId);
    if (!previous && request.name === "nodeTools") { await refresh(); command.inputSnapshot = await captureNodeInputs(cwd, canvasPath, requireGraph(), request.args.nodeId, request.args.expectedNodeRevision, request.args.name); }
    if (!acceptCanvasCommand(command, identity)) {
      const existing = getCanvasCommand(cwd, command.commandId)!;
      if (existing.status === "completed") return existing.result;
      throw Object.assign(new Error(existing.errorMessage ?? "命令仍在执行或等待核对"), { status: 409 });
    }
    updateCanvasCommand(cwd, { commandId: command.commandId, status: "running" });
    try {
      const result = await execute(request, command, signal);
      updateCanvasCommand(cwd, { commandId: command.commandId, status: "completed", result });
      return result;
    } catch (error) {
      updateCanvasCommand(cwd, { commandId: command.commandId, status: signal.aborted ? "needsReview" : "failed", errorMessage: error instanceof Error ? error.message : "命令失败" });
      throw error;
    }
  }

  await refresh();
  return { get id() { return canvasPath || "unselected"; }, get canvasPath() { return canvasPath; }, get tools() { return nodeTools.tools; }, getNodeLabel: id => String(graph?.nodes.find(node => node.id === id)?.data?.label ?? id), call };
}

export async function submitCanvasCommand(raw: CanvasCommand) {
  const command = canvasCommandSchema.parse(raw) as BackendCommand;
  command.directory = await resolveWorkspace(command.directory);
  const schema = canvasSchemas[command.name as keyof typeof canvasSchemas];
  if (!schema) throw Object.assign(new Error("未知画布命令"), { status: 400 });
  command.args = schema.parse(command.args);
  const identity = structuredClone(command);
  if (!getCanvasCommand(command.directory, command.commandId) && command.name === "nodeTools") {
    command.canvasPath = await resolveCanvas(command.directory, { canvasPath: command.canvasPath || undefined });
    const { path } = await resolveWorkspacePath(command.directory, command.canvasPath);
    const args = canvasSchemas.nodeTools.parse(command.args);
    command.inputSnapshot = await captureNodeInputs(command.directory, command.canvasPath, await readGraph(path, command.directory), args.nodeId, args.expectedNodeRevision, args.name);
  }
  if (acceptCanvasCommand(command, identity)) startCommand(command);
  return getCanvasCommand(command.directory, command.commandId)!;
}

function startCommand(command: CanvasCommand) {
  const key = `${command.directory}\0${command.commandId}`;
  if (running.has(key)) return running.get(key)!;
  const promise = (async () => {
    updateCanvasCommand(command.directory, { commandId: command.commandId, status: "running" });
    try {
      const context = await createBackendCanvasContext(command.directory, { canvasPath: command.canvasPath || undefined, selectedNodeIds: command.clientContext?.selectedNodeIds }, { clientId: command.clientContext?.clientId, command });
      // 稳定命令标识传给原生执行入口，HTTP 生命周期不进入执行 signal。
      const result = await context.call({ name: command.name, args: command.args });
      const view: CanvasCommandResult = { commandId: command.commandId, status: "completed", result };
      updateCanvasCommand(command.directory, view);
      try { appendWorkspaceEvent(command.directory, "graphChanged", { command: view }, { commandId: command.commandId, canvasId: context.canvasPath }); }
      catch (error) { console.error("命令已完成，通知暂不可用，可按命令 ID 查询", error); }
      return view;
    } catch (error) {
      const view: CanvasCommandResult = { commandId: command.commandId, status: "failed", errorMessage: error instanceof Error ? error.message : "命令失败" };
      updateCanvasCommand(command.directory, view);
      try { appendWorkspaceEvent(command.directory, "graphChanged", { command: view }, { commandId: command.commandId }); }
      catch (notificationError) { console.error("命令状态已保存，通知暂不可用", notificationError); }
      return view;
    } finally { running.delete(key); }
  })();
  running.set(key, promise);
  void promise.catch(error => console.error("后台命令状态持久化失败，请核对命令", command.commandId, error));
  return promise;
}

export async function ensureCanvasCommandsReady() {
  if (recovered) return;
  for (const { command, status } of listIncompleteCanvasCommands()) {
    if (status === "accepted") startCommand(command);
    else updateCanvasCommand(command.directory, { commandId: command.commandId, status: "needsReview", errorMessage: "后端重启时命令已开始，请核对结果后继续" });
  }
  recovered = true;
}
