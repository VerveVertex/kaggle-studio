# 架构与连接协议

Android 应用在设备上保存对话、媒体和加密的设备凭据。安装时通过系统浏览器完成 Cloudflare PKCE 授权，再验证用户填写的 Kaggle API Token。

安装器准备一套归属于选定账户的 Worker、D1、Tunnel 和 VPC 服务。项目身份由 Worker 绑定与 D1 安装记录共同核对，不仅凭名称认领。Kaggle Notebook 由其真实标识、运行凭据和配置核对复用。

日常连接分为管理端根地址与统一模型地址：

| 连接 | 用途 |
|---|---|
| `https://<worker>.<account>.workers.dev` | 状态、模型选择、GPU 启停、设备授权与诊断 |
| `https://<worker>.<account>.workers.dev/v1` | 文字、图片、视频模型的统一私有代理 |

文字可使用 OpenAI 兼容的 `/chat/completions`。应用内的大输入和媒体使用后台任务协议：`/chat/jobs`、`/media/jobs`，以固定任务 ID 查询状态、读取结果并取消任务，避免连接丢失后重复生成。图片、视频后台任务并不表示对任意第三方视频 API 的通用兼容。

手动配置的外部图像 API 使用 `/images/generations`；外部视频覆盖项采用 H3 网关协议。它们折叠在连接设置中，不会把统一服务地址错误复制为 H3 地址。

运行时每次加载一个 GPU 模型。切换时先请求停止并等待 Kaggle 确认结束，再在原 Notebook 启动目标配置。端点失联不能当作会话已结束，也不能直接释放 GPU 运行记录。

“仅修复管理程序”只更新 Worker 代码并验证结果，保留原 Notebook、原始 Secret、配置及运行锁。需要运行端更新时，在下一次会话启动生效。

设备授权删除只删除当前设备记录。整套删除需要核对安装归属，并移除该套部署的 Notebook、Worker、D1、Tunnel、VPC 和设备授权，不撤销原始 Kaggle Token 或删除其他项目。
