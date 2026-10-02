import type { z } from "zod";
import type { NodeHandle } from "./connection";
import type { NodeInputValue, NodeOutput, NodeOutputs } from "./values";
import type { NodeAiModel, NodeMediaModel, NodeMediaJobView } from "./nodeAi";

export type CanvasCommand = {
  commandId: string;
  directory: string;
  canvasPath: string;
  name: string;
  args: Record<string, unknown>;
  expectedVersions?: Record<string, number>;
  clientContext?: { clientId: string; selectedNodeIds?: string[] };
};

export type CanvasCommandResult = {
  commandId: string;
  status: "accepted" | "running" | "completed" | "failed" | "needsReview";
  graphRevision?: number;
  result?: unknown;
  jobId?: string;
  errorMessage?: string;
};

export type WorkspaceEvent = {
  seq: number;
  eventId: string;
  directory: string;
  commandId?: string;
  canvasId?: string;
  nodeId?: string;
  type: "graphChanged" | "contentChanged" | "jobChanged" | "pluginsChanged" | "uiIntent";
  payload: Record<string, unknown>;
  createdAt: string;
};

export type NodeExecutionSnapshot = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  parentNode?: string;
  version: number;
};

export type NodeJobRequest = {
  kind: string;
  input: Record<string, unknown>;
  pluginRevision?: string;
  nodeId?: string;
  canvasPath?: string;
};

export type NodeJobView = {
  jobId: string;
  commandId: string;
  directory: string;
  kind: string;
  nodeId?: string;
  canvasPath?: string;
  status: "accepted" | "running" | "completed" | "failed" | "cancelled" | "needsReview";
  progress?: number;
  result?: unknown;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type NodeExecutionContext = {
  directory: string;
  canvasPath: string;
  commandId: string;
  revision: string;
  node: NodeExecutionSnapshot;
  config: Record<string, unknown>;
  signal: AbortSignal;
  readText(path: string): Promise<{ content: string; revision: string; exists?: boolean }>;
  writeText(path: string, content: string, expectedRevision?: string): Promise<{ revision: string }>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, content: Uint8Array): Promise<void>;
  patchData(data: Record<string, unknown>): Promise<NodeExecutionSnapshot>;
  setOutput(slot: string, output: NodeOutput | null): Promise<void>;
  getInputs(handleId: string): Promise<NodeInputValue[]>;
  getModels(type: "text" | "image" | "video" | "audio"): Promise<(NodeAiModel | NodeMediaModel)[]>;
  runJob(request: NodeJobRequest): Promise<NodeJobView>;
  getJob(jobId: string): Promise<NodeJobView | undefined>;
  cancelJob(jobId: string): Promise<NodeJobView | undefined>;
  getMediaJob(jobId: string): Promise<NodeMediaJobView | undefined>;
  retryMediaCollection(jobId: string): Promise<NodeMediaJobView>;
  waitForJob(jobId: string): Promise<unknown>;
};

export type NodeExecutionAction<Schema extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  snapshotInputs?: boolean;
  parameters: Schema;
  execute(args: z.output<Schema>, context: NodeExecutionContext): unknown | Promise<unknown>;
};

export type NodeExecutionDefinition = {
  protocolVersion: 2;
  name: string;
  stateVersion: number;
  handles: NodeHandle[];
  defaultData: Record<string, unknown>;
  layoutSize: { width: number; height: number };
  actions: NodeExecutionAction[];
  readOutputs?(context: NodeExecutionContext): Promise<NodeOutputs>;
  initialize?(context: NodeExecutionContext): Promise<void>;
  remove?(context: NodeExecutionContext): Promise<void>;
  migrate?(data: Record<string, unknown>, fromVersion: number): Record<string, unknown> | Promise<Record<string, unknown>>;
  validateConnection?(request: { source: NodeExecutionSnapshot; sourceHandle: string; target: NodeExecutionSnapshot; targetHandle: string; nodes?: NodeExecutionSnapshot[]; edges?: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }[] }): boolean;
};

export type NodeExecutionDescriptor = {
  protocolVersion: 2;
  name: string;
  executionRevision: string;
  stateVersion: number;
  handles: NodeHandle[];
  defaultData: Record<string, unknown>;
  layoutSize: { width: number; height: number };
  actions: { name: string; description: string; parameters: Record<string, unknown> }[];
};

export type RenderJobInput = {
  format: "image" | "video";
  scene: unknown;
  plan?: unknown;
  anchor?: unknown;
  lighting?: unknown;
  settings?: unknown;
  aspect: number;
  width: number;
  height: number;
  frameRate: number;
  time?: number;
  duration?: number;
  assets?: { path: string; mimeType: string }[];
};

export type RenderJobResult = {
  artifacts: { path: string; mimeType: string }[];
  metadata?: Record<string, unknown>;
};

export type RenderJobContext = {
  directory: string;
  signal: AbortSignal;
  reportProgress(progress: number): void;
};
