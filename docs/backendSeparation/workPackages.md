# 并行包与集成规则

共享工作树：C:/Users/jinhk/AppData/Local/Temp/toonflowBackendSeparation20261002
集成分支：feat/backendSeparation
原主工作区只读。其他任务可从契约提交建立独立工作树/分支，再由核心 cherry-pick；如共享本工作树，严格遵守所有权且只提交自己的文件，不执行全目录 git add。

## 核心后端（集成负责人）

所有 apps/server 文件，除另行约定的 utils/render；packages/nodeScaffold/src/execution.ts、nodeScaffold/index.ts、nodeScaffold/package.json；共享工具 scaffold 契约；插件安装/构建/loader；命令与作业账本、后端 CanvasContext、Agent 接受和统一网关、受管文件CAS、媒体任务集成。自动生成路由仅核心统一执行。

## 包 A：统一桌面/手机 UI 与协议消费

所有权：apps/web（保留已有 Agnes 设置修改）；packages/nodeScaffold 的 Vue/runtime 客户端文件，除 execution.ts、index.ts、package.json。不修改 packages/nodes 的组件，以免和 B/C 冲突。
任务：共用 command/content/jobs 客户端；桌面 canvas 工具改调用后端；完整手机 Agent、显式项目/画布上下文、可靠接受后订阅、锁屏恢复和双端冲突。组件不再执行 canvasCall；节点 SDK UI 为后端快照/命令代理。节点参数表单从描述读取，不执行 UMD 发现 handles。
依赖：contracts.md/execution.ts；后端接口可先实现类型消费，不自行发明接口。
禁止：apps/server、providers、data、生产端口/psmux、共享契约、各节点包。不得覆盖已复制的 Agnes 设置更改。生成 components.d.ts 由集成统一处理。

## 包 B：六个现用节点迁移

所有权：packages/nodes/textNode、imageNode、videoNode、audioNode、imageGenerationNode、videoGenerationNode。可新增各自 src/backend.ts 并改其 Vue 为状态展示/命令调用，不写自定义服务器接口。
任务：迁移所有默认值/端口/actions/输入校验/生成状态/创建删除生命周期；文本正文CAS及文本生成用 runJob；生成节点沿用 media job语义；移除 watcher/onMounted 业务写入。不得用同名官方节点替代用户自定义执行。
依赖：NodeExecutionDefinition/Context、包A节点SDK客户端。新增动作与 job kind 先同步核心注册。
禁止：director3dNode、apps/server、scaffold共享文件、providers、data、自动生成文件。

## 包 C：director3d 与独立渲染

所有权：packages/nodes/director3dNode；apps/server/src/utils/render（仅渲染适配器，集成注册由核心）；独立临时PoC目录。
任务：先完成已启动的固定帧/WebGL/FFmpeg隔离验证；按 RenderJobInput/Result 交付 execute 函数；迁移导演JSON/plan/草稿Agent与模型文件提交，UI仅交互预览。保持当前无音轨导出能力，不额外增加音频功能。
依赖：作业注册/NodeExecutionContext。渲染不能加载完整工作区、注册canvas工具或写权威项目状态。
禁止：通用job账本/路由、协议、其他节点、providers、data、生产端口/psmux。

## 交付与验证

各包报告实际类型检查/构建/隔离手动验证、修改文件和本地提交。禁止测试文件及真实模型/视频/R2；临时服务独立命名和非生产端口，结束清理。集成负责人负责按契约接线、完整验收及最终可审查提交，不合并主分支或发布PR。
