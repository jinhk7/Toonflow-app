# PR8 手机节点编辑与任务同步修复

基线：`4bc3199d44500b0f51b7295f31fe02a7d41b1e60`。历史手机界面对照：`768d8b05fd78cf6b98e2cee86fccf5c6f54dc830`。

## 根因与修复

1. PR8 删除了手机图片、视频生成节点的模型和提示词编辑卡，通用动作表单默认展示读取动作，缺少当前值回填、模型能力选项和多行编辑。为现有后端动作增加可选 `editor` 元数据，手机按原动作参数 schema 展示独立编辑区。保存仍使用后端 `nodeTools` 命令，Agent 窗口不参与节点编辑。
2. 节点任务面板从事件序号 0 重放整个工作区历史，每条任务或画布事件都重读任务、媒体和插件目录。任务列表现在提供兼容旧数组接口的快照游标；完整任务事件直接更新对应任务，文本增量不重读列表，插件目录在首次进入、恢复连接、显式刷新和插件变更时核对；不增加空闲轮询。
3. 订阅 watch 每次返回新数组，节点对象替换也会重新恢复任务。绑定改为稳定的目录、画布和节点 ID；旧请求、订阅及计时器在切换或卸载时取消，恢复读取完成后才继续接收事件。
4. 图读取反复展示全屏 loading、替换未变化对象，加上节点页重复初始化读取，导致重绘和输入中断。只有首次加载或切换工作区展示 loading；相同图、节点和连接保留引用，更新失败保留旧图和草稿。
5. 默认 MCP `panel` 使用完整节点路由，UUID 路径超过服务端 32 字符上限，400 后每三秒重连。改用短的路由模式，完整路径、参数和查询仍保留在 `navigation`。
6. 模型参数依赖原能力元数据，包括时长与分辨率组合、引用模式数组和声音能力。保存回执推进节点及文件版本，媒体编辑同时核对原输出与当前输出；未确认命令保持原命令 ID，旧窗口不删除另一个窗口的新凭据。支持合法空字符串的字段可以真正清空。所有草稿在异步读取前恢复，无需读取的提示词即时回填。

## 编辑覆盖和差异

| 节点 | 独立编辑区 | 实际保存与刷新／重进验证 |
| --- | --- | --- |
| 文本 | 正文、生成提示词、文本模型 | 多行正文；提示词连续两次保存；切换模型；桌面正文修改后手机读到更新 |
| 图片生成 | 模型、分辨率、比例、提示词、图片素材 | 第二个模型、1536、1:1、多行提示词、图片路径和 MIME |
| 视频生成 | 模型、时长、分辨率、比例、模式、声音、提示词、视频素材 | 第二个模型、8 秒、1080p、1:1、false；多行提示词和视频路径；连接三类素材后选择数组引用模式并刷新保存 |
| 图片素材 | 工作区路径、MIME | 改路径并刷新读取；外部修改输出时拒绝旧草稿覆盖 |
| 视频素材 | 工作区路径、MIME | 改路径并刷新读取 |
| 音频素材 | 工作区路径、MIME | 改路径并刷新读取 |
| 3D 导演 | 指令、模型、方案、场景文档、锚点、灯光、显示设置 | 修改方案文档、模型、指令、灯光和显示设置；保存、刷新；清空模型与方案 |

历史手机界面明确提供名称、分组、连接，以及图片／视频生成的模型和提示词编辑；不能把历史手机界面描述为已有七类完整参数编辑。本次七类编辑复用 PR8 后端原有动作和 schema，公共名称、分组、连接入口保留。通用后端动作表单仍可使用，切换节点时重新核对动作是否属于当前节点。

导演结构化参数使用 JSON 编辑，未复制桌面 3D 场景操作界面；素材使用工作区相对路径和 MIME。第三方节点需提供 `editor` 元数据才会出现独立编辑区，没有元数据时仍使用原动态动作表单。未增加供应商能力、上传选择器或自动合并冲突。

## 实际验证

使用本机 Edge 的独立标签，生产页面先只读检查；后续操作全部在隔离服务、临时设置目录和合成工作区中执行。小屏为 390×844，桌面为 1440×960。未发送真实 Agent、模型或供应商请求；隔离服务的外部 fetch 拒绝计数为 0。

| 场景 | 观测结果 |
| --- | --- |
| 生产回归只读复现 | 手机图片节点缺少提示词／模型编辑；观察期任务、媒体、插件目录各读取 69 次，事件连接 52 次；生产日志显示 MCP panel 长度校验失败。观察期未固定计时，不能换算为每秒请求数 |
| 空闲输入 20 秒 | API 请求计数为 0；输入框是同一 DOM 元素，焦点、光标、草稿保持，全屏 loading 未出现 |
| 运行任务进度 | 原任务从 accepted 到 running，15%→35%→65%→80%→90% 正常显示；普通进度事件不重新读取任务列表 |
| 断连恢复 | 补读一次任务快照和一次媒体列表，恢复订阅；旧图、同一输入元素、焦点、光标和草稿保留；恢复后新进度继续显示 |
| 原生取消操作 | 确认后原任务显示 cancelled，保留任务记录 |
| 手机页面往返三次 | 每次进入节点只读取一次任务快照、一次媒体列表；活跃和最大 SSE 数均为 3（全局 ffmpeg、图订阅、任务订阅），不随往返增长；未保存草稿重进后恢复 |
| 活动媒体任务 | 合法 prepared ledger fixture 10 秒内仅媒体列表读取 3 次，其他 API 为 0；同一输入元素、焦点和草稿保持 |
| 媒体任务进入终态 | failed／unlinked 显示后再观察 10 秒，API 请求为 0，轮询停止 |
| MCP 开启后的手机节点页 | 上报 `panel=mobile/node/:nodeId` 返回 200，完整 nodeId 保留；空闲 10 秒 API 为 0，无反复重连，SSE 为 4（增加 MCP 连接） |
| 初次正文读取延迟 | 暂停实际 getText 请求时，正文及其保存按钮不可用，已有提示词立即正确回填；释放读取后正文正常显示 |
| 并发修改 | 外部命令修改提示词、外部文件修改正文、外部命令修改媒体输出，旧保存均拒绝覆盖，草稿保留；非法导演 JSON 被原 schema 拒绝 |
| Agent 独立窗口 | 手机与桌面均显示暂停的合成会话、输入区和待确认问题；手机 Agent 内没有节点编辑组件，未提交问题或发送消息 |
| 桌面真实 DOM | 七类节点与独立 Agent 同时正常显示，无运行时异常；原文本编辑弹窗自动保存成功，手机重进读取到相同正文 |

