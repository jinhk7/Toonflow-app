import { z } from "zod";
import { anchorSchema, directorPlanSchema, sceneSchema } from "./document";

export const lightingSchema = z.strictObject({
  globalEnabled: z.boolean(), globalIntensity: z.number().min(0).max(100),
  sunEnabled: z.boolean(), azimuth: z.number().min(0).max(360), elevation: z.number().min(-90).max(90),
  color: z.string().regex(/^#[\da-f]{6}$/i), intensity: z.number().min(0).max(100),
});
export const sceneSettingsSchema = z.strictObject({ gridVisible: z.boolean(), skyVisible: z.boolean() });

export const renderJobSchema = z.strictObject({
  format: z.enum(["image", "video"]),
  scene: sceneSchema,
  plan: directorPlanSchema.optional(),
  anchor: anchorSchema.optional(),
  lighting: lightingSchema.optional(),
  settings: sceneSettingsSchema.optional(),
  aspect: z.number().min(0.1).max(10),
  width: z.number().int().min(2).max(4096),
  height: z.number().int().min(2).max(4096),
  frameRate: z.number().int().min(1).max(60),
  time: z.number().min(0).max(300).optional(),
  duration: z.number().min(0.2).max(300).optional(),
  // ACT: 当前导演台只支持几何体与内置人偶；不把未使用的素材变成浏览器网络或文件入口。
  assets: z.array(z.strictObject({ path: z.string(), mimeType: z.string() })).max(0).optional(),
}).superRefine((input, context) => {
  if (input.width * input.height > 4194304) context.addIssue({ code: "custom", path: ["width"], message: "渲染尺寸不能超过 4194304 像素" });
  if (Math.abs(input.width / input.height / input.aspect - 1) > 0.01) context.addIssue({ code: "custom", path: ["aspect"], message: "画面比例与尺寸不一致" });
  if (input.format === "image" && !input.anchor) context.addIssue({ code: "custom", path: ["anchor"], message: "图片渲染需要摄像机锚点" });
  if (input.format === "video") {
    if (!input.plan) context.addIssue({ code: "custom", path: ["plan"], message: "视频渲染需要动画方案" });
    if (input.width % 2 || input.height % 2) context.addIssue({ code: "custom", path: ["width"], message: "视频尺寸必须是偶数" });
  }
  if (input.plan) {
    if (input.duration !== undefined && input.duration > input.plan.duration) context.addIssue({ code: "custom", path: ["duration"], message: "导出时长不能超过方案时长" });
    if (input.time !== undefined && input.time > input.plan.duration) context.addIssue({ code: "custom", path: ["time"], message: "关键帧时间不能超过方案时长" });
    const objects = new Map(input.scene.objectList.map(object => [object.threeJsonId, object]));
    for (const [index, track] of input.plan.tracks.entries()) {
      const object = objects.get(track.objectId);
      if (!object || track.joint && object.objType !== "mannequin") context.addIssue({ code: "custom", path: ["plan", "tracks", index], message: "动画轨道引用的物体或关节无效" });
    }
  }
});
export type ParsedRenderJob = z.infer<typeof renderJobSchema>;

export function getRenderSize(aspect: number) {
  return { width: Math.round(960 * Math.min(1, aspect) / 2) * 2, height: Math.round(960 / Math.max(1, aspect) / 2) * 2 };
}
