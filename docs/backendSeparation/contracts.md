# 执行、命令和事件契约 v2

本文件和 packages/nodeScaffold/src/execution.ts 由核心集成负责人维护。其他工作包不得另定义 API；提出必要变化后由核心统一更新。

## API

- POST /api/workspaces/canvas/command：CanvasCommand；返回统一 success 包装内 CanvasCommandResult。服务端和 Agent 直接调用相同处理函数。
- GET /api/workspaces/canvas/command/get：directory、commandId；用于接受响应丢失后的对账。
- GET /api/workspaces/canvas/events：directory、afterSeq；application/x-ndjson，持久 WorkspaceEvent。断线不取消。
- GET /api/workspaces/canvas/content：directory、path；返回 content、revision、exists；区分缺失文件与已存在的空正文。
- PUT /api/workspaces/canvas/content/write：directory、path、content、expectedRevision、commandId；CAS 写入，409 保留草稿。读取/写入各一个路由文件，遵守仓库接口规范。
- GET /api/nodes/get：保留原字段并增加 protocolVersion、executionRevision、stateVersion、handles、defaultData、actions、layoutSize、executionStatus。不可通过执行 Vue 获取这些数据。
- POST /api/agent/accept：保留 /api/agent 的原输入，增加 clientMessageId；返回 runId、sessionFile、重复受理标记，再订阅既有 /api/agent/events/get。
- GET /api/agent/accept/get：directory、clientMessageId；查询受理记录。
- GET /api/jobs/get、GET /api/jobs/list、POST /api/jobs/cancel、GET /api/jobs/events：持久本地节点/FFmpeg/渲染任务。既有媒体接口和账本保留，jobId 可关联其任务。
- POST /api/jobs/resume：`{directory,jobId,confirmed:true}`；仅恢复处理器版本匹配、已完成绑定的任务：safe 任务，或处理器明确允许复用已有成果的 review 任务。保留原输入、commandId 和结果。只有 `canResume:true` 的 failed/needsReview 任务提供入口，不自动重提模型或供应商生成。
- POST /api/ai/explain：`{directory,commandId,message,context?}`；返回持久 text 作业，固定首次受理模型配置与解释输入，同命令重复请求返回原任务。
- POST /api/workspaces/canvas/modify：原 Graph 批量修改接口继续使用协议头 `X-Toonflow-Protocol: 2`；新增/删除的 lifecycle 在同一个持久 canvasModify 作业内执行。

参数中的 directory 为服务端规范化的绝对项目目录，canvasPath/path 为项目内相对路径。客户端每次操作固定目录快照。commandId/clientMessageId 在重试时保持不变；同标识不同内容返回409。

CanvasCommand name 沿用现有 canvasOperations。nodeTools 参数沿用 nodeId/name/args/expectedNodeRevision。额外 node actions 仍从后端注册表发现，禁止节点名称能力白名单。expectedVersions 在图修改时对应现有节点/连线/输出版本。

查询快照提供 cursor，必须与返回内容同一逻辑边界。WorkspaceEvent 为 {seq,eventId,directory,commandId?,canvasId?,nodeId?,type,payload,createdAt}；type 包括 graphChanged/contentChanged/jobChanged/pluginsChanged/uiIntent。事件用于显示，不触发客户端执行。AgentEvent 协议继续沿用，移除对 canvasCall 客户端执行的依赖。

子/孙会话的 eventCursor.runId 指向所属 root run，afterSeq 使用该 run 的全局序号；客户端过滤当前子会话内容，但推进所有收到事件的序号。完成会话继续返回游标，activeRun 仅在所属运行未完成时存在。父会话发起新运行不改变旧子会话归属。

审批范围包括实际节点输入快照、正文内容/版本和引用媒体摘要。消费授权与执行共用同一服务端快照，客户端不能注入。新工具调用消费原调用的授权时，仅原明确来源调用记为已替代并禁止重播；执行结果仍记录于实际调用，不批量结清同类待授权项。

## 节点模块

每个节点新增 src/backend.ts，默认导出 NodeExecutionDefinition。同一构建产生 name.node.js（后端模块）与 name.umd.js（UI）。UI 元数据包含执行协议及配对 revision；安装/升级由核心处理，既有旧包保留。

可选配套产物 name.render.js 的 SHA256 写入后端元数据 artifacts，因此执行 revision 同时固定渲染实现。安装时校验完整包并保留旧版；getNodeExecutionArtifact(name, executionRevision, fileName) 只返回该固定版本声明且校验通过的归档，不能借用新版本文件恢复旧任务。

NodeExecutionDefinition 提供 name/stateVersion/handles/defaultData/layoutSize/actions，以及可选 initialize/remove/migrate/validateConnection。actions 的 Zod schema 和实际 execute 来自服务器加载模块。后端私有来源证明记录真实 handler，客户端描述不包含函数。

可选 readOutputs(context) 返回后端从权威文件派生的输出，仅查询，不写状态。文本节点用此方法读取正文，保持 textPath/content.md 为唯一正文，不把全文重复写进 Graph。getInputs 由后端解析这些派生输出。UI不得自行构建权威输出。

NodeExecutionContext 绑定 directory/canvasPath/node/commandId/revision；提供 readText/writeText、patchData/setOutput、输入值解析、配置和持久 runJob。执行不得依赖 Vue、DOM、当前页面或浏览器本地状态。重计算通过 runJob，不长时间持有 Graph 锁。

