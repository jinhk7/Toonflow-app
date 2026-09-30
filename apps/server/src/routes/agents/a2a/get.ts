import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

export default Router().get("/", (req, res) => {
  const settings = u.a2aSettings.getA2aSettings();
  res.set("Cache-Control", "no-store").json(success({ ...settings, token: settings.token || undefined, url: u.a2aSettings.getA2aUrl(req) }));
});