媒体轮询验证使用直接插入／更新隔离 ledger 的纯数据 fixture，不调用供应商调度。视频 fixture 只有 MP4 文件头，用于路径和类型绑定，未验证播放解码。运行任务使用手动控制进度的隔离任务，但状态存储、事件和 HTTP 接口都是正式实现。未验证真实供应商生成、渲染成片或手机真机软键盘行为。

现有媒体协议没有为单独创建的、不带 NodeJob 的外部媒体 ledger 新行提供工作区事件：空闲面板通过显式刷新、重进或可见性／在线恢复发现它；发现活动任务后保留必要轮询。本次没有扩展该协议。

已执行：server `bun run routes`、`bun run typecheck`、`bun run build`；web `vue-tsc --noEmit` 和 `bun run build`；节点 SDK 类型检查；七类节点及 canvas、askUser 工具构建；`git diff --check`。Web 只有现有大 chunk 提示。另以 inline 调用完成订阅／快照及版本保护验证，未新增测试文件、测试框架或自动检查入口。

## 本地交付和证据

- 独立工作树：`C:\Users\jinhk\AppData\Local\Temp\toonflowMobileRecovery20261002`
- 本地分支：`fix/mobileNodeRecovery`
- 证据目录：`C:\Users\jinhk\AppData\Local\Temp\toonflowMobileRecoveryEvidence20261002`
- `productionReadOnly.json`、`productionMobile.png`：生产只读检查。
- `mobileDomQa.json`、`qaHttpSetup.json`：实际 DOM、请求计数、焦点和持久化结果。
- `savedGraphEvidence.json`、`qaDraftEvidence.json`：保存结果和冲突保留的合成草稿。
- `mobileVideoEditorFull.png`、`mobileAgentIndependent.png`、`desktopCanvasAndAgent.png`：实际页面截图。

初次本地交付没有推送或创建 PR。后按用户授权推送同一分支并创建草稿 PR9，当前仍未合入、部署或重启生产；原工作区未提交改动未修改。隔离数据和证据保留用于复核，交付结束后关闭本次隔离服务及自建标签。



## 审查后的边界修复

| 原问题 | 当前行为 | 实际证据 |
| --- | --- | --- |
| 同一节点多个编辑区保存后，兄弟草稿一直使用旧版本 | 仅本页面已确认保存且远端原值未变时安全推进兄弟版本；外部冲突显示远端内容，显式接受版本后保留草稿再保存 | mobileEditorRepairEvidence.json、reviewDomQaEvidence.json |
| 离线期间只改正文文件，快照游标吞掉正文变化；恢复复用旧读取 | 恢复先核对目录、等待读取最新内容，再采纳任务快照游标；旧读取等待结束后补新的读取 | syncIntegratedEditorFixEvidence.json、reviewDomQaEvidence.json |
| 导演普通配置提交破坏 Custom 引用 | prompt 未变且未显式传 promptModel 时保留原结构；引用随来源连接调整 | directorReferenceFixEvidence.json |
| 恢复草稿时 reader 首次失败，无法重试 | 草稿保留，提供核对入口，读取成功后可显示远端并选择接受版本 | mobileEditorRepairEvidence.json、reviewDomQaEvidence.json |
| 插件目录缓存过期且没有变更通知 | 安装、配置、启停、卸载成功后发布持久 pluginsChanged；恢复和显式刷新核对目录 | pluginNotifyFixEvidence.json、pluginInstallFixEvidence.json、syncReviewFixEvidence.json、reviewDomQaEvidence.json |
| 宿主模型记录字段与表单字段映射混用 | 标准 providerId/modelId 记录用于选项与能力关联，providerField 和当前字段名用于写回表单；保留旧自定义记录字段兼容 | mobileModelStandardRecordFixEvidence.json |
| nullable boolean 被当字符串且原 null 丢失 | 布尔三态提交 true/false/null；其他联合类型和纯 null 使用 JSON，合法 null 保留 | mobileMetadataDomFixEvidence.json |
| 多标签丢失回执时共享命令槽被覆盖或误删 | 命令按 commandId 分开保存并兼容旧槽；旧回执只结算自身凭据，不删除或自动推进其他标签的新草稿 | mobileEditorOwnerRepairEvidence.json、reviewDomQaEvidence.json |

同节点保存和原命令核对共用屏障：提示词写入已成功但兄弟正文新版本尚未核对完成时，禁止另一次提交，输入仍可继续。真实 Edge 延迟 sibling getText 的验证表明，忙碌期间正文提交次数为 0，读取放行后正文使用新版本保存成功。原始竞态复现保留在 reviewDomQaEvidence.json 的历史条目中，后续修复条目注明对应源码 hash。

共享草稿已改为不可复用 draftId 快照：写入新快照成功后只删除此前精确 ID；完成回执在 owner 核对前清理对应 sent.draftId，失败保留。内部 CAS 更新保留 editedAt，旧回执不会抢占新输入的恢复优先级。旧共享稿使用惰性迁移标记，原槽保留但保存后不再恢复；旧共享命令使用独立 commandId settled 标记，避免跨标签读后删。取消 reader 的 loading 只由对应 readRevision 清理，不遗留禁用状态。

## 本轮真实浏览器验证范围

