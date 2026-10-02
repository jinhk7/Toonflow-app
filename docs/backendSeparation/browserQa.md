# 隔离浏览器验收（2026-10-02）

本轮在 `62d650c` 之后进行实际 DOM 验证，使用本机 Edge 154 headless、原生 DevTools 协议、鼠标/键盘事件及正式 Web 构建。桌面视口 1440×960，手机视口 390×844。没有创建测试文件、安装浏览器依赖或关闭浏览器沙盒。

## 环境与数据

- 独立工作树：`C:\Users\jinhk\AppData\Local\Temp\toonflowBackendSeparation20261002`。
- 证据及全部合成配置、JSONL 会话、SQLite、工作区和浏览器配置：`C:\Users\jinhk\AppData\Local\Temp\toonflowDomQasTwi1u`。
- 正式 Express 应用和后台执行器使用临时目录，监听随机本机端口 `127.0.0.1:53219`，同源提供 `build/web`，未使用生产端口和真实用户配置。
- 会话、两层子 Agent 提问、暂停运行和可取消任务均为合成持久数据，没有模型生成。后台拒绝外网 fetch，模型供应商为空，遥测关闭。
- 隔离构建最初遗漏 `askUser` 产物，出现“该工具未提供可用的交互组件”。执行该工具原有构建并复制产物至临时 `data/tools` 后完成验证；没有修改其产品源码或重启生产服务。当前进程将这个新增产物标为非内置，因此此次提问 UI 验证不用于证明 PR7 来源审批。

## 实际完成的 DOM 操作

| 页面/场景 | 操作与结果 |
| --- | --- |
| 桌面首页及工作区 | 点击隔离项目，加载画布、两张卡片及主会话持久消息。 |
| 桌面文本 | 点击编辑、实际输入、关闭并重新打开；读取工作区文件确认保存。 |
| 断网正文 | 通过 CDP 模拟离线，实际输入保留草稿并显示“对账并重试原保存”；恢复网络后点击重试，原草稿成功落盘。 |
| 存储读取失败 | 仅对当前隔离浏览器的正文草稿键注入 Storage.getItem 异常，显示读取失败提示；解除故障后点击重试，恢复正文进入 DOM 并写入文件。这是故障注入，不是真实设备存储损坏。 |
| 桌面会话 | 主→子→孙→子→主实际点击导航；孙会话显示问题、选项、回答/跳过按钮。 |
| 手机入口 | 项目列表→工作区节点列表→Agent；主会话与桌面相同，390px 宽度无横向溢出。 |
| 手机共享会话 | 两层子会话导航更新 URL session；直接刷新恢复孙会话问题；模拟离线再恢复并重新加载，仍恢复原问题；点击跳过显示“已跳过”。 |
| 手机新建/历史 | 连续三次点击新建后历史列表只新增一个会话，再点击历史主会话恢复消息。 |
| 手机任务 | 打开实际任务列表；取消确认框选择继续执行保留任务，再确认取消，最终 DOM 显示 cancelled。 |
| 手机节点编辑 | 打开文本节点，选择“修改此节点的文本输出”，实际填写参数并执行，文件确认正文更新。此时浏览器已离开桌面画布，仅手机页和后台运行。 |
| 手机取消/返回 | 关闭新增节点弹层未创建节点；节点页返回工作区；关闭 Agent 返回工作区。 |

部分自动操作曾因弹层动画、加载遮罩、视口复原导致浮动 Agent 遮挡或等待了错误的消息文本而超时；核查 DOM 后重新执行相应操作。未将这些超时计为通过。屏幕截图必须与同目录 JSON 证据一起阅读，加载中的截图不代表最终状态。

## 本轮发现并修复的两个问题

1. 后端与 Vue Flow 的对象键顺序不同，前端用 `JSON.stringify` 直接比较，使空闲页面持续保存相同节点；文本初始化等待 flush，编辑按钮一直不可用。复用一个按 JSON 语义排序对象键的比较入口，应用于保存差异、回填及冲突比较，保留数组顺序和真实字段变化。
2. 命中节点组件缓存后，组件可能在画布路径暂时清空的装载阶段挂载，调用宿主时误报“节点未接入后端执行协议”。远程节点在画布绑定完成前保留加载态，然后才挂载组件。

修复后实际浏览器验证空闲写入为 0，缓存组件的手机/桌面往返三次均恢复可编辑状态。实际拖动节点从 `(120,120)` 到 `(160,144)` 成功落盘，随后 3.5 秒观察期内画布写入为 0，真实变化仍会保存。Web `vue-tsc --noEmit` 和正式生产 Vite 构建通过；构建仍有既有大 chunk 提示。没有新增依赖或自动检查入口。

## 证据

证据目录中的 JSON：`desktopSaveEvidence.json`、`storageRecoveryEvidence.json`、`desktopGrandQuestion.json`、`mobileAgentEvidence.json`、`mobileTaskEvidence.json`、`mobileTextEvidence.json`、`mobileNavigationEvidence.json`、`graphDomEvidence.json`。

主要截图：`desktopTextEdit.png`、`desktopOfflineDraft.png`、`desktopRecovered.png`、`desktopStorageWarning.png`、`desktopStorageRecovered.png`、`desktopGrandQuestion.png`、`mobileProjects.png`、`mobileWorkspace.png`、`mobileAgentRoot.png`、`mobileGrandQuestion.png`、`mobileQuestionSkipped.png`、`mobileTextNodeReady.png`、`desktopFinal.png`。

## 边界与交付状态

本轮证明了真实浏览器路由、持久内容和指定交互链路；不能据此声称真实模型调用、供应商生成、R2、Tailscale、手机物理锁屏、原生桌面窗口生命周期或完整安装包通过。断连恢复覆盖浏览器网络模拟与重新加载，不等于操作系统后台挂起验证。暂停的合成 Agent 没有恢复模型运行，因此跳过后的模型后续消息不在本轮范围。

最初重复保存产生了大量合成任务和历史事件，任务页/重放时出现数秒加载遮罩，最终能返回和取消；本轮未扩展为长历史性能优化。发布前应使用常规完整构建，包含全部工具产物；两项新增修复仍需父线程独立复审。不推送、不部署。
