# Agnes 本地视频供应商

供应商 ID：`agnesLocalVideo`，版本：`1.1.1`，模型：`agnes-video-2.5-flash`。

## 安装与配置

本次初版通过运行中 Toonflow 的 `POST /api/providers/media/add` 安装，后续仅在源码哈希一致时更新本任务自己的 `data/providers/agnesLocalVideo.ts`。现有 `agnesAdapterVideo.ts`、`chatgpt2api.ts`、`tfRouter.ts` 均保留。旧 Agnes 供应商使用另一套 8787 协议，不可拿它代替本供应商。

在 Toonflow「设置 → 媒体模型」刷新供应商列表，编辑「Agnes 本地适配器 · Flash」：

1. `baseUrl` 填写 `http://127.0.0.1:8788`，或 Toonflow 服务端可以访问的适配器地址；支持根地址或末尾 `/v1`，实际请求会统一到服务根地址。Tailscale 客户端地址应满足适配器自己的访问配置；不在此供应商中修改网络设置。
2. `apiKey` 填写用户持有的 Agnes 适配器独立代理 Key。不要填写 Agnes 平台 Key 或管理员密码。代理 Key 没有自动导出或代填，也没有创建新凭据。
3. 视频节点选择此供应商和 Flash 模型。文字模式默认 5 秒、720p、16:9；允许 4–12 整数秒与 21:9、16:9、4:3、1:1、3:4、9:16。

供应商源码、内置添加入口及地址编辑 UI 在独立分支开发并安全同步到当前运行主目录。同步前确认没有活跃媒体任务或运行 Agent、目标文件未被用户修改；保留原有 router.ts/components.d.ts 修改。Bun 监听在同步时退出，已在原 toonflow:server 窗格恢复原 `bun run dev`，server/web 均继续由 psmux 管理。未合并或发布远程。

## 接口与恢复

- 创建：独立 Bearer Key 鉴权的 `POST /v1/videos`，使用普通 2.5 的参数结构，Flash 限制为 `size=720P`。`seconds` 映射为字符串；`ratio` 映射 `aspect_ratio`；`resolution` 映射 `size`。额外参数只允许精确整数 `seed`，`n=1`。
- 模式：`text` → `text`；单图、必需首尾帧、可选首/尾帧 → `keyframe`；图片/音频参考数组 → `reference`，顺序保留，提示词中使用 `<Picture N>` / `<Audio N>`。最多 5 张图片、3 段音频，不支持参考视频、静音开关、独立水印、宽高、帧率等字段。
- 提交必须返回有效 `video_id`。不能将 `id` 或 `task_id` 当查询 ID。未返回有效 ID、网络异常、5xx 或提交等待 300 秒，均不自动再次创建；在 Agnes 管理页按 `request_id` 或原任务核对。300 秒只限制本地等待，不证明远端已取消。
- 宿主持久化的 `remoteTaskId` 是 JSON 任务句柄：`["agnesLocalVideo",1,video_id,adapterOrigin,proxyKeyFingerprint]`。它保存远端 ID 及原适配器身份，不含 Key。不要手动改写。地址或 Key 发生变化时暂停查询，需恢复原配置；平台 Key 的原版本绑定由 Agnes 适配器负责。
- 续查：`GET /agnesapi?video_id=...&model_name=agnes-video-2.5-flash`，每次只查询原任务。排队/生成中映射 pending；completed 取顶层 `url`，不受 internal_status 或适配器缓存失败影响；failed 返回脱敏原因。未知状态和错误身份暂停查询。
- 供应商内部默认至少 10 秒再次查询。429 使用 `Retry-After` 秒数或 HTTP 日期退避；无头时 60 秒。宿主的 3 秒轮询不能使实际网络请求绕过这个退避。查询 401/403/404/409 等交给宿主暂停并保留原 ID；查询网络错误保留原任务。
- Agnes 查询 HTTP408 且顶层 `code=LOCAL_WAIT_EXPIRED` 表示适配器已停止本地 600 秒等待。供应商抛出 `retryable=false`，宿主记为 unknown 并停止自动轮询，保留原任务 ID、素材与请求，不视为上游取消/失败或重新生成。普通 HTTP408 不应用这一终止规则；管理页可单次核对原任务。
- 成片 URL 交给现有收取流程，下载失败保留结果快照；重试收取不重新生成。

## 画布本地图片与音频

已按 Agnes 提交 `c64faab` 的 `docs/16-proxy-upload-contract.md` 接入代理 Key 鉴权的 `POST /v1/uploads`。Toonflow 画布读取本地素材后得到 Base64，供应商先发布素材，再显式创建视频，不使用管理员 cookie 或密码。