- 最终小屏为 390×844，原生输入与按钮操作，绕过 Service Worker 并禁用缓存；全部写入仅针对隔离 qaData/qaWorkspace。
- 自定义 vendor/engine 模型、尺寸联动、nullable 布尔与纯 null 使用合法合成元数据及 CDP 定向响应；实际编辑器和原 Zod schema 校验通过。此项没有验证真实第三方插件后端保存。
- 真实插件启停接口对隔离 audioNode 发出通知，启用状态已恢复。当前编辑 DOM 和草稿保持，目录读取 2 次，任务列表读取 0 次。QA 使用服务端规范目录，避免 fixture 的斜杠写法差异被 SDK 事件目录校验过滤。
- 当前空闲观察 20 秒 API 新请求为 0；同一输入 DOM、焦点、光标和草稿保留。运行任务 60% 进度经真实持久事件更新，任务列表读取 0 次。
- CDP 真实网络断连与恢复后，任务进度仍恢复；只有原生 online 的场景读取一次任务快照及一次目录。额外注入 online 事件的竞争验证会取消旧恢复链，活跃订阅最终仍为 3，没有新增重复订阅。
- 本轮未发送真实 Agent、模型或供应商请求；当前隔离服务 rejectedFetches 为 0。

构建与检查：server routes/typecheck、Web 类型检查、完整 build:server、最终 Web 重建均实际通过，仅保留现有 chunk 提示。草稿修复阶段产物 mobileNodeDetail-BchS0scv.js，编辑器源码 SHA256 为 ee4164bf03773c7eccd595789d9c72a63af21086f4068f88d9056224839b3ff7；mobileEditorImmutableRepairEvidence.json 的 13 组完整 Vue、正式临时 HTTP/SDK 与后端 CAS 验证全部通过。后续模型映射修复只改两个模型选项 helper，Web 类型检查与构建再次通过，当前产物 mobileNodeDetail-MCxNQvRA.js，编辑器源码 SHA256 为 efcddb270a308039f62ae0b3ff6c422440e49f3f93d2ecc68e547bd0fc8d6923。

生产备份已保存到主仓库 backup/pr9Deployment20261002T180532：data/build/work 共 1302 个文件逐 SHA256 核对一致，另含基线源码归档、Git 状态、原两个未提交文件和 stash 引用。主仓库仍为 PR8 基线，Agnes 配置与原修改未动。部署仍以同 Astra、Codex review 和最新 HEAD CI 三道门槛为前提。

最终 Edge 双标签验证通过：A 的命令响应和 SDK 回执 GET 定向返回 503（真实命令已提交），B 冲突后 A 凭据仍在；A 重载恢复 B 新稿，旧回执删除已确认原快照而不改变 B 原版本。未接受新版本的保存仍冲突，显示远端后明确接受再保存成功，B 重载为 clean，独立快照为 0，原已保存草稿不复活。最新源码下 reader 取消后仍可核对，规范目录文件单独变化恢复、20 秒 idle 零 API、75% 实时进度更新均通过，活跃订阅最终为 3，外部 fetch 拒绝为 0；证据见 reviewDomQaEvidence.json。

同 Astra 对 ddd56e5 的复审中，其余七项及保存时序、草稿原子清理、取消 loading 均通过，模型字段映射仍有一项 P2。前一轮 vendor/engine fixture 同时改写了模型记录字段，遗漏宿主标准返回值。本轮严格保留原输入 models=[{providerId:"p",modelId:"m1",sizes:["512"]},{providerId:"p",modelId:"m2",sizes:["1024"]}]，只将表单映射设为 vendor/engine、providerField="vendor"。完整 Vue SFC 与原服务端 validator/Zod 验证确认两个非 null 模型选项、原尺寸 512 回填、切换 m2 清除旧尺寸、选择 1024 后参数为 {vendor:"p",engine:"m2",size:"1024"}；原模型记录前后完全一致。标准内置字段、导演组合模型字段及旧自定义记录兼容验证也通过。390×844 真实 Edge 原生下拉及保存操作得到同样结果，捕获完整 CanvasCommand 并通过原 Zod；无网络错误或真实供应商请求，独立标签已关闭。证据见 mobileModelStandardRecordFixEvidence.json、mobileModelStandardRecordFix.png。此项 DOM 的元数据、读取响应和保存回执为定向合成响应，不代表真实第三方后端保存。上述结果随后由同 Astra 最终独立复验通过；后续 Codex 评审修复见下节。

## Codex 评审修复

同 Astra 对 461a4021 最终独立复验通过，八项问题全部闭环；随后 PR9 转为 ready，Codex 对该提交评审提出两项 P2，已完成以下修复并等待最新 HEAD 复评。

| 问题 | 修复及验证 |
| --- | --- |
| 桌面断线期间插件变更没有可重放事件，恢复后目录仍旧 | 桌面恢复先核对画布再读取全局节点目录，两者成功后采纳游标，避免旧目录响应与新游标并发配对；目录读取失败不推进游标并等待重试。首次目录读取统一由恢复链完成，未变化的描述、配置、菜单与组件保留引用。完整桌面 SFC 和真实 Vue 恢复链验证离线新增目录后可用项更新，原节点与草稿保持，setNodes 为 0；目录失败恢复后订阅为 1，20 秒空闲无额外请求或组件加载。证据 pr9DesktopCatalogRecoveryEvidence.json；此轮使用受控 transport，未声称真实浏览器焦点已测 |
| 通知失败使已经提交的插件操作误报失败 | 公共通知入口逐工作区隔离事件写入失败并记录明确日志，其他工作区继续通知；原插件文件或配置异常仍向 HTTP 调用方传播。正式隔离 HTTP 与 SQLite 触发器验证 install/save/setEnabled/uninstall 均返回 200 且实际提交，故障工作区事件为 0、兄弟工作区为 4、错误日志为 4；真实只读文件引发替换 EPERM 时返回 403，原文件保持且不追加通知。证据 pr9NotificationFailureEvidence.json |

