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

同 Astra 对 ddd56e5 的复审中，其余七项及保存时序、草稿原子清理、取消 loading 均通过，模型字段映射仍有一项 P2。前一轮 vendor/engine fixture 同时改写了模型记录字段，遗漏宿主标准返回值。本轮严格保留原输入 models=[{providerId:"p",modelId:"m1",sizes:["512"]},{providerId:"p",modelId:"m2",sizes:["1024"]}]，只将表单映射设为 vendor/engine、providerField="vendor"。完整 Vue SFC 与原服务端 validator/Zod 验证确认两个非 null 模型选项、原尺寸 512 回填、切换 m2 清除旧尺寸、选择 1024 后参数为 {vendor:"p",engine:"m2",size:"1024"}；原模型记录前后完全一致。标准内置字段、导演组合模型字段及旧自定义记录兼容验证也通过。390×844 真实 Edge 原生下拉及保存操作得到同样结果，捕获完整 CanvasCommand 并通过原 Zod；无网络错误或真实供应商请求，独立标签已关闭。证据见 mobileModelStandardRecordFixEvidence.json、mobileModelStandardRecordFix.png。此项 DOM 的元数据、读取响应和保存回执为定向合成响应，不代表真实第三方后端保存。PR9 保持 draft，待同 Astra 对新提交复验后继续既定审查流程。
