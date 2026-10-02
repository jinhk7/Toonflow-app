import { createStage, disposeStage, type SceneSettings } from "./scene";
import { applyCamera, prepareMotion, sampleMotion } from "./motion";
import { prepareSceneAnimation } from "./sceneAnimation";
import { renderJobSchema, type ParsedRenderJob } from "./renderJob";

let input: ParsedRenderJob;
let runtime: Awaited<ReturnType<typeof createStage>> | undefined;
let player: ReturnType<typeof prepareSceneAnimation> | undefined;
let cameraFrames: ReturnType<typeof prepareMotion> | undefined;

async function initialize(value: unknown) {
  input = renderJobSchema.parse(value);
  if (runtime) throw new Error("渲染 worker 已初始化");
  const settings: SceneSettings = input.settings ?? { gridVisible: true, skyVisible: true };
  runtime = await createStage(document.createElement("canvas"), input.scene, undefined, input.aspect, input.lighting, settings);
  runtime.renderer.setSize(input.width, input.height, false);
  runtime.camera.aspect = input.width / input.height;
  runtime.camera.updateProjectionMatrix();
  if (input.plan) {
    player = prepareSceneAnimation(runtime, input.plan);
    cameraFrames = prepareMotion(input.plan.cameraFrames);
  }
  const context = runtime.renderer.getContext();
  const debug = context.getExtension("WEBGL_debug_renderer_info");
  return {
    width: runtime.renderer.domElement.width, height: runtime.renderer.domElement.height,
    webglVersion: context.getParameter(context.VERSION),
    renderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER),
    browser: navigator.userAgent,
  };
}

function renderAt(time: number) {
  if (!runtime || runtime.renderer.getContext().isContextLost()) throw new Error("WebGL 渲染上下文不可用");
  player?.setTime(time);
  if (input.format === "image") applyCamera(runtime.camera, input.anchor!);
  else sampleMotion(runtime.camera, cameraFrames!, time);
  runtime.renderer.render(runtime.scene, runtime.camera);
  // 同一次调用中读回 drawing buffer，采样只依赖传入时间，不依赖可见性、RAF 或录制时钟。
  const png = runtime.renderer.domElement.toDataURL("image/png");
  if (!png.startsWith("data:image/png;base64,")) throw new Error("渲染帧读取失败");
  return png.slice("data:image/png;base64,".length);
}

function dispose() {
  player?.dispose();
  if (runtime) disposeStage(runtime);
  runtime = undefined;
  player = undefined;
  cameraFrames = undefined;
}

declare global {
  interface Window {
    toonflowRenderer: { initialize: typeof initialize; renderAt: typeof renderAt; dispose: typeof dispose };
  }
}
window.toonflowRenderer = { initialize, renderAt, dispose };
