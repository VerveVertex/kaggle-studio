# 网站与发布

## Cloudflare Pages

1. 使用 `scripts/build-publisher.py` 生成静态站点和上传 ZIP。
2. 在已有官网 Pages 项目选择创建部署、生产环境，上传 ZIP。
3. 核对首页下载、图标及隐私、使用说明页面可访问。

网站仅介绍与分发应用，不保存用户密码或代替用户的模型服务。不要将用户管理 Worker、数据库或密钥上传为官网静态文件。

## OAuth

官方 APK 使用发布者统一注册的 Cloudflare 客户端，用户只授权自己的账户。公开注册需要发布者完成 Client URL 域名验证并将 OAuth 客户端设为 Public。发布者需要保留准确的回调、权限和图标信息。

开发者若 fork 并以不同发布者身份分发，应注册自己的 OAuth 应用、网站和隐私说明，再调整 `android/web/src/setup/publisher.json`；不要把其他软件的 Client ID 或 client secret 冒充自己的应用。PKCE 原生应用不嵌入 client secret。

安装权限覆盖 Worker、D1、Tunnel 和 VPC 服务。Kaggle 使用用户自己的 API Token，无需每位用户注册 Kaggle OAuth 客户端。

## 安装包与源码

推荐把签名 APK 和网站上传 ZIP 放入 GitHub Release；源代码放入仓库。签名密钥、个人 Token、运行数据库、日志和模型权重都不提交。用户凭据不进入 Release 或网站。

没有作者提供的签名私钥时，开发者自行签名；不要把 fork 构建宣称为能覆盖官方 APK 的更新。

公开发布后仍需要使用非发布者账户验证授权、读取既有项目、新建部署与实际模型运行。模拟检查不代替真实 GPU 验证。
