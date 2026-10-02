import { Router } from "express";
import { Artifact, createTeamAgentCard, createTeamA2aRouter, type TeamA2aRequest } from "@toonflow/teams-scaffold/a2a";
import { teamNameSchema } from "@toonflow/teams-scaffold/runtime";
import { createAgentModel, getAgentModelRevision } from "@/agent/runtime/model";
import { createAgentTools } from "@/agent/tools";
import { createTeamRunner } from "@/agent/teams";
import { readTeam } from "@/utils/teams";
import { createBackendCanvasContext } from "@/utils/canvas/context";
import { controlAgentRun, ensureAgentRuntimeReady, runPersistentAgentTask } from "@/agent/runtime/runHost";
import { getAgentRun, insertAgentRun, listPendingAuthorizations, hasPendingSideEffectReview, updateAgentRun } from "@/agent/runtime/store";
import { authenticateA2a, getA2aSettings, getA2aSignal, getA2aUrl, resolveA2aWorkspace } from "./settings";

export function createA2aRouter() {
  const router = Router();
  const endpoints = new Map<string, { router: Router; card: ReturnType<typeof createTeamAgentCard>; signal: AbortSignal }>();
  router.use("/:name", async (req, res, next) => {
    try {
      if (!getA2aSettings().enabled) { res.sendStatus(404); return; }
      const name = teamNameSchema.parse(req.params.name);
      const configurationSignal = getA2aSignal();
      let endpoint = endpoints.get(name);
      // 已接收任务的查询和取消继续交给 SDK；禁用/卸载只阻止 execute 接收新消息。
      if (endpoint?.signal === configurationSignal && req.method === "POST") { endpoint.router(req, res, next); return; }
      const team = await readTeam(name);
      if (!team.enabled) { res.sendStatus(404); return; }
      const card = createTeamAgentCard(team.manifest, `${getA2aUrl(req)}/${name}`);
      if (!endpoint || endpoint.signal !== configurationSignal) {
        // ACT: SDK 协议上下文仍在内存，重启需新建 A2A task；输入、执行、副作用和事件账本持续保留供核对。
        const pending = new Map<string, { runner?: Awaited<ReturnType<typeof createTeamRunner>>; userId: string; runId: string }>();
        const execute = async (request: TeamA2aRequest) => {
          try {
            const signal = AbortSignal.any([request.signal, configurationSignal]);
            signal.throwIfAborted();
            if (!(await readTeam(name)).enabled) throw new Error("团队已禁用，不能接收新消息");
            if (request.message.parts.some(part => part.content?.$case !== "text")) throw new Error("此团队入口只接受文本，不下载远端附件；请在文本中提供已授权工作区的相对路径");
            const task = request.message.parts.map(part => part.content?.$case === "text" ? part.content.value : "").join("\n").trim();
            if (!task || task.length > 24000) throw new Error("团队任务文本应为 1 到 24000 字符");
            let current = pending.get(request.taskId);
            if (current && current.userId !== request.userId) throw new Error("任务不属于当前调用方");
            if (request.task && !current) throw new Error("任务上下文已释放，请创建新任务");
            if (!current) {
              const settings = getA2aSettings();
              const cwd = await resolveA2aWorkspace();
              // 保存时已规范化目录；不允许运行前把该目录替换成指向其他位置的链接。
              if (cwd !== settings.directory) throw new Error("A2A 工作目录已变化，请在设置中重新授权");
              await ensureAgentRuntimeReady();
              const runId = crypto.randomUUID();
              insertAgentRun({ runId, cwd, sessionFile: null, status: "preparing", intent: "active", providerId: settings.providerId,
                modelId: settings.modelId, thinkingLevel: settings.thinkingLevel,
                inputJson: JSON.stringify({ source: "a2a", taskId: request.taskId, team: name, userId: request.userId, messages: [], modelRevision: getAgentModelRevision(settings.providerId, settings.modelId) }) });
              current = { userId: request.userId, runId };
              pending.set(request.taskId, current);
            }
            const activeTask = current;
            const record = getAgentRun(current.runId);
            if (!record || record.intent === "terminate" || record.status === "completed") throw Object.assign(new Error("任务已结束，请创建新任务"), { status: 409 });
            const saved = JSON.parse(record.inputJson) as { messages: string[]; canvas?: { canvasPath: string }; modelRevision?: string };
            saved.messages.push(task);
            updateAgentRun(current.runId, { inputJson: JSON.stringify(saved) });
            const result = await runPersistentAgentTask(current.runId, async (send, control) => {
              if (!activeTask.runner) {
                const { runtime } = await createAgentModel(record.providerId, record.modelId, record.thinkingLevel, saved.modelRevision);
                const canvas = await createBackendCanvasContext(record.cwd, saved.canvas, { runId: record.runId,
                  onTargetChanged: canvasPath => {
                    const input = JSON.parse(getAgentRun(record.runId)!.inputJson) as Record<string, unknown>;
                    input.canvas = canvasPath ? { canvasPath } : undefined;
                    updateAgentRun(record.runId, { inputJson: JSON.stringify(input) });
                  } });
                saved.canvas = canvas.canvasPath ? { canvasPath: canvas.canvasPath } : undefined;
                updateAgentRun(record.runId, { inputJson: JSON.stringify(saved) });
                const tools = await createAgentTools(record.cwd, canvas);
                activeTask.runner = await createTeamRunner({ name, cwd: record.cwd, tools, canvas, modelRuntime: runtime,
                  model: runtime.getModel(record.providerId, record.modelId), thinkingLevel: record.thinkingLevel as "off" | "low" | "medium" | "high",
                  guardContext: { runId: record.runId, runControl: control, canvasAttached: true, cwd: record.cwd, canvasPath: canvas.canvasPath,
                    canvas, toolScope: `a2a:${request.taskId}` } });
              }
              const output = await activeTask.runner.run(task, AbortSignal.any([signal, control.signal]), text => {
                send({ type: "text", blockId: "a2aProgress", content: text });
                request.emit({ type: "status", text });
              }, true);
              if (output.result.status === "inputRequired" || listPendingAuthorizations(record.runId).length || hasPendingSideEffectReview(record.runId)) {
                updateAgentRun(record.runId, { status: "paused", errorMessage: "等待补充输入、授权或步骤核对" });
                return { ...output.result, status: "inputRequired" as const };
              }
              if (output.result.status !== "completed") throw new Error(output.result.result || "团队未完成任务");
              return output.result;
            });
            signal.throwIfAborted();
            if (result.status === "inputRequired") return { status: "inputRequired" as const, text: result.result };
            pending.delete(request.taskId);
            if (result.status !== "completed") throw new Error(result.result || "团队未完成任务");
            return { status: "completed" as const, text: result.result, artifacts: [Artifact.fromJSON({
              artifactId: request.taskId, name: "团队结果", parts: [{ text: result.result, mediaType: "text/plain" }],
            })] };
          } catch (error) { pending.delete(request.taskId); throw error; }
        };
        endpoint = { card, signal: configurationSignal, router: createTeamA2aRouter({
          card, authenticate: authenticateA2a, execute,
          onCancel: taskId => {
            const current = pending.get(taskId);
            if (current) void controlAgentRun(current.runId, "terminate");
            pending.delete(taskId);
          },
        }) };
        endpoints.set(name, endpoint);
        configurationSignal.addEventListener("abort", () => { pending.clear(); endpoints.delete(name); }, { once: true });
      } else Object.assign(endpoint.card, card);
      endpoint.router(req, res, next);
    } catch (error) { next(error); }
  });
  return router;
}
