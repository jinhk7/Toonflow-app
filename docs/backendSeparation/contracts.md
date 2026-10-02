# 执行、命令和事件契约 v2

本文件和 packages/nodeScaffold/src/execution.ts 由核心集成负责人维护。其他工作包不得另定义 API；提出必要变化后由核心统一更新。

## API

- POST /api/workspaces/canvas/command：CanvasCommand；返回统一 success 包装内 CanvasCommandResult。服务端和 Agent 直接调用相同处理函数。
- GET /api/workspaces/canvas/command/get：directory、commandId；用于接受响应丢失后的对账。
- GET /api/workspaces/canvas/events：directory、afterSeq；application/x-ndjson，持久 WorkspaceEvent。断线不取消。
- GET /api/workspaces/canvas/content：directory、path；返回 content、revision。
- PUT /api/workspaces/canvas/content：directory、path、content、expectedRevision、commandId；CAS 写入，409 保留草稿。
- GET /api/nodes/get：保留原字段并增加 protocolVersion、executionRevision、stateVersion、handles、defaultData、actions、layoutSize、executionStatus。不可通过执行 Vue 获取这些数据。
- POST /api/agent/accept：保留 /api/agent 的原输入，增加 clientMessageId；返回 runId、sessionFile、重复受理标记，再订阅既有 /api/agent/events/get。
- GET /api/agent/accept/get：directory、clientMessageId；查询受理记录。
- GET /api/jobs/get、GET /api/jobs/list、POST /api/jobs/cancel、GET /api/jobs/events：持久本地节点/FFmpeg/渲染任务。既有媒体接口和账本保留，jobId 可关联其任务。

参数中的 directory 为服务端规范化的绝对项目目录，canvasPath/path 为项目内相对路径。客户端每次操作固定目录快照。commandId/clientMessageId 在重试时保持不变；同标识不同内容返回409。

CanvasCommand name 沿用现有 canvasOperations。nodeTools 参数沿用 nodeId/name/args/expectedNodeRevision。额外 node actions 仍从后端注册表发现，禁止节点名称能力白名单。expectedVersions 在图修改时对应现有节点/连线/输出版本。

查询快照提供 cursor，必须与返回内容同一逻辑边界。WorkspaceEvent 为 {seq,eventId,directory,commandId?,canvasId?,nodeId?,type,payload,createdAt}；type 包括 graphChanged/contentChanged/jobChanged/pluginsChanged/uiIntent。事件用于显示，不触发客户端执行。AgentEvent 协议继续沿用，移除对 canvasCall 客户端执行的依赖。

## 节点模块

每个节点新增 src/backend.ts，默认导出 NodeExecutionDefinition。同一构建产生 name.node.js（后端模块）与 name.umd.js（UI）。UI 元数据包含执行协议及配对 revision；安装/升级由核心处理，既有旧包保留。

NodeExecutionDefinition 提供 name/stateVersion/handles/defaultData/layoutSize/actions，以及可选 initialize/remove/migrate/validateConnection。actions 的 Zod schema 和实际 execute 来自服务器加载模块。后端私有来源证明记录真实 handler，客户端描述不包含函数。

NodeExecutionContext 绑定 directory/canvasPath/node/commandId/revision；提供 readText/writeText、patchData/setOutput、输入值解析、配置和持久 runJob。执行不得依赖 Vue、DOM、当前页面或浏览器本地状态。重计算通过 runJob，不长时间持有 Graph 锁。

## 作业与渲染

NodeJobRequest {kind,input,pluginRevision?,nodeId?,canvasPath?}。kind 按后端注册处理器发现，不限制节点名称。接受、执行、进度、产物提交和订阅分离。

渲染 worker 输入 RenderJobInput：scene、plan、anchor、lighting、settings、aspect、width、height、frameRate、time、duration、format（image/video）、assets。所有资产都是后端预先校验的任务快照引用。

worker 接口 execute(input,{signal,directory,reportProgress}) 返回 RenderJobResult {artifacts:[{path,mimeType}],metadata?}。directory 仅任务临时目录；worker 无权写图、正文、审批或会话。视频固定时间采样帧后交 FFmpeg，不使用实时 MediaRecorder。取消结束 worker/编码；在途远端作业以供应商能力为准。恢复复用输入，可安全重做临时产物，发布由核心按原 jobId/CAS 去重。

## 文件所有权

见 workPackages.md。任何契约变化先同步；不手工改自动生成 router.ts/components.d.ts。所有新文件 lowerCamelCase；禁止新增任何测试文件。
