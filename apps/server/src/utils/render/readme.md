# 独立导演渲染接线

`createRenderer({ entryPath, browserPath?, createFfmpeg }).execute(input, context)` 实现共享 `RenderJobInput` / `RenderJobResult`。输入是固定场景、方案、相机与时间；`context.directory` 必须是核心为本次任务创建的暂存目录，不能传工作区根目录。`reportProgress` 使用 0～1。结果文件相对于该暂存目录，发布到工作区和创建媒体节点由核心完成。

核心应注册 `render` 作业，注入现有 `createWorkspaceFfmpeg`。取消信号来自持久作业，不能绑定 HTTP、SSE 或用户网页。每次执行使用独立 Chromium profile、随机 loopback 服务/CDP 端口，按 `frameIndex / frameRate` 调用原场景、动作与相机算法，渲染完关闭浏览器，再用原 FFmpeg 工厂编码。图片不需要 FFmpeg。

导演包构建另生成 `build/nodes/director3dNode.render.js`。核心须将它作为服务器渲染资源部署，注册时传已固定版本的路径；作业恢复版本应包含此 artifact 的哈希，不可让旧任务自动使用新版。UMD 与 `.node.js` 的配对仍由共享插件构建器生成，本包不重复实现加载或注册协议。

导演后端还提交 `directorDraft` 自定义作业。`@toonflow/node-director3d/backend` 导出 `directorDraftInputSchema` 和 `generateDirectorDraft(input, model, stream, signal)`；核心用现有配置和 `streamAi` 注入模型/流。参考输入已经按统一节点值校验并固定到任务请求，媒体参考须在任务受理阶段复制到不可变暂存资源，再由现有 `readAiReferences` 解析。返回 `{ document, modelPath, expectedRevision, selectedPlanId, basePlanId }`，核心按原文件 revision 做 CAS，成功后更新节点 `modelRevision`/方案选择；发生冲突保留草稿供核对，不重做模型调用。此作业的恢复模式应为 `review`。

集成还需在 server 包声明已有工作区依赖 `@toonflow/node-director3d`，更新锁文件，并确认 NodeExecution SDK 已包含包 A 的 `useNodeExecution`、`createExecutionClient`。导演节点只发送命令和读取任务，不在卸载时取消后端作业。

已在临时目录用合成方块完成 PNG、3 帧 MP4 解码和取消清理验证。尚未运行真实项目、模型生成、完整持久任务恢复或真实操作系统/手机锁屏验证。本机 PATH 的 FFmpeg 可编码，但没有 ffprobe；现有生产 FFmpeg 工厂要求两者，集成时须使用现有合法配置或补齐可执行依赖，不能将本轮直接注入 FFmpeg 的小样例当作生产配置已就绪。
