# This script is submitted as a private Kaggle Python kernel by the manager.
# SETTINGS is safely injected by the Worker before this source. Never print secrets.
import glob
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import site
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

APPLICATION_UA = "KaggleGpuManager/0.1.3"
startup_phase = "manager bootstrap"


class NoCallbackRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


callback_opener = urllib.request.build_opener(NoCallbackRedirect())
processes = []
state = {"state": "starting", "url": ""}
started = time.monotonic()
last_contact = started
mutex = threading.Lock()


def report(bootstrap=False, probe=False):
    payload = {**state, "bootstrap": bootstrap, "probe": probe}
    req = urllib.request.Request(
        SETTINGS["manager_url"].rstrip("/") + "/agent/" + SETTINGS["run_id"],
        data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "User-Agent": APPLICATION_UA, "Authorization": "Bearer " + SETTINGS["run_token"]})
    try:
        with callback_opener.open(req, timeout=15) as response:
            try:
                data = json.load(response)
            except (ValueError, UnicodeError):
                raise RuntimeError("Manager callback returned non-JSON data") from None
            if not isinstance(data, dict):
                raise RuntimeError("Manager callback returned an unexpected JSON shape")
            return data
    except urllib.error.HTTPError as exc:
        # Only print status and narrowly selected diagnostic markers, never body,
        # request headers, redirect URL or temporary/private credentials.
        body = exc.read(4096).decode("utf-8", errors="replace")
        headers = exc.headers or {}
        markers = []
        if re.search(r"\berror\s+code\s*:\s*1010\b", body, re.I):
            markers.append("Cloudflare error 1010")
        if headers.get("cf-mitigated", "").lower() == "challenge":
            markers.append("Cloudflare challenge")
        ray = headers.get("cf-ray", "")
        if re.fullmatch(r"[a-zA-Z0-9-]{1,64}", ray):
            markers.append("Ray " + ray)
        try:
            worker_error = json.loads(body).get("error")
        except (ValueError, AttributeError):
            worker_error = None
        known = {"运行已过期": "run ID is not current", "运行端认证失败": "run callback credential rejected",
                 "运行状态错误": "invalid agent state"}
        if isinstance(worker_error, str) and worker_error in known:
            markers.append(known[worker_error])
        suffix = " (" + "; ".join(markers) + ")" if markers else ""
        raise RuntimeError("Manager callback HTTP " + str(exc.code) + suffix) from None


def shutdown(exit_code=0):
    with mutex:
        for proc in processes:
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        time.sleep(1)
        for proc in processes:
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    os._exit(exit_code)


def watcher():
    global last_contact
    while True:
        stop = time.monotonic() - started >= SETTINGS["max_minutes"] * 60
        try:
            response = report()
            last_contact = time.monotonic()
            stop = stop or response.get("stop", False)
        except Exception:
            # A broken management path must not leave GPU usage running for hours.
            stop = stop or time.monotonic() - last_contact > 120
        if stop:
            state.update(state="stopped", url="")
            try:
                report()
            except Exception:
                pass
            print("Stopping model and exiting the Kaggle script.", flush=True)
            shutdown()
        time.sleep(10)


