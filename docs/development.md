# 开发与构建

## 环境

- Node.js 24 或更新版本，Python 3.11+。
- Python 本地数值检查需要 NumPy；本地检查使用 `numpy==2.3.5`。
- 构建 Android 需要 JDK、Android SDK Platform 35、Build Tools 和 Eclipse ECJ；也可在 Android Studio 中配置相应环境。

依赖安装：

```bash
npm ci
npm ci --prefix android/web
python3 -m pip install numpy==2.3.5
```

## 管理端和界面

```bash
node scripts/build-artifact.mjs
npm run build --prefix android/web
```

`artifact.json` 包含内置管理程序、模式与模型配置。修改管理端或 Notebook 运行程序后重新生成，保证哈希和版本一致。纯官网改动不需要重新构建 APK。

## 本地检查

```bash
python3 scripts/verify-local.py
```

检查使用本地 fixture，不访问用户账户或申请 GPU；未模拟的 Node 外网请求会被拒绝。测试中包含本地 HTTP 服务，用于校验实际任务与回调行为。

## Android

仓库不提供官方签名私钥。开发者需创建并自行保管签名材料，放入被忽略的 `android/signing/` 目录，或调整 Gradle 签名配置。使用不同签名构建的 APK 不能覆盖官方 APK。

离线工具构建方式：

```bash
python3 android/scripts/build-apk.py \
  --platform /absolute/path/android.jar \
  --tools /absolute/path/android-build-tools \
  --ecj /absolute/path/ecj.jar
```

构建脚本使用本地 ECJ、aapt2、d8、zipalign 和 apksigner。Android SDK、ECJ、模型权重和私钥不包含在仓库中。工具参数是开发机路径，与最终用户的安装流程无关。

两组原生检查使用相同工具参数：

```bash
python3 scripts/test-java.py \
  --platform /absolute/path/android.jar \
  --tools /absolute/path/android-build-tools \
  --ecj /absolute/path/ecj.jar
```

## 官网

将签名 APK 放在 `android/kaggle-studio-android-0.3.0.apk`，再执行：

```bash
python3 scripts/build-publisher.py
node scripts/test-publisher.mjs
```

网站输出为 `publisher/build/`，发布 ZIP 输出在相邻的 `deliverables/`。上传包根目录有 `index.html`，包含 APK 下载、图标、隐私、使用说明及帮助页。无前端 CDN 或外部字体依赖。

如果已经创建 GitHub 仓库，用 `--repository-url https://github.com/OWNER/REPOSITORY` 设置真实源码链接；不填写时不显示猜测的 GitHub 链接。