通知仍采用现有事件存储，没有新增 outbox；在线通知失败时通过恢复连接或显式刷新重新核对目录。故障触发器已移除，文件属性已恢复，临时服务已关闭，外部 fetch 为 0。Server、最终 Web 类型检查及 diff 检查通过，完整 build:server 与最后 Web 重建通过，仅现有 chunk 提示。游标期间自动保存推进、dirty 图冲突、原图读取异常和恢复取消均有原函数/真实 Vue 证据；游标不提前提交，独立目录仍核对，原图异常保留。未新增任何测试文件、框架或检查入口。


## Codex 第二轮恢复游标修复

Codex 对 9f948dc0 提出手机恢复竞态：目录先返回旧值、任务快照随后取得包含插件变更的游标，二者并发会跳过目录变更事件。恢复现在先取得并固定合法任务快照游标，再读取媒体、目录及最新编辑内容；所有步骤成功且仍属于当前节点时才提交游标。快照失败仍核对目录和媒体，媒体或编辑读取失败保留原游标，必要事件继续重放。

当前完整 mobileExecutePanel SFC、真实 Vue 生命周期和正式 SDK 的 16 个精确时序／失败边界验证全部通过：快照 100 后延迟旧目录期间产生插件 101、任务 102，订阅从 100 重放后目录与任务更新，实时 103 继续工作；20 秒空闲新增请求为 0。拒绝或非法快照、媒体／目录／编辑读取失败、旧响应取消、切换节点、完成瞬间取消和卸载均不提前提交游标或覆盖新状态，卸载后活跃订阅为 0。证据 pr9MobileRecoveryBarrierEvidence.json；传输与父编辑读取回调受控，不代替部署后的真实 DOM 验收。

Web 类型检查、构建及 git diff --check 均实际通过，组件 SHA256 为 e97e3a6ef5487541570aea20594b5e2a50647dcf7510bd451b6abb37f138449a，产物 mobileNodeDetail-DiBEkxTI.js。没有新增测试文件、脚本文件或检查入口，没有发送真实 Agent、模型或供应商请求。


## 可选节点版本回执兼容

Codex 对 e68795eb 发现：第三方 editor.readAction 可以只返回编辑值，协议没有要求 nodeVersion，原基线因此停在首次保存前。缺少有效版本的读取现在补读最新图，并使用执行前固定的 expectedVersions 重读；快照绑定对应读取版本，后续该编辑区直接使用此 CAS 读取。内置明确版本路径不增加请求。旧响应不会绑定当时更新后的 props 图版本。没有可证明自身版本的回执时，保存期间继续输入或跨 owner 草稿仍保留旧基线，核对并显式接受当前版本后再保存。

完整真实 SFC、Vue 生命周期、正式 SDK 与全新隔离 HTTP 的六项验证通过：无版本结果连续保存使用 expectedVersions 2、3，最终版本 4；外部写入仍拒绝旧草稿，显式接受后可保存；旧读取与取消不抬草稿版本；内置初次 getText/getConfig 各一次，已确认保存的兄弟 CAS 推进和文件 revision 保持；保存中继续输入保留编辑优先级和原版本。证据 pr9OptionalVersionReceiptEvidence.json。验证仅定向移除内置 getConfig/setConfig 的成功 HTTP 回执版本字段，其余值、原后端 CAS 与 152 次正式 API 请求均真实；未创建第三方插件实现，不代表已验证真实第三方后端。外部请求尝试为 0，临时服务已关闭。

Web 类型检查、构建、独立只读审查及 git diff --check 通过；组件 SHA256 f64c56ba5103b338c5f189ba8ced573d641627309503a7403706d65c2630e4d6，产物 mobileNodeDetail-Ckpqu5zt.js。未新增测试文件、脚本文件或自动检查入口。

## 动作 schema 与无读取动作保存基线

Codex 对 e82c26da 又发现两项协议兼容问题：同名 expectedRevision 被前端强制为 SHA-256；无 readAction 且无版本回执的动作在父页面刷新前再次编辑，会保留旧 CAS。修复将格式校验交给动作自身 schema，缺少原文件版本的隐藏正文基线仍禁止保存；接受远端基线与回执自动回写只处理隐藏的版本字段，保留第三方可见同名参数。有效版本必须是非负安全整数；仅无 readAction 且缺少有效版本回执时，在原保存屏障内补读图并回填 clean 区块，内置明确版本路径不增加图读取。新输入、取消或跨 owner 草稿不凭任意新图自动提高原基线。

完整实际 SFC、真实 Vue、正式 SDK 与隔离 HTTP 的六组验证全部通过：隐藏 ETag v12 由原声明 Zod 接受，可见同名参数在接受远端、回执及保存中继续输入时保留，基线仍为原送出值；内置非法 SHA 由真实后端拒绝且文件／草稿保持；旧正文稿缺文件 CAS、文件单独外改而节点版本不变时，提交前写入为 0，明确核对并接受后可保存。无 reader 的连续保存使用版本 2、3，最终为 4，图核对屏障内第二次写入为 0；父 props 保持旧版本不影响下一次保存。继续输入加外部修改、取消后恢复及跨 owner 回执均保留原 CAS。证据 pr9SchemaAndSaveBaselineEvidence.json，107 次正式 API，外部请求尝试为 0，隔离服务已关闭。ETag 和可见同名参数使用原 Zod 的受控命令接收边界，其余使用正式 HTTP，只定向移除九条成功 setPrompt 回执的可选版本字段并延迟真实响应，不代表真实第三方插件后端验证。

最终 Web 类型检查、构建、独立只读审查及 git diff --check 通过；组件 SHA256 cb52719ea2239611ef140e8548a65339669c3d2abc52c116468e85b470196490，产物 mobileNodeDetail-DCpnRuxg.js。没有新增测试、脚本或插件实现文件，没有发送真实 Agent、模型或供应商请求。

## 动态读取动作与正文事件兼容

Codex 对 3d0879f0 提出三项 P2：业务含义的整数 version 被当作节点 CAS；读取动作可能有必填参数却被固定以 {} 调用；正文同步只识别内置 textPath/modelPath 和 expectedRevision。保存现在只认可 nodeVersion，无版本的 clean 保存继续在屏障内核对图；原定义加载以 parseAsync({}) 校验读取 schema，和后端实际执行一致，SDK 明确空参数约定。安装静态语义、回滚、归档时机与协议均未改，无效读取动作在定义加载阶段被拒绝。

