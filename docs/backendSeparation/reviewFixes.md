# a94a990 独立审查修复记录

本轮对应审查线程 `01a0fc24-8ca1-77d4-92bd-6a8d3e4360e6`。审查基线为 `a94a990`；原生产工作区只读，修复与验证均在隔离工作树和临时数据目录内完成。此记录用于再次独立复审，不代表已经验收。

## 后端与导演

| 审查项 | 修复 | 回归证据 |
| --- | --- | --- |
| 1 审批与执行正文不一致 | 审批纳入实际节点输入、正文版本/内容、引用素材摘要；服务端私有快照在执行时复用 | 真实官方工具/节点与 native context：相同内容摘要稳定，正文 CAS 使旧授权失效且不扣预算；消费后再改正文/媒体，实际动作仍读取快照旧值 |
| 2 新调用消费授权后旧调用悬挂 | 授权记录原调用 ID；消费事务仅结清明确来源，记录替代调用，不伪报成功 | A 待授权→批准→B 完成后 run 完成；B 失败仍 needsReview；旧 A/B 不重播；其他独立待调用保持；有限预算及旧授权多候选拒绝 |
| 3 同路径重建画布复用初始化命令 | 初始化命令使用持久画布身份，写入意图先保存身份，恢复继续原身份 | A→B→新 A；accepted 写入前/后、written 通知前与旧日志恢复；新进程恢复，事件不重复 |
| 4 导演提交后清空指令导致自身版本冲突 | 保留指令，受理后不再自动写偏好 | 执行 Vue 中真实 generate 函数，确认仅受理前 flush，无受理后自动偏好写入 |
| 5 分组草稿遗漏父组依赖、半提交无法继续 | 补固定父组依赖；已有生成 checkpoint 的审核型任务允许显式继续发布，未生成成果仍禁止恢复模型调用 | 分组发布成功；正文先提交后继续原任务；后续正文编辑保留；缺 checkpoint 拒绝；新进程复用 Graph 回执不重复发布 |
| 8 独立 Server 的旧 initialized 跳过节点迁移 | 完整官方 UI/backend/sidecar 配对升级、保留旧包及执行归档；持久升级意图在启动时恢复 | 七个真实构建节点冷启动迁移、重复初始化、损坏源拒绝通过；真实 UMD/marker 文件锁故障完整回滚；切换单成员后终止进程，下一进程恢复旧包，再次启动升级成功；配置与非官方包保留 |
| 9 副本文本继承并控制原任务 | 后端复制快照清除绑定；查询、等待、取消和媒体收取按节点及画布归属校验；前端复制仍先检查未保存内容 | 官方文本独立复制、取消来源被拒；同 ID 撤销保留自己的任务、跨画布同 ID 拒绝；媒体副本查询/取消/收取拒绝；挂载组件的脏正文检查和未挂载后台复制均通过 |
| 11 删除文本目标后仍发布正文 | 固定画布/节点/任务身份，持 Graph 锁检查目标并完成正文 CAS；失效保留成果 | 替代流验证删除、换绑定、重建画布时 needsReview，原正文不变且 result.md/作业成果保留；正常发布成功；CAS 期间删除获 EBUSY 409 |
| 12 Graph 忽略额外声明依赖 | 最终提交锁内校验所有声明依赖，并保留父组/边端点必需依赖 | 错误版本与排队期间失效均 409，文件/通知/写入意图不变；正确版本成功；缺必需依赖仍拒绝 |

导演验证使用已有审查数据的只读副本与持久生成 checkpoint，不配置模型、不发起生成请求。证据：`C:\Users\jinhk\AppData\Local\Temp\toonflowDirectorReviewEmZ8ZB\evidence.json`。七节点升级集成证据：`C:\Users\jinhk\AppData\Local\Temp\toonflowUpgradeIntegratedhbc9yH\evidence.json`。

Graph 项 3/12 证据：`C:\Users\jinhk\AppData\Local\Temp\toonflowGraphReviewAfterEjSdzu\evidence.json`，保留修复前复现与三个数据 fixture；15 场景、49 条断言通过。

