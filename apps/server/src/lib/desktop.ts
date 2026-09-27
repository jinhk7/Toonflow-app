import type { Request, Response, NextFunction } from "express";
import { error } from "@/lib/responseFormat";

export default function desktopRequest(req: Request, res: Response, next: NextFunction) {
  if (!req.app.locals.desktop) return res.status(404).json(error("此接口仅在桌面客户端中可用", null, 404));
  next();
}
