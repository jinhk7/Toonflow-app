import * as assets from "@/utils/assets";
import * as desktop from "@/utils/desktop";
import * as providerDebug from "@/utils/media/debug";
import * as mediaGeneration from "@/utils/media/generation";
import * as mediaProvider from "@/utils/media/provider";
import * as ffmpeg from "@/utils/ffmpeg";
import * as pluginInstall from "@/utils/plugins/install";
import conf, { removeLegacySettings } from "@/utils/conf";
import * as ai from "@/utils/ai";
import * as plugins from "@/utils/plugins/tools";
import * as nodePlugins from "@/utils/plugins/nodes";
import * as agent from "@/agent";
import * as canvas from "@/agent/bridge/canvas";
import * as question from "@/agent/bridge/question";
import * as workspace from "@/utils/workspace";
import * as workspaceFile from "@/utils/workspace/files";
import * as graph from "@/utils/workspace/graph";
import * as skillFile from "@/utils/skills/files";
import * as mcpControl from "@/utils/mcp/control";
import * as mcpRuntime from "@/utils/mcp/runtime";
import * as teams from "@/utils/teams";
import * as a2aSettings from "@/agent/a2a/settings";
import * as personalization from "@/utils/personalization";
import * as mentionFiles from "@/agent/mentionFiles";
import * as backendCanvas from "@/utils/canvas/context";
import * as canvasContent from "@/utils/canvas/content";
import * as canvasStore from "@/utils/canvas/store";
import * as canvasLifecycle from "@/utils/canvas/lifecycle";
import * as nodeExecution from "@/utils/plugins/nodeExecution";
import * as jobs from "@/utils/jobs";

export default {
  assets,
  desktop,
  providerDebug,
  mediaGeneration,
  mediaProvider,
  ffmpeg,
  pluginInstall,
  conf,
  removeLegacySettings,
  ai,
  plugins,
  nodePlugins,
  agent,
  canvas,
  question,
  workspace,
  workspaceFile,
  graph,
  skillFile,
  mcpControl,
  mcpRuntime,
  teams,
  a2aSettings,
  personalization,
  mentionFiles,
  backendCanvas,
  canvasContent,
  canvasStore,
  canvasLifecycle,
  nodeExecution,
  jobs,
};