正文事件没有可靠的资源与节点映射，现按已有工作区／画布范围核对当前节点全部 clean readAction，dirty、pending、saving 保持跳过；不因此读取图、任务、目录或媒体。ACT 注释说明当前最多 256 个动作的保守核对范围及后续资源元数据优化方向，不新增轮询、订阅或元数据字段。

九组原函数与原 Zod 验证确认：空 schema、optional、default、nullable default、合法 async 接受 {}，required、nullable required、async 拒绝及 optional 但 refinement 实际要求值均以明确 400 拒绝。七类原后端定义通过，正式隔离 GET /api/nodes/get 返回 200 且全部 ready/protocol2；证据 pr9ReadActionSchemaEvidence.json。未执行读取动作或模型请求，没有验证 HTTP 拒安装。

两完整 SFC、真实 Vue 生命周期、原 workspaceEvents、正式 SDK、实际 Axios 与正式隔离 HTTP/NDJSON 的七条报告全部通过：业务 version=100 不作 CAS，父 props 停在 2 时连续保存仍以 2、3 提交至 4；陌生 assetSource 路径和 assetTag 字段的真实正文事件更新 getText/getConfig，各一次，其余图／任务／目录／媒体读取为 0，changed emit 为 0；dirty/pending/saving 保留草稿与原基线。2200ms 空闲无新增请求，失败后恢复只读一次任务快照和目录，序号无重复，订阅最多 1 条；取消、卸载后订阅／监听器归零，3300ms 后无请求，路由重进恢复 1 条。72 次正式 API、外部请求尝试 0，临时服务已关闭并确认 ConnectionRefused；证据 pr9DynamicEventAndBusinessVersionEvidence.json。该项身份／焦点覆盖真实 Vue host，非浏览器 DOM；UI 元数据只定向改字段名，四条成功回执只将可选 nodeVersion 替换为业务 version100，其余值及真实后端 CAS 保持，没有第三方插件实现文件。

Web、Server、节点 SDK 类型检查，Web／Server 构建和独立只读复核通过，Web 产物 mobileNodeDetail-Dij7QdR2.js。编辑器 SHA256 6f81ea86289f1fac100c624ce9ca6be1befcf02aecb04171adfa9f39c104b2a6，最终 panel SHA256 4a9ddb8955cd37e3a4d548b0b1c3ce6929036e3ad229f7cf308bb0ee934c0079；panel 最后仅新增 ACT 注释，移除此唯一注释的字节与实际执行的 23762057 源码精确一致，证明保留在同 JSON。未新增测试、脚本、插件实现文件或检查入口。

## 待确认命令与恢复游标

Codex 对 5770c024 发现待确认命令查询临时失败后，恢复仍采纳已覆盖完成事件的快照游标。任务快照现在先固定游标并核对媒体、目录与编辑内容，再核对待确认命令，且 await 后重新检查取消／作用域；全部成功才推进游标。查询 accepted/running 是有效状态，后续原命令 terminal 事件继续工作；忙碌、失败或取消返回 false，jobChanged／graphChanged 的失败同样传回原订阅恢复链，不吞完成事件。不修改公共订阅 hook 或新增轮询。

完整调用链还发现两条同根凭据保护缺口：公共 SDK 在提交结果未知后，补查回执的 4xx 曾覆盖原提交错误；编辑器已得到受理回执后，settle 的查询 4xx 曾被当成提交拒绝。SDK 仅一行保留原 POST 错误，补查失败不伪装写入拒绝；编辑器取得回执后保留 pending/sent/draft，只有 command() 本身的明确 4xx 才按原逻辑清理该 ID。面板区分读取错误与查无原命令后的提交拒绝，公开查询语义、原确认不存在后的有限同 ID 重发保持。

当前 panel 的原 16 组恢复矩阵实际重跑全部通过，20 秒空闲新增请求 0，事件重放、实时进度、失败、取消、切换与卸载保持；证据 pr9MobileRecoveryBarrierFinalEvidence.json。该组无 pending，使用原未变的 SDK 快照／订阅实现；最新 SDK 的命令路径由以下独立增量覆盖。正式 SDK 18 组内联 fetch 替换验证全部通过：未知 POST 加查询 401/403/409 保留原错误、网络错误保持同一对象、明确 POST 400/409 不查询、真实有效回执正常返回、原 null/404 的有限重发与公开 getCommand 错误语义保持；证据 pr9CommandLookupEvidence.json，无真实网络。

完整两 SFC、真实 Vue 生命周期、原 hook、最新 SDK、实际 Axios 与正式隔离 HTTP/NDJSON 的七组增量全部通过：GET403 不提交 cursor 并在原 3 秒恢复链中自动核对成功；已受理 POST 的 ACK503 加 SDK 查询 401 保凭据，恢复后 POST 总数仍 1；accepted/running 有效回执允许订阅，终态查询失败不消费事件并自动恢复；busy、2200ms idle、取消／切换／卸载无旧游标提交或重复订阅；编辑器受理后的 settle401 保 pending/sent/draft，原 ID reconcile 后正确清理，明确 POST400/409 仅清拒绝凭据保草稿。109 次正式 API，外部请求 0，订阅最多 1、卸载归零，隔离服务已关闭并确认 ConnectionRefused。证据 pr9PendingCommandRecoveryEvidence.json；运行阶段是定向回执状态 fixture，终态回执实际为 completed，并通过现有隔离 store 追加原命令事件走正式 NDJSON，没有验证真实模型任务或浏览器 DOM。

最终 Web／节点 SDK 类型检查、Web 构建和独立只读复核通过；Web 构建与类型检查首次并行出现既有设置页 TS7006，构建结束后顺序重跑通过，自动声明无最终差异，未修改无关设置页面。最终产物 mobileNodeDetail-DeN44YS-.js，panel SHA256 ef15833b251660b07a78560c109d1cb86b2af075560ef01016d391c966b5f925，editor SHA256 8aaa44c69030fd49d82233de08655d82da69bbc9d6d7fee01c2007ce60c09cc6，SDK SHA256 d4ddbd6ccbc4e3a76e4ac314478374ef56ad47c9e516805677f24544af30b75e。未新增测试、脚本、插件实现文件或检查入口，未访问生产数据或发送供应商请求。

