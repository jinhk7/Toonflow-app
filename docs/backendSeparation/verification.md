# 隔离开发验证记录

工作树：`C:\Users\jinhk\AppData\Local\Temp\toonflowBackendSeparation20261002`，分支 `feat/backendSeparation`。原项目与生产数据、服务均未用于验证。

## 已完成

- Server TypeScript 完整检查通过；路由由原 `src/core.ts` 生成。
- MCP 构建通过；Server Bun 编译通过，2748 模块、约 9.62 MB。标准 `bun run build` 在本机嵌套 Bun 启动时报 `Operation not permitted`；本次使用实际 Bun 可执行文件执行同一 MCP 构建入口和 Server 编译命令。尚未将完整分发打包声明为通过。
- 真实隔离 HTTP 16 项检查通过：无 UI 连接创建画布和节点、节点输出、幂等重复/不同输入 409、断开事件订阅后继续执行、旧版本冲突、图快照 cursor、旧协议 428、文本唯一正文及派生输入固定。过程中发现并修正无关损坏 JSON 阻止画布列举、Bun 产物内置模块名称规范化导致加载器误拒绝。三轮临时项目与随机端口服务均已关闭、清理。
- 持久作业隔离 DB/HTTP：规范化 JSON 幂等、重复命令、断开 NDJSON 不取消、显式取消、事件游标、通知故障补发、项目目录删除后历史读取通过。两进程验证 safe 恢复、review 待核对、handler revision 改变待核对、FFmpeg 历史终态通过；未实际调用 FFmpeg。
- 插件注册/安装 21 项隔离核验通过：动态第三方能力、旧 UMD 迁移状态、真实 handler 来源、PR7 编辑信任边界、配对不符拒绝、第二个产物失败回滚、升级/禁用后的旧 revision 固定与跨进程恢复。
- Agent 隔离核验通过：完整输入 receipt、稳定会话工具 ID、动态同名 server 工具保持原参数并仍走审批、会话正文与 cursor 同边界、完成 run 游标、A2A 重启待核对且取消旧协议问题。
- 正文 CAS 隔离核验通过：空文件首次建立、完成命令重试不覆盖后续正文、并发仅一写成功、写后通知故障保留 written intent、恢复仅补通知、受管父目录保护、普通媒体目录仍可操作。
- MCP 隔离核验通过：无网页及陈旧 connectionId 的业务画布、正文 revision/CAS、raw binary 与父目录保护、普通文件操作；UI 导航仍要求页面连接。

## 集成中

- 六个普通节点、网页/手机 UI、3D 后台渲染工作包尚需统一集成和验证。
- Vue 检查须使用 Node 启动 vue-tsc；本机直接用 Bun 启动 vue-tsc 未纳入 `.vue`，不能算 Vue 检查通过。
- 桌面启动已在 createApp 后、监听前初始化执行宿主。桌面类型检查受本机缺少 `.hutch` Electrobun SDK 阻塞；未启动原生桌面验证最后窗口关闭行为。
- 未调用真实模型、媒体供应商或 R2；未进行真实 Tailscale、物理锁屏、生产部署或 PR/推送。

未新增任何测试代码文件。上述核验均为临时目录内的 inline 执行或既有类型/构建入口。
