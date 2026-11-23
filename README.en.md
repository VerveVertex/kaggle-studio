<p align="center"><img src="publisher/public/logo.png" width="80" alt="Kaggle Studio"></p>
<h1 align="center">Kaggle Studio</h1>
<p align="center"><a href="README.md" lang="zh-CN">中文</a> · <a href="README.en.md" lang="en">English</a> · <a href="README.fr.md" lang="fr">Français</a> · <a href="README.ru.md" lang="ru">Русский</a> · <a href="README.es.md" lang="es">Español</a> · <a href="README.ar.md" lang="ar" dir="rtl">العربية</a></p>
<p align="center">Switch models. Start and stop sessions. From your phone.</p>

Connect your own chat, image and video models in one Android app. Authorize Cloudflare and enter your Kaggle API Token to find an existing installation or prepare a personal deployment.

## Your phone is the control panel

- **Switch by choosing a model:** select a deployed chat, image or video model from the list. Studio handles the previous session ending and the selected model loading.
- **Start when you need GPU compute:** start a Kaggle GPU session from Compute and follow its loading status in the app.
- **Stop even when you are away:** request stop from your phone and check when Kaggle confirms that the session has ended. Daily management needs no computer, remote desktop or command line.

Switching is not instantaneous: Studio waits for the previous session to end, then loads the selected model. One GPU model runs at a time.

## Capabilities

| Area | Features |
|---|---|
| Chat | GGUF chat models, longer conversations and mathematical typesetting; compatible vision models accept photos and image questions |
| Images | SDXL and Z-Image profiles; text-to-image and reference-image workflows |
| Video | Wan profiles; text-to-video and image-to-video with compatible models |
| Personal deployment | Worker, D1, private Tunnel and VPC service in your Cloudflare account, using your own workers.dev address |
| Management | Reuse an existing installation, repair manager code, update tokens and models, remove a device authorization or delete a verified deployment |

## Get started

1. Download the APK from the [website](https://studio.entropy1221.cc.cd) and install it on Android 8.0 or later.
2. Sign in to Cloudflare and authorize your own account.
3. Enter your Kaggle API Token. Complete any required phone verification on Kaggle.
4. Choose models and connect an existing installation or create your own deployment.
5. After deployment, enter Studio, start a session in Compute and wait for the model to become ready.

The official APK does not require each user to register an OAuth client or own a custom domain. Cloud resources stay in the user's accounts; chat history and media stay on the device.

## Repository

| Directory | Contents |
|---|---|
| `android/` | Native Android container, encrypted storage, network bridge and React interface |
| `manager/` | Cloudflare manager, database schemas and Kaggle runtime |
| `shared/` | Model profiles, context settings and Notebook identity checks |
| `publisher/` | Website assets and page template |
| `scripts/`, `tests/` | Build tools and local checks |

See [architecture](docs/architecture.md), [development](docs/development.md) and [publishing](docs/publishing.md). Detailed technical guides are currently in Chinese. README translations do not add interface languages to the app.

## Credentials and resources

- Cloudflare setup uses PKCE. The Kaggle Token is stored as a Secret in your own Worker; daily requests use device keys.
- Removing one device's authorization does not remove other devices or rotate original service keys.
- **Repair manager program only** updates the existing Worker and preserves the Notebook, configuration, run records and secrets.
- Deleting a deployment requires ownership and exact-name checks. Uninstalling the app does not stop GPU sessions or delete cloud resources.
- This repository excludes signing keys, personal tokens, user databases, runtime logs and model weights. The publisher's OAuth Client ID is a public application identifier, not an account secret.

## Validation and model limits

Kaggle controls GPU eligibility, phone verification, quota and availability. Model features and memory requirements vary. A completed deployment does not guarantee successful inference.

Local checks cover authorization recovery, installation reuse, stop state, device authorization deletion, background tasks, math rendering and interface flows. Image and video checks include parameters and invalid numeric outputs. Simulated tests do not establish real T4 image quality, memory fit or runtime performance; validate those on the hardware you use.

Model weights and runtime dependencies retain their respective licenses. See [third-party notices](android/web/public/third-party-notices.txt).

Independent project; not affiliated with or endorsed by Cloudflare, Kaggle, Google or model publishers.