审批项 1/2 证据分别为 `C:\Users\jinhk\AppData\Local\Temp\toonflowOfficialSnapshotFixturep4evNs\evidence.json`、`C:\Users\jinhk\AppData\Local\Temp\toonflowApprovalFixtureCrzD7T\evidence.json`，包含实际持久输入及源码/官方构建产物 SHA256。冻结范围为已声明并捕获的输入，不覆盖第三方插件自行读取的任意文件。验证中误写过两组临时测试专用封装，发现不符合仓库规范后已删除；最终验证使用正常官方构建产物，逻辑全部 inline。

项 9/11 及补充快照证据位于以下临时目录的 `evidence.json`，均保留工作区与账本数据：`toonflowTextOwnershipTFHKXd`（8 项）、`toonflowTextPublishSu6YQr`（7 项）、`toonflowMediaOwnershipBz1D6u`（4 项）、`toonflowApprovedInputsXaZbRf`（4 项）。根目录均为 `C:\Users\jinhk\AppData\Local\Temp\`。

项 8 升级证据保留于 `C:\Users\jinhk\AppData\Local\Temp\toonflowNodeUpgradeEvidenceUhAd8P\evidence.json`，含真实构建产物、旧完整包及固定执行归档。

审核型任务的显式恢复由处理器声明 `canResumeResult`，仍要求原处理器版本匹配、绑定完成、状态可恢复；重启不会自动重调审核型任务。已有旧版本任务不跨执行器版本强行重播。

## UI 工作包

独立 UI 工作包提交 `bbd5e36825ad358064e11018482442978ef2781e` 已合入后端修复 `edfd630`，代码整合提交为 `263ea7f`。随后独立复审确认原十三项中十项通过，剩余三项及新发现的 PR7 兼容问题见下节；不以内部回归代替验收。

| 审查项 | 修复与真实 HTTP 联调 |
| --- | --- |
| 6 孙会话嵌套事件 | 递归定位当前会话的包装事件，使用 root run 游标；真实 SQLite 写入三层委派事件，通过正式 NDJSON 接口及客户端恢复提问和正文。断开后 `afterSeq=2` 仅收到 3/4，提问快照与最深层会话归属一致 |
| 7 文本错误后保存及草稿持久化 | 保留待确认命令、正文和版本，显式重试或处理冲突；真实正文接口提交后丢弃两次响应，重新创建保存状态后以原命令对账，再保存后续草稿。远端更改触发 409，确认后版本再次变化仍拒绝覆盖，读取当前版本后显式解决成功 |
| 10 媒体配置同步 | 同步权威模型、尺寸、比例及视频参数，保留未提交字段；实际官方图片/视频后端通过 HTTP 修改和读取配置，组件实际 `applyConfig` 函数显示一致并保留脏字段。携带旧节点版本的生成请求被拒，作业列表仍为空 |
| 13 画布失败游标与补刷 | 刷新失败或忙碌不确认事件，安排后续刷新；正式工作区事件接口配合真实 Graph GET 验证三秒重连补齐最后一次变更，不依赖另一条新事件 |

UI 工作包的隔离验证证据：`C:\Users\jinhk\AppData\Local\Temp\toonflowUiReviewEvidence20261002\evidence.json`。合并后的真实 HTTP 联调证据：`C:\Users\jinhk\AppData\Local\Temp\toonflowUiHttpIntegratedmNKmrE\evidence.json`，保留临时工作区、SQLite、官方插件与接口请求记录。模型和 Agent 事件使用已安装官方元数据及持久事件夹具，没有调用模型或供应商。

项 13 追加组件链路证据：`C:\Users\jinhk\AppData\Local\Temp\toonflowUiHttpIntegrateddXkFXJ\evidence.json`。内存执行页面原有 `refreshGraph`、`useWorkspaceFiles`/Axios 与 `useWorkspaceEvents`，临时画布出现不完整 JSON 时正式接口返回 HTTP 500，旧视图及游标保持不变；恢复文件但不新增事件，三秒重连后补齐视图。此验证未挂载浏览器 DOM。首次尝试因内存浏览器环境缺少 `window.location` 导致 Axios 初始化失败，调整验证环境后通过，未因此修改业务代码。

合并后用 Node 执行 Vue 类型检查，Web、nodeScaffold、文本、图片、视频、导演六包通过；Web 及文本、图片、视频节点正式构建通过。Web 仅有既有大 chunk 提示。后端和导演构建沿用 `edfd630` 的通过结果，本次 UI 提交未修改它们。原生产目录九个已修改/新增文件与保留基线 `337eae0` 逐一比较（统一换行）均一致。

## 263ea7f 复审残余

| 项目 | 本次修复与回归 |
| --- | --- |
| 通用文本发布要求内置 textPath | 宿主固定 publication `{path,nodeVersion}`，发布核对绑定后的节点版本及画布/执行器/任务身份。真实持久作业、Graph 锁与正文 CAS 验证通用 documentPath 发布成功；删除、改变路径/任务绑定、替换节点类型/执行版本、重建画布均保留生成结果供核对。插件自行提供的伪造 publication/canvasId 被宿主覆盖 |
| 相同路径与节点 ID 跨画布 UUID 控制作业 | NodeJobRequest 固定 canvasId，get/cancel/wait 共用归属校验。三种调用均拒绝新 UUID，原 UUID 恢复后可访问自己的任务；另经正式 HTTP 删除、同名重建、生命周期恢复节点快照，原任务仍保持 accepted，不能从新画布查询或取消 |
| localStorage 配额耗尽阻断在线保存 | 存储异常转为独立可见 storageError，保留内存草稿及原命令，继续在线写入。实际 HTTP 验证配额耗尽、两次响应丢失、清理失败、读取被禁用；显式重试完成原命令对账或恢复存储，不同步抛错阻断输入 |
| PR7 内置编辑动作前缀不匹配 | 可信后端动作查找统一去掉单个 node: 前缀，保留真实 handler、revision 和磁盘内容校验。正式官方 canvas/textNode 通过运行守卫编辑正文无需审批；生成仍返回 AGENT_NEEDS_AUTHORIZATION，伪造 handler/revision 和双重前缀均不可信 |

证据：`C:\Users\jinhk\AppData\Local\Temp\toonflowTextTargetFixENNpQa\evidence.json`（七种文本发布状态、官方文本节点、无节点文本任务及 get/cancel/wait）和 `C:\Users\jinhk\AppData\Local\Temp\toonflowUiHttpIntegratedF3rWqe\evidence.json`（存储四场景、官方 PR7 链路及真实删除/重建 HTTP 流程）。通用插件描述及 AI 流仅在内存替代，宿主源代码、持久作业、文件、锁与正文 CAS 使用实际实现；没有创建插件/测试专用源文件。第一次通用验证尝试用普通 Graph 修改替换类型，被既有校验拒绝，随后改为临时文件替换来验证发布身份检查；第一次 PR7 验证遗漏后台工具注册，按正式注册路径补齐后通过，均未为验证环境问题修改业务代码。

本次改变文本发布的宿主绑定方式：生成期间任何节点版本变化都会进入 needsReview，结果保留；不会猜测第三方插件哪个字段代表路径。旧任务缺少新绑定时也不直接覆盖正文。此前通过的其余项目没有扩大修改范围。

额外发现、尚未修改：替代文本流立即完成时，`nodeTools` 动作返回前的 `refresh()` 与文本发布的 Graph 锁可能竞争，调用方得到 EBUSY，但后台作业最终完成。补充复现等待了作业终态，证据 `C:\Users\jinhk\AppData\Local\Temp\toonflowTextTargetFixUH2E6B\evidence.json` 中 `fastCompletionError` 与 `fastCompletionJob.status=completed` 同时存在。此边界超出本次指定四项，交回父线程安排后续处理；常规受理后再完成的流使用前述 ENNpQa 证据。

残余修复后 server、Web、nodeScaffold、textNode 类型检查通过，server 及 textNode 正式构建通过；保留合并时六包检查和四包构建证据。所有检查均使用既有命令或 inline 验证。

## 验证边界

未调用真实模型、供应商或 R2，未做真实 Tailscale/物理锁屏验证；未部署或重启生产服务。原生桌面 `.hutch` SDK 与完整分发打包的既有边界不变。
