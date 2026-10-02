import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import type { Rule } from "@form-create/element-ui";
import { z } from "zod";
import postcssConfig from "../../postcss.config.ts";

const executeFile = promisify(execFile);
const nodeCompiler = String.raw`
const watched = new Set();
const result = await Bun.build({
  entrypoints: [process.argv[1]],
  target: "bun",
  format: "esm",
  packages: "bundle",
  external: ["toonflow:node-zod"],
  minify: true,
  write: false,
  plugins: [{
    name: "nodeExecutionHost",
    setup(build) {
      build.onResolve({ filter: /^zod$/ }, () => ({ path: "zod", namespace: "nodeExecutionHost" }));
      build.onLoad({ filter: /^zod$/, namespace: "nodeExecutionHost" }, () => ({ contents: 'module.exports = require("toonflow:node-zod");', loader: "js" }));
      build.onResolve({ filter: /^(?:vue(?:\/|$)|@vue\/|@vue-flow\/|element-plus(?:\/|$))|\.vue$/ }, ({ path }) => {
        throw new Error("节点后端不能依赖 Vue 或界面模块：" + path);
      });
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => { watched.add(path); });
    },
  }],
});
if (!result.success || result.outputs.length !== 1) throw new AggregateError(result.logs, "节点后端必须构建为单一模块");
process.stdout.write(JSON.stringify({ code: await result.outputs[0].text(), watched: [...watched] }));
`;

export interface NodeConfig {
  name: string;
  displayName: string;
  author: string;
  github: string;
  configRules?: Rule[];
}

export function createNodeConfig(config: NodeConfig, configUrl: string) {
  const { name: nodeName } = config;
  const metadata = {
    displayName: config.displayName.trim(),
    author: config.author.trim(),
    github: config.github.trim(),
    configRules: z.array(z.record(z.string(), z.json())).max(100).parse(config.configRules ?? []),
  };
  if (!metadata.displayName) throw new Error("插件显示名不能为空");
  if (metadata.github) {
    const githubUrl = new URL(metadata.github);
    if (githubUrl.origin !== "https://github.com" || githubUrl.username || githubUrl.password) throw new Error("GitHub 地址必须是 https://github.com 下的地址");
  }
  const root = fileURLToPath(new URL(".", configUrl));
  if (!/^[a-z][a-zA-Z0-9]*$/.test(nodeName)) throw new Error(`节点名必须使用小驼峰：${nodeName}`);
  const fileName = `${nodeName}.umd.js`;
  const backendFileName = `${nodeName}.node.js`;
  let backendSource: string | undefined;
  const outDir = fileURLToPath(new URL("../../build/nodes", import.meta.url));
  const dataDir = fileURLToPath(new URL("../../data/nodes", import.meta.url));
  let syncToData = process.env.NODE_ENV === "dev";

  return defineConfig({
    root,
    css: { postcss: postcssConfig },
    plugins: [
      vue(),
      {
        name: "syncNodeFile",
        configResolved(resolvedConfig) {
          syncToData ||= Boolean(resolvedConfig.build.watch) || resolvedConfig.mode === "development";
        },
        async generateBundle(_options, bundle) {
          const chunk = bundle[fileName];
          if (!chunk || chunk.type !== "chunk") throw new Error(`未生成节点文件：${fileName}`);
          const packagePath = resolve(root, "package.json");
          this.addWatchFile(packagePath);
          const packageInfo = JSON.parse(await readFile(packagePath, "utf8"));
          const version = typeof packageInfo.version === "string" ? packageInfo.version.trim() : "";
          if (!version) throw new Error(`节点 package.json 缺少有效的 version：${nodeName}`);
          const readmePath = resolve(root, "readme.md");
          this.addWatchFile(readmePath);
          const readme = await readFile(readmePath, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          });
          const backendPath = resolve(root, "src/backend.ts");
          const backendEntry = await readFile(backendPath, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          backendSource = undefined;
          if (backendEntry !== undefined) {
            this.addWatchFile(backendPath);
            // Vite 可由 Node 或 Bun 启动；独立 Bun 编译器不要求节点作者改构建脚本。
            const compiler = process.versions.bun ? process.execPath : process.platform === "win32" ? "bun.exe" : "bun";
            const result = await executeFile(compiler, ["-e", nodeCompiler, backendPath], { cwd: root, windowsHide: true, maxBuffer: 40 * 1024 * 1024 });
            const backend = JSON.parse(result.stdout) as { code: string; watched: string[] };
            for (const path of backend.watched) this.addWatchFile(path);
            const backendMetadata = { name: nodeName, protocolVersion: 2, version };
            backendSource = `/*! toonflowNodeExecution:${JSON.stringify(backendMetadata).replaceAll("/", "\\u002f")} */\n${backend.code}`;
            this.emitFile({ type: "asset", fileName: backendFileName, source: backendSource });
          }
          const execution = backendSource === undefined ? {} : {
            protocolVersion: 2,
            executionRevision: createHash("sha256").update(backendSource).digest("hex"),
          };
          // 压缩后再写入，防止元数据注释被移除。
          chunk.code = `/*! toonflowNode:${JSON.stringify({ ...metadata, version, readme, ...execution }).replaceAll("/", "\\u002f")} */\n${chunk.code}`;
        },
        async writeBundle() {
          if (!syncToData) return;
          await mkdir(dataDir, { recursive: true });
          if (backendSource !== undefined) {
            const backendTargetPath = resolve(dataDir, backendFileName);
            const backendTempPath = `${backendTargetPath}.${crypto.randomUUID()}.tmp`;
            try {
              await copyFile(resolve(outDir, backendFileName), backendTempPath);
              await rename(backendTempPath, backendTargetPath);
            } finally { await rm(backendTempPath, { force: true }); }
          }
          const targetPath = resolve(dataDir, fileName);
          const tempPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
          try {
            await copyFile(resolve(outDir, fileName), tempPath);
            await rename(tempPath, targetPath);
          } finally {
            await rm(tempPath, { force: true });
          }
        },
      },
    ],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir,
      // ACT: 单包构建不清公共产物目录，由根 build:nodes 在批量构建前统一清理。
      emptyOutDir: false,
      cssCodeSplit: true,
      lib: {
        entry: resolve(root, "src/index.vue"),
        name: `toonflowNodes.${nodeName}`,
        formats: ["umd"],
        fileName: () => fileName,
      },
      rolldownOptions: {
        external: ["vue", "@vue/runtime-core", "@vue/runtime-dom", "@vue-flow/core", "element-plus", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai"],
        output: {
          exports: "default",
          globals: {
            vue: "toonflowNodeHost.vue",
            "@vue/runtime-core": "toonflowNodeHost.vue",
            "@vue/runtime-dom": "toonflowNodeHost.vue",
            "@vue-flow/core": "toonflowNodeHost.vueFlow",
            "element-plus": "toonflowNodeHost.elementPlus",
            "@earendil-works/pi-agent-core": "toonflowNodeHost.ai",
            "@earendil-works/pi-ai": "toonflowNodeHost.ai",
          },
        },
      },
    },
  });
}
