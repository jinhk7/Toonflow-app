import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();
const maxBytes = 20 * 1024 * 1024;

export default router.post("/", validateFields({
  fileName: z.string().max(128).optional(),
  source: z.string().max(maxBytes).optional(),
  base64: z.string().max(Math.ceil(maxBytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional(),
  url: z.string().url().max(4096).optional(),
  force: z.boolean().optional(),
}), async (req, res) => {
  const { fileName, source, base64, url, force } = req.body as { fileName?: string; source?: string; base64?: string; url?: string; force?: boolean };
  if (url ? source !== undefined || base64 !== undefined : fileName === undefined || (source === undefined) === (base64 === undefined)) {
    return res.status(400).json(error("请选择文件或填写远端地址", null, 400));
  }

  const result = url
    ? await u.pluginInstall.installRemotePlugin("node", url, fileName, force)
    : await u.pluginInstall.installNode(fileName!, base64 === undefined ? source! : Buffer.from(base64, "base64"), force);
  res.json(success(result, "节点已安装"));
});
