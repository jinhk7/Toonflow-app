import { lstat, readFile } from "node:fs/promises";
import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import conf from "@/utils/conf";
import { isWithin } from "@/utils/workspace/files";

const apply = Reflect.apply;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapClear = Map.prototype.clear;
const setHas = Set.prototype.has;

export const nodeNameSchema = z.string().max(96).regex(/^[a-z][a-zA-Z0-9]*$/);
export const nodesDirectory = resolve(dirname(conf.path), "nodes");
const configRulesSchema = z.array(z.record(z.string(), z.json())).max(100);
type ConfigRule = z.infer<typeof configRulesSchema>[number];

const builtinNodeTools = new Map([
  ["textNode", new Set(["node:setText"])],
  ["imageNode", new Set(["node:setImage"])],
  ["videoNode", new Set(["node:setVideo"])],
  ["audioNode", new Set(["node:setAudio"])],
  ["imageGenerationNode", new Set(["node:getConfig", "node:setConfig", "node:setPrompt", "node:getGenerationStatus"])],
  ["videoGenerationNode", new Set(["node:getConfig", "node:setConfig", "node:setPrompt", "node:getGenerationStatus"])],
]);
const builtinNodeHashes = new Map<string, string>();
const nodePackageLimit = 8 * 1024 * 1024;
const canvasTrustLimit = 16 * 1024 * 1024;
export type NodeToolContext = { cwd?: string; canvasPath?: string; nodeRevision?: string; builtinCanvasTool?: boolean };

function readTrustFile(root: string, path: string, limit: number) {
  if (isAbsolute(path) || !isWithin(root, resolve(root, path))) return;
  let file: number | undefined;
  try {
    const actual = realpathSync(resolve(root, path));
    if (!isWithin(root, actual)) return;
    file = openSync(actual, "r");
    const info = fstatSync(file);
    if (!info.isFile() || info.size < 1 || info.size > limit) return;
    const content = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(file, content, offset, content.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset === info.size) return content.subarray(0, offset);
  } catch {
    // 无法证明来源或文件在读取时改变，保留审批；不据此认定实际执行成功。
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

export function configureBuiltinNodes(nodesRoot?: string) {
  apply(mapClear, builtinNodeHashes, []);
  if (!nodesRoot) return;
  try {
    const root = realpathSync(nodesRoot);
    for (const file of readdirSync(root, { withFileTypes: true })) {
      if (!file.isFile() || !/^[a-z][a-zA-Z0-9]*\.umd\.js$/.test(file.name)) continue;
      const content = readTrustFile(root, file.name, nodePackageLimit);
      if (content) apply(mapSet, builtinNodeHashes, [file.name.slice(0, -7), createHash("sha256").update(content).digest("hex")]);
    }
  } catch { apply(mapClear, builtinNodeHashes, []); }
}

export function isBuiltinNodeTool(nodeId: unknown, name: string, context?: NodeToolContext) {
  if (typeof nodeId !== "string" || !nodeId || !context?.cwd || !context.canvasPath) return false;
  // ACT: 候选本地调用和审批快照同步读取，成本随画布及单包大小增长；超过 16/8 MiB 保留审批，后续可改为异步批量鉴权。
  try {
    const content = readTrustFile(realpathSync(context.cwd), context.canvasPath, canvasTrustLimit);
    if (!content) return false;
    const graph: unknown = JSON.parse(content.toString("utf8"));
    if (!graph || typeof graph !== "object" || !("toonflowCanvas" in graph) || graph.toonflowCanvas !== true
      || !("nodes" in graph) || !Array.isArray(graph.nodes)) return false;
    const targets = graph.nodes.filter(node => node && typeof node === "object" && node.id === nodeId);
    const graphType: unknown = targets.length === 1 ? targets[0].type : undefined;
    if (typeof graphType !== "string" || !graphType.startsWith("remote-")) return false;
    const type = graphType.slice("remote-".length);
    const tools = apply(mapGet, builtinNodeTools, [type]);
    if (!tools || !apply(setHas, tools, [name])) return false;
    const expected = apply(mapGet, builtinNodeHashes, [type]);
    if (!expected || context.nodeRevision !== expected) return false;
    const installed = readTrustFile(realpathSync(nodesDirectory), `${type}.umd.js`, nodePackageLimit);
    return !!installed && createHash("sha256").update(installed).digest("hex") === expected;
  } catch {
    return false;
  }
}

export async function readNode(name: string) {
  nodeNameSchema.parse(name);
  const path = resolve(nodesDirectory, `${name}.umd.js`);
  const file = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw Object.assign(error, { status: 404, message: "节点不存在" });
    throw error;
  });
  if (!file.isFile()) throw Object.assign(new Error("节点文件无效"), { status: 400 });
  // ACT: 当前整包读取元数据和计算版本，内存开销随节点总体积增长；包变大时改为流式计算版本并只读首行元数据。
  const content = await readFile(path);
  const source = content.toString("utf8");
  const revision = createHash("sha256").update(content).digest("hex");
  let metadata: Record<string, unknown> = {};
  try {
    const header = source.match(/^\/\*! toonflowNode:([^\r\n]*) \*\/(?:\r?\n|$)/)?.[1];
    const parsed = header ? JSON.parse(header) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {
    // 旧节点或损坏的元数据继续使用文件名，不执行节点脚本。
  }
  let github = "";
  if (typeof metadata.github === "string" && URL.canParse(metadata.github)) {
    const url = new URL(metadata.github);
    if (url.origin === "https://github.com" && !url.username && !url.password) github = url.href;
  }
  const rules = configRulesSchema.safeParse(metadata.configRules ?? []);
  if (!rules.success) throw Object.assign(new Error("节点配置表单规则无效，请重新构建节点"), { status: 400 });
  return {
    name,
    revision,
    builtin: revision === apply(mapGet, builtinNodeHashes, [name]),
    displayName: typeof metadata.displayName === "string" && metadata.displayName.trim() ? metadata.displayName : name,
    version: typeof metadata.version === "string" ? metadata.version.trim() : "",
    author: typeof metadata.author === "string" ? metadata.author : "",
    readme: typeof metadata.readme === "string" ? metadata.readme : "",
    github,
    configRules: rules.data,
  };
}

function declaredConfig(rules: ConfigRule[], config: Record<string, unknown>) {
  return Object.fromEntries(rules
    .filter(rule => typeof rule.field === "string" && rule.field.length > 0)
    .flatMap(rule => {
      const field = rule.field as string;
      const value = Object.hasOwn(config, field) ? config[field] : rule.value;
      return value === undefined ? [] : [[field, value]];
    }));
}

export function getNodeConfig(node: { name: string; configRules: ConfigRule[] }) {
  const configs = conf.get("nodeConfigs", {});
  return declaredConfig(node.configRules, Object.hasOwn(configs, node.name) ? configs[node.name]! : {});
}

export function validateNodeConfig(rules: ConfigRule[], config: Record<string, unknown>) {
  const parsed = declaredConfig(rules, config);
  for (const rule of rules) {
    const required = rule.required === true || (Array.isArray(rule.validate) && rule.validate.some(validation =>
      validation && typeof validation === "object" && !Array.isArray(validation) && validation.required === true));
    if (!required || typeof rule.field !== "string" || !rule.field) continue;
    const value = Object.hasOwn(parsed, rule.field) ? parsed[rule.field] : undefined;
    if (value == null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length)) {
      const label = typeof rule.title === "string" && rule.title.trim() ? rule.title : rule.field;
      throw Object.assign(new Error(`请填写${label}`), { status: 400 });
    }
  }
  return parsed;
}