请求严格使用 `{ kind: "image" | "audio", base64: "raw标准Base64" }`，Data URL 输入会先移除前缀；二进制转标准 Base64，公网 HTTPS URL 直接引用。HTTP201 返回 `{id,url,metadata}`，只将 url 映射到 first_frame/last_frame/images/audios，保持顺序。每个本地文件严格小于 15,000,000 字节，已知本地图片总量小于 50,000,000 字节，图片 MIME 仅 PNG/JPEG/WebP。尺寸每边 256–5760、音频 ffprobe 和 2–12 秒总时长、DNS/重定向及 R2 生命周期仍由适配器校验，不伪造元数据。

上传 401/400/413/415、R2 未配置 503 R2_NOT_CONFIGURED、发布失败 502 R2_UPLOAD_FAILED、无效成功响应或网络错误均停止，不创建视频、不自动重上传。已发布但未绑定任务的素材沿用适配器保留与清理策略。供应商不记录素材；宿主调试日志遮蔽 Base64、首尾帧、图片/音频字段和 X-Amz 签名链接。没有编辑 Agnes 目录。

## 已完成验证

遵守仓库禁止新增测试文件的要求，使用内联手动模拟及临时配置目录：

- 供应商包、server、web 类型检查；server/web 构建。
- Toonflow 真实 VM 加载器解析源码、模拟安装和配置默认值；运行中应用的实际安装、列表与只读 debug inspect。
- 六类模式请求交给 Agnes 真实 `normalizeRequest` 检查，全部通过；14 类非法参数/素材组合在网络前拒绝。
- 创建/排队/完成/失败、completed 优先于 internal_status、身份改变、HTTP 401/403/404/429/500、缺少 video_id、未知状态与提交网络不确定性。
- 最终源码与原版宿主配合，两个独立 Bun 进程模拟重启：第一次 POST 1 次并持久化 ID；重启 POST 0 次，只查询原 ID，429 的 4 秒退避得到遵守；无 ID 的中断任务为 unknown。
- 成片首次下载 503 后保留 collectionFailed 快照，再次收取完成，没有新增 POST 或任务查询。24 字节 MP4 头只是人工协议夹具，并非有效生成视频。
- 原供应商文件 SHA-256 与安装前相同，主工作区原有两个未提交改动未改变。
- 实际主目录 5173 页面显示供应商卡片、baseUrl 和密码型 API Key；节点使用的 `/api/ai/media/models` 返回 Flash 模型。页面未填凭据、未保存配置或点击生成。
- 本地素材单图/首尾帧/图片音频映射及上传失败守卫；使用 Agnes 真实 HTTP 处理器、内存鉴权夹具、实际 256×256 PNG 探测和模拟 R2/生成服务完成上传→创建→查询。真实上游调用 0 次，R2 未配置时上传/创建均为 0 次。
- 小 Base64 与媒体字段、签名链接在宿主调试日志中隐藏。
- HTTP408 / LOCAL_WAIT_EXPIRED：供应商异步和同步入口各仅创建/查询一次即停止；宿主记为 unknown 并保留原 video_id，等待超过通用重试间隔及同一幂等请求均不增加网络调用；独立进程重启后网络调用为 0。普通408仍可重试，已缓存 completed 结果不受名额释放影响。证据为本任务工作区 `waitExpiredEvidence.json`。
- 对 Agnes 已部署提交 `23b37bd` 的真实 HTTP 处理器和查询服务使用隔离任务、内存代理鉴权与模拟截止时间验证：HTTP408 顶层 LOCAL_WAIT_EXPIRED/detail/原 request_id，无 Retry-After；供应商和宿主停止等待、保留原 ID，缓存 completed 仍可读取。POST、真实上游、hi、媒体调用均为 0，停止后不再轮询。证据 `deployedWaitContractEvidence.json`；运行服务 `/healthz` 为 ok/configured。未修改生产任务或凭据。

未执行真实视频/文字生成、真实 R2 上传、用户凭据鉴权、真实下载、桌面 native 验证或 Tailscale 远程连通测试。没有改 OS 网络/安全设置或操作远程 Git。此前 Agnes 的 NO_KEY_CAPACITY 已诊断为旧 unknown 占并发名额；供应商保留返回原因与追踪号，没有释放这些任务或重新提交真实生成。

父线程已确认 Agnes 查询超时契约及部署提交 `23b37bd`，源码 `src/service.mjs`、`src/server.mjs` 和 `docs/18-wait-health-policy.md`、`docs/19-wait-health-verification.md` 与之相符。供应商对该响应停止等待的回归及真实处理器隔离验证均通过，不操作生产适配器的名额或 Key，也不自行执行 hi。供应商现有 unknown、身份变化、查询错误和 failed 路径均不会重新提交视频；300 秒仍仅是供应商单次提交 HTTP 等待上限，不代表取消远端任务。Agnes 的生产迁移由父线程完成并确认；本任务没有触发实际模型或云存储调用。