## 隐藏并发令牌与用户联动字段

Codex 对 26668d6d 发现：显式接受远端版本时，仅同步 expectedRevision/expectedOutput 会让合法的 etag、revisionToken 等隐藏令牌继续使用旧值。接受入口现在按已有 fields.hidden 元数据同步远端值，并删除远端已不存在的 JSON 缓存；可见草稿保持。隐藏 provider 以及可见模型／选项直接控制的隐藏依赖字段属于用户草稿，沿用现有 changeModel/changeChoice 的绑定与模板优先级保持，不把已清除的不兼容值重新带回。没有新增令牌字段协议、递归依赖或保存回执映射；原 pending/loading/saving guard、owner 和不可复用草稿保护保持。

最终完整 mobileNodeEditor SFC、真实 Vue 生命周期、正式 SDK 与隔离 createApp HTTP 的六组针对验证全部通过：自定义 etag/revisionToken 及内置文件 CAS 冲突后保稿、接受新令牌再保存成功；原 providerId/modelId 与自定义 vendor/engine 保留用户 A/X 配对，接受远端 B/Y 的节点版本后以版本 3 保存至 4；缺失 JSON 缓存清除且参数不复活旧令牌，可见同名参数保留；延迟正式保存回执期间禁止接受远端，新输入和 editedAt 保持，显式再次接受后可保存。另两组受控完整 SFC/Vue/Zod 验证确认模型尺寸与选项依赖隐藏值被清除后不会复活。证据 pr9HiddenTokenRecoveryEvidence.json；120 次正式 API，外部／供应商请求 0。自定义字段元数据、请求别名和读回执增补／省略、回执延迟属于受控部分；实际文件与模型配置持久化、原节点／文件 CAS、Zod 由正式接口完成。两组隐藏依赖使用受控只读状态，没有第三方后端实现或 HTTP 保存，不代表真实第三方插件验证；此项非浏览器 DOM。

最终 Web 类型检查、随后构建与独立只读复核通过，产物 mobileNodeDetail-CGu93xMw.js；编辑器 SHA256 9149d17b78fd12e30f0d234ba5cd4d28647683816d5042afb5f037cd21f2e0d0。未新增测试、脚本、插件实现文件或检查入口，未访问生产或发出模型请求。

## 单次读取与无 reader 节点映射

Codex 对 f7a1025e 发现：首次无版本读取曾通过两次动作执行确认基线；无 reader 但有有效 nodeVersion 的保存曾跳过节点映射回填。reader 现在复用调用方提供的图，或先读取图，确认节点存在和非负安全版本后只执行一次带 expectedVersions 的动作；无版本回执绑定本次执行前的 readVersion，不使用响应时的新 props。删除 readWithoutVersion 探测状态。所有无 reader 的 clean 成功保存都在原 saving 屏障内核对最新图并回填 values.node；输入中的 dirty 草稿、跨 owner 草稿及取消保持既有保护，图读取不生成 ownVersions 证明。

当前统一读取路径会为带版本的内置 reader 预读图，已有 retry/sibling 图可复用；每次请求的动作 execute 为一次，空闲／任务列表／订阅链无新增逻辑。前文“内置明确版本不增加图读取”的证据对应旧轮次源码；最新行为与覆盖以本节为准。

完整实际 SFC、真实 Vue 生命周期、原 SDK 与隔离正式 HTTP 的六组针对验证全部通过：内置与定向删可选版本的 reader 首次／刷新／核对分别执行一次，CAS 全部为 2，核对复用图仅一次图 GET；受控非幂等 reader 首次分配计数 1，旧 CAS／缺节点在执行前拒绝，取消保稿。无 reader 使用原 imageNode.setImage、有效 nodeVersion 回执和实际 PNG 资源：隐藏字段 etag 映射 data.outputs.image，父 props 保持旧值，连续保存采用 null→imageFirst→imageSecond 输出令牌，每次 clean 保存一次图读取；原后台输出 CAS、Zod、文件读取和持久化真实。图屏障期间第二次写入为 0，新输入与 editedAt 保留；外部输出冲突保留，取消后持久草稿及 foreign owner 旧令牌保护通过，原命令 POST 一次。证据 pr9SingleReadAndNodeMappingEvidence.json，73 次正式 API，外部／供应商请求 0。

可选版本回执删除、隐藏 expectedOutput→etag 元数据／请求别名及图／回执延迟是受控部分；节点版本和输出回执未改。非幂等分配计数及其 CAS 使用 inline 合法元数据／原 Zod／受控 SDK，未验证真实第三方插件执行；跨 owner 使用共享 localStorage 的两个实际 Vue scope，此项非浏览器 DOM。未新增测试、脚本或插件实现文件。最终 Web 类型检查、随后构建、独立只读复核及差异检查通过，产物 mobileNodeDetail-CwDcoylL.js，编辑器 SHA256 effc68ab3c7b87d93cc8d315bfc824050ae8f343714ab32af5f6ff47b5d6e41b。

## 保存后回读失败与持久草稿恢复

Codex 对 3d2eec3f 发现保存完成后 readSection=false 被忽略，随后错误清空并误报完整成功。现在 reader 的 false 与无 reader 的图读取异常统一恢复：明确说明写入已完成但最新内容核对失败，保留当前值、owner 和编辑时间，清除旧远端预览，生成新的不可复用恢复草稿；ready=false 阻止旧基线直接保存，dirty 保证表单仍能编辑与核对。原确认命令及其精确 sent 快照正常结算，重试不重发原写入。取消不会按新的 props 目录持久化旧区块。只有成功回读且仍 clean 时清除编辑时间；其间的新输入不清理。

