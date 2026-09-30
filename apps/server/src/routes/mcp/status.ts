import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

export default Router().get("/", (req, res) => {
  const runtime = u.mcpRuntime.getMcpRuntime();
  res.set("Cache-Control", "no-store").json(success({
    enabled: u.mcpControl.getMcpSettings().enabled,
    connections: u.mcpControl.listConnections(),
    ...runtime,
    endpoint: `${req.protocol}://${req.get("host")}/mcp`,
  }));
});
