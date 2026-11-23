#!/usr/bin/env python3
"""Package the public download site without credentials or account resources."""
from pathlib import Path
from html import escape as esc
import json,shutil,hashlib,zipfile,argparse
parser=argparse.ArgumentParser()
parser.add_argument("--repository-url",default="")
parser.add_argument("--output",default="")
args=parser.parse_args()
repository=args.repository_url
if repository:
 from urllib.parse import urlparse
 u=urlparse(repository)
 if u.scheme!="https" or u.netloc!="github.com" or u.query or u.fragment or len(u.path.strip("/").split("/"))!=2:raise SystemExit("Use an exact public GitHub repository URL.")
root=Path(__file__).resolve().parents[1]
version='0.3.0'
apk=root/'android'/f'kaggle-studio-android-{version}.apk'
if not apk.is_file():raise SystemExit('Build the signed APK first.')
site=root/'publisher/build'
shutil.rmtree(site,ignore_errors=True);shutil.copytree(root/'publisher/public',site)
(site/'downloads').mkdir();shutil.copy2(apk,site/'downloads'/apk.name)
def txt(en,zh,tag='p',cls=''):
 return f'<{tag}'+(f' class="{cls}"' if cls else '')+f' data-en="{esc(en,quote=True)}" data-zh="{esc(zh,quote=True)}">{esc(en)}</{tag}>'
def page(name,title,body):
 links=''.join('<a href="'+path+'" data-en="'+en+'" data-zh="'+zh+'">'+en+'</a>' for path,en,zh in [('/privacy.html','Privacy','隐私'),('/terms.html','Usage terms','使用说明'),('/help.html','Help & deletion','帮助与删除')])
 source_link=('<a href="'+esc(repository,quote=True)+'" target="_blank" rel="noreferrer">GitHub</a>') if repository else ''
 header='<header class="site-header"><div class="wrap nav-wrap"><a class="brand" href="/"><img src="/icon.svg" width="32" height="32" alt="">Kaggle Studio</a><nav class="site-nav"><a href="/#experience" data-en="Explore" data-zh="探索">探索</a><a href="/#your-cloud" data-en="Your cloud" data-zh="自己的云端">自己的云端</a><a href="/#start" data-en="Get started" data-zh="开始使用">开始使用</a>'+source_link+'</nav><div class="header-actions"><button id="language" aria-label="Switch language">English</button><a class="header-download" href="/downloads/'+apk.name+'" download data-en="Download app" data-zh="下载应用">下载应用</a></div></div></header>'
 footer='<footer class="site-footer"><div class="wrap"><div class="footer-main"><span>Kaggle Studio</span><nav>'+source_link+links+'</nav></div>'+txt('Independent project. Not affiliated with Cloudflare, Kaggle, Google or model publishers.','独立项目，与 Cloudflare、Kaggle、Google 及模型发布者无隶属关系。','div','footer-fine')+'</div></footer>'
 (site/name).write_text('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Kaggle Studio：在手机上切换模型、启动和停止 Kaggle GPU 会话，离开电脑也能管理自己的模型。"><meta name="theme-color" content="#101216"><meta property="og:type" content="website"><meta property="og:title" content="Kaggle Studio"><meta property="og:description" content="模型切换与启停，手机上就能搞定。"><meta property="og:image" content="https://studio.entropy1221.cc.cd/logo.png"><title>'+esc(title)+' · Kaggle Studio</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/style.css"><script src="/language.js" defer></script><script src="/showcase.js" defer></script></head><body>'+header+'<main'+(' class="document wrap"' if name!='index.html' else '')+'>'+body+'</main>'+footer+'</body></html>',encoding='utf-8')
body=(site/'home.html').read_text()
source_link=('<a class="button ghost" href="'+esc(repository,quote=True)+'" target="_blank" rel="noreferrer">GitHub</a>') if repository else ''
body=body.replace('__SOURCE_LINK__',source_link)
page('index.html','你的模型创作空间',body)
(site/'home.html').unlink()
body=txt('Privacy & data','隐私与数据','h1')
for a,b,c,d in [
 ('This website','本网站','This static website has no sign-in form, advertising or analytics scripts. It stores your language preference locally. Cloudflare may process technical hosting requests under its own policies.','本静态网站没有登录表单、广告或统计脚本，仅在浏览器本地保存语言选择。Cloudflare 可能依据其政策处理托管请求。'),
 ('Account authorization','账户授权','Cloudflare sign-in opens the system browser using PKCE. Studio uses your authorization to manage the selected account’s Worker, D1, Tunnel and VPC service. Your Kaggle token is verified with Kaggle and stored encrypted on your device during setup, then as a Secret in your own Worker. Neither account passwords nor personal service keys are published on this website or in the APK.','Cloudflare 授权通过系统浏览器和 PKCE 完成，用于管理所选账户的 Worker、D1、Tunnel 和 VPC 服务。Kaggle Token 通过 Kaggle 校验，设置期间在设备上加密保存，随后作为 Secret 写入你自己的 Worker。账户密码和个人服务密钥不会发布到本网站或 APK 中。'),
 ('Device credentials','设备凭据','Device keys use Android Keystore encryption. Setup grants are cleaned up after successful connection. Removing one device authorization does not delete other devices or rotate the original server keys.','设备凭据通过 Android Keystore 加密。连接完成后清理设置授权凭据。移除单台设备授权不会删除其他设备或更换服务器原始密钥。'),
 ('Chats and media','对话与媒体','Chats and imported or generated media are stored on your device. Requests and attachments pass to your configured model services. Cloudflare, Kaggle and model hosts may process requests under their own policies; this website does not receive your chat history.','聊天和导入、生成的媒体保存在设备上。请求与附件发送至你配置的模型服务。Cloudflare、Kaggle 和模型托管方可能依据自身政策处理请求；本网站不接收聊天记录。'),
 ('Deletion','删除','Clear service keys removes this device’s paired cloud authorization before clearing local keys. Local history deletion removes local chats and media. Delete deployment removes only the selected installation’s verified resources, notebooks, Secrets and device records. It does not revoke your original Kaggle token or delete unrelated projects. Uninstalling the app does not automatically stop GPU sessions or remove cloud resources.','清除服务密钥会先删除此设备绑定的云端授权，再清除本地密钥。删除本地记录会删除设备上的聊天和媒体。删除整套部署仅移除经核实的所选云资源、Notebook、Secret 及设备记录，不撤销原始 Kaggle Token 或删除无关项目。卸载应用不会自动停止 GPU 或删除云资源。')]:body+=txt(a,b,'h2')+txt(c,d)