def launch(args, log=None):
    with mutex:
        proc = subprocess.Popen(args, stdout=log or subprocess.DEVNULL,
                                stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(proc)
        return proc


def run(args):
    proc = launch(args)
    if proc.wait() != 0:
        raise RuntimeError("Setup command failed; check dataset binaries and CUDA compatibility")


def find_one(pattern, required=True):
    if not pattern and not required:
        return None
    found = sorted(glob.glob("/kaggle/input/" + pattern, recursive=True))
    if not found and not required:
        return None
    if len(found) != 1:
        raise RuntimeError("Expected exactly one dataset file matching " + pattern + "; got " + str(len(found)))
    return Path(found[0])



def asset_url_allowed(raw):
    from urllib.parse import urlsplit
    try:
        u = urlsplit(raw)
        host = u.hostname or ""
        return (u.scheme == "https" and not u.username and not u.password and u.port in (None, 443)
                and (host == "huggingface.co" or host.endswith(".huggingface.co")
                     or host == "hf.co" or host.endswith(".hf.co")))
    except ValueError:
        return False


class AssetRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not asset_url_allowed(newurl):
            raise RuntimeError("Model download redirect was refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_asset(asset, directory, role, opener=None):
    import hashlib
    if role not in ("weights", "vision") or not isinstance(asset, dict):
        raise RuntimeError("Invalid model asset")
    url, size, expected = asset.get("url", ""), asset.get("size"), asset.get("sha256", "")
    if (not re.fullmatch(r"https://huggingface\.co/[\w.-]+/[\w.-]+/resolve/[a-f0-9]{40}/[\w.-]+\.gguf", url)
            or type(size) is not int or not 1 <= size <= 32 * 1024**3 or not re.fullmatch(r"[a-f0-9]{64}", expected)):
        raise RuntimeError("Model assets require a fixed revision, size and SHA256")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / (role + "-" + expected + ".gguf")
    partial = target.with_suffix(".part")
    def digest_file(path):
        digest = hashlib.sha256()
        with path.open("rb") as src:
            for block in iter(lambda: src.read(4 * 1024**2), b""):
                digest.update(block)
        return digest
    if target.exists():
        if target.stat().st_size == size and digest_file(target).hexdigest() == expected:
            return target
        target.unlink()
    if shutil.disk_usage(directory).free < size - (partial.stat().st_size if partial.exists() else 0) + 64 * 1024**2:
        raise RuntimeError("Not enough free disk space for the selected model")
    opener = opener or urllib.request.build_opener(AssetRedirect())
    deadline = time.monotonic() + 45 * 60
    for attempt in range(3):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset >= size:
            partial.unlink(); offset = 0
        digest = digest_file(partial) if offset else hashlib.sha256()
        headers = {"User-Agent": APPLICATION_UA}
        if offset:
            headers["Range"] = "bytes=" + str(offset) + "-"
        state.update(state="loading", asset=role, download_percent=int(offset * 100 / size))
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=120) as src:
                if offset and getattr(src, "status", None) == 206 and not src.headers.get("Content-Range", "").startswith("bytes " + str(offset) + "-"):
                    raise RuntimeError("Model download returned an unexpected byte range")
                if offset and getattr(src, "status", None) != 206:
                    offset = 0; digest = hashlib.sha256()
                received = offset
                with partial.open("ab" if offset else "wb") as output:
                    while True:
                        if time.monotonic() > deadline:
                            raise RuntimeError("Model download exceeded 45 minutes")
                        block = src.read(4 * 1024**2)
                        if not block:
                            break
                        received += len(block)
                        if received > size:
                            raise RuntimeError("Model download exceeded its verified size")
                        digest.update(block); output.write(block)
                        state["download_percent"] = int(received * 100 / size)
            if received != size:
                raise OSError("Incomplete transfer")
            if digest.hexdigest() != expected:
                partial.unlink()
                raise RuntimeError("Model SHA256 verification failed")
            partial.replace(target)
            state.update(asset="", download_percent=None)
            return target
        except RuntimeError:
            raise
        except (OSError, urllib.error.URLError, http.client.HTTPException):
            if attempt == 2:
                raise RuntimeError("Model download failed after three attempts. Check Kaggle Internet access and retry.") from None
    raise RuntimeError("Model download failed")


def model_arguments(binary, model, projector, model_key):
    context = SETTINGS["context_size"]
    if type(context) is not int or context not in (4096,8192,16384,32768,65536,131072,262144):
        raise RuntimeError("Unsupported model context length")
    args = [str(binary), "--model", str(model), "--alias", SETTINGS["model_alias"],
            "--host", "127.0.0.1", "--port", "8080", "--n-gpu-layers", "999",
            "--split-mode", "layer", "--tensor-split", "1,1", "--ctx-size", str(context),
            "--api-key", model_key, "--jinja", "--parallel", "1"]
    if context > 32768:
        cache = SETTINGS.get("kv_cache_type", "q8_0")
        if cache not in ("q4_0", "q8_0"):
            raise RuntimeError("Unsupported long-context KV cache type")
        args.extend(["--flash-attn", "on", "--cache-type-k", cache, "--cache-type-v", cache,
                     "--batch-size", "512", "--ubatch-size", "128", "--ctx-checkpoints", "0"])
    if projector:
        args.extend(["--mmproj", str(projector)])
    return args

def verify_context(properties, expected):
    actual = properties.get("default_generation_settings", {}).get("n_ctx")
    if type(actual) is not int or actual != expected or properties.get("total_slots") != 1:
        raise RuntimeError("The requested single-session context was not confirmed by llama-server. Check model.log before retrying.")
    return actual


def main():
    global startup_phase
    print("STARTUP: manager bootstrap", flush=True)
    boot = report(bootstrap=True)
    if boot.get("stop"):
        return
    model_key = boot.get("model_api_key", "")
    if len(model_key) < 24:
        raise RuntimeError("Manager model key is missing")
    print("STARTUP: manager connected", flush=True)
    startup_phase = "GPU and dataset checks"
    threading.Thread(target=watcher, daemon=True).start()
    work = Path("/kaggle/working/gpu-manager")
    work.mkdir(parents=True, exist_ok=True)
    # Keep private credentials and runtime files out of saved Kaggle outputs.
    private = Path("/tmp/gpu-manager")
    private.mkdir(mode=0o700, exist_ok=True)
    gpu = subprocess.check_output(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], text=True)
    if len(gpu.strip().splitlines()) != 2:
        raise RuntimeError("Expected two GPUs. Check the Kaggle accelerator setting and available quota")
    binary = find_one(SETTINGS["binary_glob"])
    if SETTINGS.get("model_assets"):
        startup_phase = "model download"
        print("STARTUP: downloading verified model and vision weights", flush=True)
        assets = SETTINGS["model_assets"]
        model = download_asset(assets["weights"], private / "models", "weights")
        mmproj = download_asset(assets["vision"], private / "models", "vision")
    else:
        model = find_one(SETTINGS["model_glob"])
        mmproj = find_one(SETTINGS["mmproj_glob"], required=False)
    print("STARTUP: GPU and dataset checks passed", flush=True)
    startup_phase = "CUDA and binary setup"
    dest = private / "llama-server"
    shutil.copy2(binary, dest)
    dest.chmod(0o700)
    for lib in binary.parent.rglob("*.so*"):
        if lib.is_file():
            shutil.copy2(lib, private / lib.name)
    run([sys.executable, "-m", "pip", "install", "-q", "nvidia-cuda-runtime-cu12", "nvidia-cublas-cu12"])
    dirs = [str(private)]
    for base in site.getsitepackages():
        for name in ("libcudart.so.12", "libcublas.so.12"):
            dirs.extend(str(x.parent) for x in (Path(base) / "nvidia").rglob(name))
    os.environ["LD_LIBRARY_PATH"] = ":".join(dict.fromkeys(dirs)) + ":" + os.environ.get("LD_LIBRARY_PATH", "")
    run([str(dest), "--version"])
    print("STARTUP: CUDA and binary setup passed", flush=True)
    startup_phase = "tunnel executable download"
    cloudflared = private / "cloudflared"
    # Fetch only the executable, with a bounded transfer; no shell pipe to bash.
    download = urllib.request.Request("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
                                      headers={"User-Agent": APPLICATION_UA})
    with urllib.request.urlopen(download, timeout=60) as src:
        with cloudflared.open("wb") as out:
            shutil.copyfileobj(src, out)
    cloudflared.chmod(0o700)
    state["state"] = "loading"
    startup_phase = "model loading"
    print("STARTUP: model loading", flush=True)
    args = model_arguments(dest, model, mmproj, model_key)
    args[args.index("--port")+1] = "8081"
    with (work / "model.log").open("w") as log:
        model_proc = launch(args, log)
        for _ in range(300):
            if model_proc.poll() is not None:
                raise RuntimeError("llama-server exited. Inspect gpu-manager/model.log")
            try:
                req = urllib.request.Request("http://127.0.0.1:8081/health", headers={"Authorization": "Bearer " + model_key})
                with urllib.request.urlopen(req, timeout=3) as r:
                    if json.load(r).get("status") == "ok":
                        break
            except Exception:
                pass
            time.sleep(2)
        else:
            raise RuntimeError("Model did not become ready within 10 minutes")
        if SETTINGS["context_size"] > 32768 or SETTINGS.get("model_assets"):
            req = urllib.request.Request("http://127.0.0.1:8081/props", headers={"Authorization": "Bearer " + model_key})
            with callback_opener.open(req, timeout=15) as response:
                props = json.loads(response.read(1024 * 1024))
            actual_context = verify_context(props, SETTINGS["context_size"])
            print("STARTUP: verified context " + str(actual_context) + " tokens, one slot", flush=True)
        start_runtime_server(model_key, private, chat=True)
        serve_tunnel(boot, model_key, work, private, model_proc)


