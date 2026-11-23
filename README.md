<p align="center"><img src="publisher/public/logo.png" width="80" alt="Kaggle Studio"></p>
<h1 align="center">Kaggle Studio</h1>
<p align="center"><a href="README.md" lang="zh-CN">中文</a> · <a href="README.en.md" lang="en">English</a> · <a href="README.fr.md" lang="fr">Français</a> · <a href="README.ru.md" lang="ru">Русский</a> · <a href="README.es.md" lang="es">Español</a> · <a href="README.ar.md" lang="ar" dir="rtl">العربية</a></p>
<p align="center">模型切换与启停，手机上就能搞定。</p>
<p align="center"><a href="https://studio.entropy1221.cc.cd">官网与安卓下载</a> · <a href="docs/development.md">开发与构建</a></p>

把自己的文字、图片和视频模型连接到一个 Android 应用。通过 Cloudflare 授权和 Kaggle API Token，读取已有项目或自动准备个人部署，在手机里对话、拍照提问与创作。

## 手机就是模型控制台

- **切换模型，选择即可**：在模型列表里选择已部署的文字、图片或视频模型，Studio 处理原会话结束及目标模型加载。
- **需要时，手机上开启**：在算力页启动 Kaggle GPU 会话，直接查看模型加载状态。
- **离开电脑，也能停止**：在手机请求停止并查看会话结束状态，不必回到电脑前，也不需要远程桌面或命令行。

切换不是即时完成：需要等待 Kaggle 确认原会话结束，再加载所选模型，每次运行一个 GPU 模型。

## 可以做什么

| 场景 | 功能 |
|---|---|
| 对话 | 连接 GGUF 文字模型、长对话、数学公式排版；兼容视觉模型可拍照或上传图片提问 |
| 图像 | SDXL、Z-Image 模型配置；文字生成图片与参考图创作 |
| 视频 | Wan 系列模型配置；文字生成视频，兼容模型支持图片生成视频 |
| 多模型 | 同一套部署保存多个模型配置，等待当前会话结束后切换；每次运行一个 GPU 模型 |
| 个人部署 | 自动配置 Worker、D1、私有 Tunnel、VPC 服务与模型连接，管理端使用个人 workers.dev 地址 |
| 管理 | 复用已有项目、仅更新管理程序、更新 Token 与模型、移除设备授权、删除选定部署 |

模型能力和显存需求不同。完成部署不代表某一模型一定能在某次 GPU 会话中成功推理。GPU 资格、手机号验证、额度和可用性由 Kaggle 决定；本项目不汇集用户的 GPU 配额。

## 开始使用

1. 从 [官网](https://studio.entropy1221.cc.cd) 下载 APK，安装到 Android 8.0 或更新系统。
2. 登录并授权自己的 Cloudflare 账户。
3. 填写自己的 Kaggle API Token；所需手机号验证在 Kaggle 完成。
4. 选择模型，连接已有部署或创建自己的部署。
5. 部署完成后进入 Studio，在算力页启动会话，等待模型就绪。

使用官方 APK 不需要创建 OAuth 客户端或自备域名。资源保存在用户自己的账户中；聊天历史和媒体保存在设备上。

说明文档提供中、英、法、俄、西、阿六种语言；详细技术指南目前以中文为主，README 翻译不增加应用界面语言。

## 结构

```text
android/        Android 原生容器、加密存储、网络桥接与 React 界面
manager/        Cloudflare 管理端、数据库与 Kaggle 运行程序
shared/         模型配置、上下文与 Notebook 身份校验
publisher/      官网静态素材与页面模板
scripts/        构建、验证与网站打包
tests/         安装、授权、恢复与界面流程检查
```

见 [架构与连接协议](docs/architecture.md)、[开发与构建](docs/development.md)、[网站与发布](docs/publishing.md)。

## 凭据与资源

- 安装阶段使用 Cloudflare PKCE 授权；Kaggle Token 写入用户自己 Worker 的 Secret。
- 日常请求使用设备密钥；移除本设备授权不会删除其他设备或更换原始服务密钥。
- “仅修复管理程序”更新现有 Worker，保留原 Notebook、模型配置、运行记录和密钥。
- 删除部署需要核对资源归属和准确名称；卸载应用不会自动停止 GPU 或删除云资源。
- 本仓库不包含签名私钥、个人 Token、用户数据库、运行日志或模型权重。发布者 OAuth Client ID 是公开应用标识，不是账户密钥。

## 验证与模型限制

本地检查覆盖授权恢复、原项目复用、停止状态、设备凭据删除、后台任务、公式显示与界面交互。图片与视频管线也有参数和数值异常检查，但没有把模拟测试当作真实 T4 性能或画质测试。请在实际硬件上验证所选模型的加载、显存、参考图效果及连续运行。

模型权重由各自发布方提供，使用时遵守对应许可。第三方组件声明见 [third-party-notices.txt](android/web/public/third-party-notices.txt)。

独立项目，与 Cloudflare、Kaggle、Google 或模型发布者无隶属或官方背书关系。