受理时固定节点状态、配置、执行 revision、上游文本与媒体文件副本；getInputs 按 referenceOrder 排序。动作可显式声明 snapshotInputs:false，省去无需上游输入的状态查询/配置更新的素材复制；此声明不改变审批规则，并禁止该动作随后读取上游输入。

宿主 getModels 返回公开模型能力；getJob/cancelJob 面向持久节点作业。getMediaJob/retryMediaCollection 同时接受包装作业 ID、原媒体 ID 或本项目旧幂等键，复用原媒体任务。runJob 负责保存 generationJobId，media 负责 pendingMediaJob 与输出槽版本绑定，插件不得重复写入这些标记。重试收取不再次调用供应商生成。文本产物先保存到任务结果再 CAS 发布，正文冲突进入 needsReview 且保留文本。

文本任务先以 deferStart 持久受理，绑定 generationJobId 成功后 activateNodeJob；绑定失败取消尚未执行的任务。重启遗留的未激活任务进入 needsReview，不自动启动。媒体先复制引用再写 pending，受理失败且没有对应媒体台账时才按最新图版本清理匹配标记；已有台账则保留幂等键以便继续核对。

内置 job kind：text 输入 {providerId,modelId,prompt,systemPrompt?,references?,path?,expectedRevision?}，结果 {text,path?,revision?}；media 输入 {mediaType,request,binding?}，request 为既有 MediaGenerationRequest，结果 GeneratedMedia[]；render 使用下列渲染契约。nodeId/canvasPath/pluginRevision 使用外层 NodeJobRequest 固定，不相信客户端额外伪造目标。自定义任务按后端 handler 注册发现。

导演复制动作 getCopyData 在后端读取权威模型文件，返回 modelSnapshot 并清空路径和版本；副本初始化独立文件。撤销恢复优先保留该节点已经存在的有效文件，不用旧复制快照覆盖。canvasModify 固定新增/删除节点快照、revision、配置，逐 lifecycle 保存 completedLifecycle；失败保留原意图和任务供核对、显式恢复。

## 作业与渲染

NodeJobRequest {kind,input,pluginRevision?,nodeId?,canvasPath?,canvasId?}。节点宿主受理时覆盖 canvasId 为当前画布 UUID；查询、等待及取消同时校验目录、节点、路径和 UUID。同路径重建画布不能控制旧任务，已持久保存于旧输入或 host 的 UUID 仍可核对；没有 UUID 证明的旧绑定不能通过节点操作。kind 按后端注册处理器发现，不限制节点名称。接受、执行、进度、产物提交和订阅分离。

NodeJobView.summary 提供从固定输入抽取的展示信息（指令、格式、锚点等），不公开供应商密钥。beginCommit 只保护最终发布阶段；进入该阶段后取消返回当前运行状态，避免已写产物却报告取消。此前取消仍中止工作。媒体包装任务的取消仅停止观察，客户端仍查询原媒体任务，明确区分供应商状态与 observerStatus。

directorDraft 与 render 的持久输入为 `{payload,host}`：payload 是业务快照，host 固定命令、节点/画布版本、配置摘要、插件 revision、父分组版本，以及 AI 配置/引用或渲染 worker/输出节点 revision。directorDraft 为 review 恢复策略，render 为 safe。生成成果先写 checkpoint，再 CAS 发布；目标变化时进入 needsReview，保留结果，不覆盖后续编辑。

directorDraft 已保存 generated/contentPublished checkpoint 时可显式继续发布，不再调用模型；没有成果或处理器版本变化仍拒绝恢复。Graph 提交锁内校验全部声明的节点依赖。文本宿主在固定输入中持久保存 publication {path,nodeVersion}，nodeVersion 为绑定 generationJobId 后的节点版本；发布持 Graph 锁核对画布身份、执行版本、任务绑定及 publication，再完成正文 CAS。插件可使用 documentPath 或其他路径字段，不要求 textPath；节点在生成期间发生修改时保留成果供核对，不覆盖目标。旧任务缺少 publication 时不自动发布。

文本最终发布与普通 Graph 读取/修改共用每画布串行队列，避免后台快速完成导致受理命令返回前读图误报 EBUSY。队列仅协调已有工作，不吞掉版本冲突、非法数据或其他文件操作产生的错误；原命令始终通过持久回执对账，不因作业完成速度重复提交。

渲染 worker 输入 RenderJobInput：scene、plan、anchor、lighting、settings、aspect、width、height、frameRate、time、duration、format（image/video）、assets。所有资产都是后端预先校验的任务快照引用。

worker 接口 execute(input,{signal,directory,reportProgress}) 返回 RenderJobResult {artifacts:[{path,mimeType}],metadata?}。directory 仅任务临时目录；worker 无权写图、正文、审批或会话。视频固定时间采样帧后交 FFmpeg，不使用实时 MediaRecorder。取消结束 worker/编码；在途远端作业以供应商能力为准。恢复复用输入，可安全重做临时产物，发布由核心按原 jobId/CAS 去重。

## 文件所有权

见 workPackages.md。任何契约变化先同步；不手工改自动生成 router.ts/components.d.ts。所有新文件 lowerCamelCase；禁止新增任何测试文件。