独立完整复核另发现续输持久化失败会被成功尾部清错；两分支合流检查 changeSection(false)，失败保持错误并停止成功提示。已确认删除 sent 快照后，仅仍指向该 ID 的 draftId 被清理，新真实 ID 和编辑时间保持，使后续保存必须先备份，包含 foreign owner 的早退路径。没有新增轮询、协议或存储抽象。

证据 pr9PostSaveReadFailureEvidence.json 保留两版实际运行：6a44d764 的六组正式回读故障与两个 quota 入口 8/8，通过 126 次 API；最终 30d7d4ef 的三个指针／持久化增量 3/3，通过 67 次 API。没有宣称前八组在最终 hash 重跑。首次读失败矩阵覆盖内置／无版本回执 reader503、无 reader 图503、期间续输、取消及 foreign owner；原写 POST 都为一次，故障不显示成功，ready=false 防直接再写，核对及明确接受后可继续保存。最新增量覆盖成功回读期间输入 quota、原续输分支 quota，以及回读与备份双失败：旧 ID 清空，存储恢复后先生成新备份，原后台异步 CAS 失败（POST202→GET200 terminal failed）后重载仍保原版本草稿，明确接受外部版本后保存成功。14 个记录 scope 均停止、连接取消，三个记录端口均确认 ConnectionRefused，外部请求 0。读／图响应失败、时序门和 RAM localStorage quota 为受控注入，后端 CAS、命令状态和持久化为正式隔离 HTTP；此项不是浏览器 DOM 或真实浏览器存储配额验证。

七类加载补查在 3d2eec3／effc68ab 源码实际通过：14 个编辑区块 ready/clean 并通过原 Zod；6 个 reader 各一次命令及前置图读取、固定节点 CAS，其他区块直接节点映射；原模型选项与能力可获得，合成业务文件和设置未变。证据 pr9FinalBuiltinReaderEvidence.json。最终 30d7d4ef 的 readSection/readCurrentSection 与该源码逐字相同，后续改动限定在保存完成处理；保存失败增量另行覆盖。

同轮独立复核发现官方导演 setPreferences 只返回 NodeExecutionSnapshot.version。该动作现在保留全部原快照字段，并将本次写入的 version 明确附为 nodeVersion；前端不接受通用业务 version。原动作类型检查、production 单包构建以及最终 30d7d4ef 完整 SFC／真实 Vue／正式隔离 HTTP 通过：保存期间续输的草稿持久 baseVersion=2，两次写 expectedVersions 为 1、2，回执 version=nodeVersion 为 2、3，最终新内容和节点版本 3 保持。证据 pr9DirectorPreferencesVersionEvidence.json；未调用模型，随机隔离端口确认关闭。其它七类官方编辑保存已明确 nodeVersion，没有第二处同根返回遗漏；此项非浏览器 DOM。

最终 Web 类型检查、随后构建、导演类型检查与单包构建、独立完整只读复核和 git diff --check 通过。Web 产物 mobileNodeDetail-CbQXZqSA.js，编辑器 SHA256 30d7d4eff3db36bb34c75a5b0db74601b3f951bd2fbd07326970d7ae5201f6cf，导演后端 SHA256 8d1eb62c293917dd4b411118647e0505491ad919ce333640f0ce2d1fe16f3ae7。未新增测试、脚本或插件实现文件，未访问生产或发出真实 Agent／模型／供应商请求。

## 全局插件事件与订阅空窗

Codex 对 9dd0d96a 发现首次连接／断线恢复仍有目录快照至订阅建立的空窗：没有在线订阅时，插件变更不会持久化，后续订阅无法补回。公共通知入口现在在现有 workspace_events 中以空目录内部标记持久化一份全局 pluginsChanged，再将事件投影为各在线工作区。快照游标和订阅重放使用完全相同的本目录加全局插件事件筛选；实时与重放都输出合法目标 directory，原 SDK 过滤保持。空目录非插件事件不参与全局游标或重放，图、正文、任务及 UI 事件继续按工作区隔离。旧目录事件兼容，不新增表、协议、目录复读、轮询或订阅。

通知持久化失败仍记录错误并保留已提交插件操作的成功语义，恢复／显式刷新核对目录；没有新增 outbox。前文逐工作区写失败且兄弟通知继续的证据对应旧实现，当前为单次全局持久化，不将旧故障计数当作新实现验证。

完整正式 createApp、原 SDK／NDJSON parser、真实 Vue effectScope 与原 useWorkspaceEvents 的 11 项验证全部通过：无订阅且无私有历史的工作区先固定快照、返回旧目录，随后真实 setEnabled 产生单次全局事件，订阅重放后读到新目录；恢复期间另一工作区保持在线，两者收到相同 seq/eventId 且目录绑定正确、严格递增无重复。各目录 content 不串流，空目录非插件事件不进游标或重放。20 秒空闲新增 API 为 0；scope.stop 后正式服务 res.close 观察连接归零，峰值为两个工作区各一条。

全局 SQLite BEFORE INSERT 故障下 install/save/setEnabled/uninstall 四接口均返回 200 且真实提交，四条明确日志、全局与两工作区新增通知均为 0；恢复核对仍看到已提交禁用状态。沿用既存插件 fixture 的真实只读替换失败返回 403，原源文件保留且无额外事件。证据 pr9GlobalPluginEventGapEvidence.json；首次两次验证端错误数据库路径／Bun 次级计数观察器修正均如实记录。服务已关闭，验证代理及 root 分别实测原随机端口 ConnectionRefused／ECONNREFUSED，所有 scope／订阅释放、触发器与文件属性／节点配置恢复，外部请求为 0。此项为真实 Vue／正式 HTTP 时序验证，非浏览器 DOM；没有新增测试、脚本或插件实现文件。

当前仅 store.ts 与本节文档变更，Server 类型检查、构建、独立只读复核及 git diff --check 实际通过，store SHA256 698ac6934518f9dd4080a3e9b8f5084e1fdc930186e7b2484bb7944ef384fadf。前轮 Web／SDK／七类节点源码保持，部署后真实 DOM 验收仍待最新 HEAD 审查及 CI 门槛通过。

