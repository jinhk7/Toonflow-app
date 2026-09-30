import { Router } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", (req, res) => {
  res.json(success(u.ffmpeg.cancelDownload()));
});
