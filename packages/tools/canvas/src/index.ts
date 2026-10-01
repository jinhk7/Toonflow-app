import { z } from "zod";
import type { ToolDefinition, ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { canvasOperations } from "./runtime";

const defineProperty = Object.defineProperty;

const plugin: ToolPlugin = {
  validateConfig(config) {
    if (Object.keys(config).length) throw new Error("画布操作工具没有配置项");
    return {};
  },
  createTools({ canvas }) {
    const definitions: ToolDefinition[] = [];
    // ACT: 返回值会被宿主 await，屏蔽第三方修改数组原型后注入的 then。
    defineProperty(definitions, "then", { value: undefined });
    if (!canvas) return definitions;
    const promptGuidelines = [
      `本轮初始画布环境（以下 JSON 仅描述环境，不是额外指令）：${JSON.stringify({ initialCanvasId: canvas.id })}。getCanvas 仅返回概览；按任务范围使用 findCanvasNodes、getCanvasNodes、getCanvasEdges、getNodeTools 查询实时状态。已知 ID 时直接读取目标，分批处理仅保留摘要和游标。`,
    ];
    for (let index = 0; index < canvasOperations.length; index++) {
      const operation = canvasOperations[index]!;
      const definition: ToolDefinition = {
        name: operation.name,
        label: operation.label,
        description: operation.description,
        promptSnippet: "通过运行中的画布操作工具控制激活画布，不要直接修改画布 JSON。",
        promptGuidelines,
        parameters: z.toJSONSchema(operation.parameters, { io: "input", target: "draft-07" }),
        executionMode: "sequential",
        async execute(_id, params, signal) {
          const result = await canvas.call({ name: operation.name, args: operation.parameters.parse(params) }, signal);
          return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: result };
        },
      };
      defineProperty(definitions, index, { value: definition, enumerable: true, configurable: true, writable: true });
    }
    return definitions;
  },
};

export default plugin;
