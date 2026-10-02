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

审查项 6（孙会话嵌套事件）、7（文本错误后保存及草稿持久化）、10（媒体配置同步）、13（画布刷新失败的游标与补刷）由独立 UI 工作包负责，提交后统一集成验证。

## 验证边界

未调用真实模型、供应商或 R2，未做真实 Tailscale/物理锁屏验证；未部署或重启生产服务。原生桌面 `.hutch` SDK 与完整分发打包的既有边界不变。