def serve_tunnel(boot, model_key, work, private, model_proc=None):
    global startup_phase
    cloudflared = private / "cloudflared"
    with (private / "tunnel.log").open("w") as tunnel_log:
        startup_phase = "tunnel connection"
        print("STARTUP: tunnel connection", flush=True)
        if SETTINGS["tunnel_mode"] in ("named", "vpc"):
            token = boot.get("tunnel_token", "")
            if not token:
                raise RuntimeError("Missing named tunnel token in Worker secrets")
            # Token as an environment variable avoids exposing it in command arguments.
            os.environ["TUNNEL_TOKEN"] = token
            tunnel_args = [str(cloudflared), "tunnel", "--no-autoupdate"]
            if SETTINGS["tunnel_mode"] == "vpc":
                tunnel_args.extend(["--protocol", "quic"])
            tunnel_proc = launch(tunnel_args + ["run"], tunnel_log)
            url = SETTINGS["model_url"].rstrip("/")
        else:
            tunnel_proc = launch([str(cloudflared), "tunnel", "--url", "http://127.0.0.1:8080"], tunnel_log)
            url = None
            for _ in range(60):
                if tunnel_proc.poll() is not None:
                    break
                match = re.search(r"https://[\w-]+\.trycloudflare\.com", (private / "tunnel.log").read_text())
                if match:
                    url = match.group()
                    break
                time.sleep(2)
            if not url:
                raise RuntimeError("Quick Tunnel did not return a URL")
        # Verify the public endpoint and API auth before announcing a ready service.
        for _ in range(60):
            if tunnel_proc.poll() is not None:
                raise RuntimeError("Tunnel process exited")
            try:
                if SETTINGS["tunnel_mode"] == "vpc":
                    if report(probe=True).get("model_reachable"):
                        break
                    time.sleep(2)
                    continue
                req = urllib.request.Request(url + "/v1/models", headers={"Authorization": "Bearer " + model_key,
                                                                          "User-Agent": APPLICATION_UA})
                with urllib.request.urlopen(req, timeout=5) as r:
                    data = json.load(r)
                    if isinstance(data.get("data"), list):
                        break
            except Exception:
                pass
            time.sleep(2)
        else:
            raise RuntimeError("Model endpoint is unreachable; check the tunnel route (VPC requires UDP 7844/QUIC)")
        state.update(state="ready", url=url)
        startup_phase = "ready"
        report()
        public_url = SETTINGS["manager_url"] if SETTINGS["tunnel_mode"] == "vpc" else url
        print("MODEL_URL=" + public_url + "\nOPENAI_BASE_URL=" + public_url + "/v1", flush=True)
        while (model_proc is None or model_proc.poll() is None) and tunnel_proc.poll() is None:
            time.sleep(5)
        raise RuntimeError("Model or tunnel stopped unexpectedly")


# __STUDIO_MEDIA_RUNTIME__

if __name__ == "__main__":
    try:
        media_main() if SETTINGS.get("model_kind") in ("image", "video") else main()
    except Exception as exc:
        # Deliberately avoid printing request objects, tokens, or command-line arguments.
        detail = str(exc) if type(exc) is RuntimeError else ("HTTP " + str(exc.code) if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__)
        print("Run failed [phase=" + startup_phase + "]: " + detail + ". Check model logs and manager configuration.", flush=True)
        state.update(state="error", url="")
        try:
            report()
        except Exception:
            pass
        shutdown(1)
    shutdown()