page('privacy.html','Privacy',body)
body=txt('Usage terms','使用说明','h1')
for a,b,c,d in [
 ('Your accounts','你的账户','Use accounts and data you are authorized to manage. Account registration, phone verification, GPU quota and service availability are controlled by the providers. Follow their terms and each model’s license.','请使用有权管理的账户和数据。账户注册、手机号验证、GPU 配额和服务可用性由对应平台控制，请遵守其条款与各模型许可。'),
 ('Resources','资源','Each user deploys into their own account. Resources remain subject to provider limits and charges. Studio does not pool GPU quota or promise permanently free service.','每位用户部署到自己的账户，资源受平台限额和计费规则约束。Studio 不汇集 GPU 配额，也不承诺永久免费。'),
 ('Models','模型','Output quality, speed, long-context accuracy and memory needs depend on the model and hardware. Large models and image/video generation may require more memory than a particular session offers. A completed deployment is not a guarantee of successful inference.','输出质量、速度、长上下文准确率和显存需求取决于模型与硬件。大模型及图片、视频生成可能超过某次会话可用内存；部署完成不代表每次推理都能成功。'),
 ('Stopping and deletion','停止与删除','A stop request must be confirmed by Kaggle. Confirm the actual session has ended before manually releasing a record. Deleting a deployment affects every device connected to it and cannot be undone.','停止请求需由 Kaggle 确认。手动解除记录前，请核实实际会话已经结束。删除整套部署影响连接该部署的所有设备，且无法撤销。')]:body+=txt(a,b,'h2')+txt(c,d)
page('terms.html','Usage terms',body)
body=txt('Help & deletion','帮助与删除','h1')
for a,b,c,d in [
 ('Connect an existing project','连接已有项目','Authorize Cloudflare, enter your Kaggle Token and choose the existing installation detected by Studio. This connects your device without creating another notebook.','授权 Cloudflare、填写 Kaggle Token 后，选择自动读取到的已有部署连接设备，无需另建 Notebook。'),
 ('Repair the manager','修复管理程序','Settings → Connections → Manage deployment → authorize the owning Cloudflare account → Repair manager program only. This changes Worker code and keeps the existing notebook, model settings and secrets.','设置 → 连接 → 管理部署 → 授权所属 Cloudflare 账户 → 仅修复管理程序。此操作更新 Worker 代码，保留原 Notebook、模型配置及密钥。'),
 ('Remove this device','移除本设备','Settings → Data → Clear service keys. Remote device authorization is removed before local keys are cleared. A running GPU session is not stopped by disconnecting a device.','设置 → 数据 → 清除服务密钥。先移除本设备的云端授权，再清除本地密钥；不会因此停止正在运行的 GPU。'),
 ('Delete a deployment','删除整套部署','Stop its Kaggle session, open Manage deployment, authorize the owning account, verify the installation and choose Delete deployment. Enter the exact deployment name to confirm.','先停止 Kaggle 会话，打开“管理部署”，授权所属账户并核对项目，选择“删除整套部署”，输入准确名称确认。'),
 ('Authorization unavailable','无法授权','If Cloudflare says the Studio application is private, the publisher must finish its Public visibility setting. Users do not need to create replacement OAuth clients. Account administrators may also restrict public application access.','如果 Cloudflare 提示应用为私有，需要发布者完成 Public 设置；用户无需另建 OAuth 客户端。账户管理员也可能限制公共应用访问。'),
 ('Connection errors','连接错误','Use Compute → Check connection diagnostics. Confirm the model is ready and inspect its Kaggle logs. Share the redacted report; do not share account tokens, passwords or API keys.','在算力页查看连接诊断，核实模型已就绪，并检查 Kaggle 日志。反馈时提供脱敏诊断，不要发送账户 Token、密码或 API 密钥。')]:body+=txt(a,b,'h2')+txt(c,d)
page('help.html','Help',body)
(site/'_redirects').write_text('/preview.html /help.html 301\n')
sha=hashlib.sha256(apk.read_bytes()).hexdigest()
(site/'release.json').write_text(json.dumps({'version':version,'apk':'/downloads/'+apk.name,'apk_sha256':sha,'oauth_client_id':'235e65c822ab84b9ee6439a025193c76','oauth_visibility_required':'public'},indent=2)+'\n')
out=Path(args.output) if args.output else root.parent/'deliverables'/'kaggle-studio-website.zip'
out.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in sorted(site.rglob('*')):
  if p.is_file():z.write(p,p.relative_to(site))
print('Publisher package:',out,'files:',sum(p.is_file() for p in site.rglob('*')),'APK SHA256:',sha)
