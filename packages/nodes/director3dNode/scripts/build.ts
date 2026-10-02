import { build } from "bun";
import { resolve } from "node:path";
import * as vite from "vite";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "../../../build/nodes");
const result = await build({
  root, entrypoints: [resolve(root, "src/renderWorker.ts")], outdir: outDir,
  target: "browser", format: "esm", naming: "director3dNode.render.js",
  // ThreeJSON 的 sideEffects 元数据会裁剪 core 的延迟模块初始化，独立入口须保留它。
  ignoreDCEAnnotations: true,
});
if (!result.success) throw new AggregateError(result.logs, "导演台渲染入口构建失败");
await vite.build({ configFile: resolve(root, "vite.config.ts"), build: { outDir, emptyOutDir: false } });