## 通用动作的节点来源参数快照

Codex 对 66f90b6d 发现：五类官方素材 setter 的 expectedOutput schema 声明默认 null，通用动作表单仅载入 schema 默认值，遗漏 editor.values.node 指向的当前输出；已有输出替换被原后台 CAS 拒绝。不能删除 null 默认值或提交时换成最新输出，因为输出可以独立于节点版本变化，空输出同样需要 CAS。后台 schema、双重 CAS、桌面 setter 与省略可选字段的既有兼容保持。

公共通用表单现在仅对 hidden 且有 values.node 的字段捕获深拷贝节点快照：映射值优先于默认值，只在 undefined 时使用默认；随参数草稿保存字段来源、节点版本与 executionRevision。自动管理字段不显示，内部 JSON 缓存不能覆写，结果来源字段仍可填写。提交固定使用捕获的值和节点 CAS；刷新 props 不重基线。旧草稿无证明或插件版本／来源改变时，明确核对当前节点并保留可见参数；固定目录实例读取图，延迟回复校验作用域、动作、版本、路径与待确认状态，切换／取消／卸载丢弃旧回复，读期间输入保留。坏 JSON 与错误草稿结构保原槽并阻执行，缺少可选旧字段允许迁移，持久化失败先停止提交。

最终 dde1bf4e 完整实际 SFC、真实 Vue、原 SDK／workspaceFiles／workspaceEvents 与隔离 createApp HTTP 的 25 项全部通过，254 次正式 API、外部与未知动作 0。五类原有输出实际替换并落盘；output-only 变化不改 nodeVersion 仍拒绝旧快照，null 基线也拒绝外部输出新增，草稿、原 requestJson 与外部输出保持。这两项公开 command 请求实际 HTTP202，随后真实 terminal failed，不是接口 HTTP409。明确核对后可连续保存，旧 null／JSON 缓存与缺字段草稿迁移、读期间续输、七类取消／作用域边界、pending 互斥、坏 JSON／合法坏结构／无节点映射坏稿、quota 零 POST、必填与结果来源参数全部通过；20 秒空闲新增 API 为 0，矩阵结束实际订阅 0、峰值 1。元数据与延迟/配额属于受控部分，原五类 setter、文件读取、输出/节点 CAS、命令状态与持久化由正式隔离接口完成，没有真实生成请求。首次冲突断言选了相同输出而实际完成，已记录修正并用第三个不同资源重跑；非产品失败。证据 pr9GenericOutputSnapshotEvidence.json。

最终纯函数／Vue／原 schema 内联补查 5/5，覆盖 null/default/undefined、JSON 与 props 深拷贝、源版本／路径变化、结果来源可见及七类坏结构／四类旧缺字段；证据 pr9GenericSnapshotInlineEvidence.json，不当作 HTTP 或浏览器验证。顺序 Web 类型检查与构建、独立只读复核和 git diff --check 通过，产物 mobileNodeDetail-BfciLpXT.js，panel SHA256 dde1bf4e937bdc8b6925b936a009ec0327abc9332129f0dd0cdfa59ff25af720。未新增测试、脚本、插件实现或轮询，独立节点编辑器、SDK、官方 backend schema/CAS 未改变。

原 25 组中，两项程序化切换使用未列动作名，仅覆盖受控 binding 保护；没有把它们当作真实该动作执行。另以相同冻结源码补两项实际 catalog 动作：imageNode.setImage→uploadImage 的延迟核对切换保护，textNode.setPrompt（无 nodeFields）坏草稿逐字保留／零 POST／零核对读图，均通过。证据 pr9GenericOutputSnapshotActionSupplementEvidence.json；总 27 含这两项增量，没有重跑原全矩阵。

真实本机 Edge／CDP DOM 的 25 条断言全部通过：390×844 五类实际替换与五类整页刷新重进持久化，旧草稿缺证明阻执行、真实图核对后成功；正式 operationId/outputVersion 制造输出单独变化，nodeVersion保持，实际 CAS 冲突保同一 DOM、焦点、3–7选区及路径/MIME，外部输出未覆盖，明确核对后成功。实际 31.718 秒稳态全部 API／命令／SSE 新开 0，同输入值、焦点、光标与未保存草稿保持。1440×960 覆盖同 mobile 路由五类通用表单、一次音频实际替换、坏 JSON／错误结构阻执行与原槽保留，以及独立 Agent 只读窗口；没有创建或发送 Agent 请求，也没有声称本轮重跑桌面画布全矩阵。七次实际 mobileNodeDetail-BfciLpXT.js 响应与本地 94fc1b74 bundle SHA一致。证据 mediaOutputDomEvidence20261003.json，两张实际截图 mediaOutputMobile20261003.png／mediaOutputAgentViewport20261003.png，root 均作视觉复核。

浏览器控制请求首次缺 operationId 被正式 HTTP400 拒绝，纠正后 HTTP200 才实际制造输出变化；已记录为验证端修正。一次 CDP routing abort 的 InvalidInterceptionId 及最初 non-TTY helper 启动也保留，没有算产品失败。历史 CDP 请求 ID 跨刷新累计，不能作为当前 SSE；20 秒以上无新增、正式 TCP upper bound 3（含 keepalive，pr9GenericOutputDomTcpEvidence.json）以及最终服务 res.close 观察归零分别记录，不虚报精确当前订阅数。所有浏览器断言结束时外部／未知动作拦截尝试 0。

自有 Edge／helper已关闭，原profile保留，18999调试端口拒连；共享64979正式服务随后实际退出0，Express res.close activeStreamsAfterClose=0、原探针ConnectionRefused，root另独立确认两个端口ECONNREFUSED。证据 mediaOutputBrowserShutdown20261003.json／最终pr9GenericOutputSnapshotEvidence.json。正式服务在全生命周期阻止所有非自身loopback目标，实际外部派发0；matrix-ready尝试计数0及独立浏览器拦截尝试0分别记录，保留服务阶段没有另序列化最终尝试计数，不将其冒充额外测量。
