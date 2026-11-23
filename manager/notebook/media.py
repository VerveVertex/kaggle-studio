# Injected into the private notebook. No provider credentials are written to outputs.
import base64
import hashlib
import hmac
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

JOB_LIMIT = 8 * 1024 * 1024
runtime_jobs = {}
runtime_lock = threading.Lock()
runtime_pipeline = None
runtime_key = ''
runtime_private = None
runtime_chat = False
runtime_offload_owner = None
runtime_reference_pipeline = None
runtime_health = {'ready': True, 'last_error_code': ''}


def job_public(job, offset=0):
    text = job.get('text', '')
    offset = max(0, min(int(offset), len(text)))
    chunk = text[offset:offset+65536]
    return {'id': job['id'], 'state': job['state'], 'progress': job.get('progress', 0),
            'text': chunk, 'offset': offset + len(chunk), 'total': len(text),
            'error': job.get('error', ''),'error_code':job.get('error_code',''), 'elapsed_seconds': round(time.monotonic()-job['created']),
            'kind': job['kind']}


class MediaFailure(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def validate_pixels(value):
    import numpy as np
    pixels = np.asarray(value)
    if not pixels.size or pixels.ndim < 2 or not np.issubdtype(pixels.dtype, np.number):
        raise MediaFailure('INVALID_MEDIA_OUTPUT','The model returned invalid image data. No output was saved.')
    if not np.isfinite(pixels).all():
        raise MediaFailure('NONFINITE_OUTPUT','The model produced invalid numbers. No black image was saved. Restart the model or choose SDXL.')
    rgb = pixels[..., :3] if pixels.ndim>=3 and pixels.shape[-1] in (3,4) else pixels
    threshold = 1/255 if np.issubdtype(pixels.dtype,np.floating) else 1
    if float(rgb.max()) <= threshold:
        raise MediaFailure('BLACK_IMAGE','The model returned an all-black image. It was rejected. Restart the model or choose SDXL.')
    return pixels


def activate_media_pipeline(pipeline):
    global runtime_offload_owner
    if runtime_offload_owner is pipeline:
        return
    if runtime_offload_owner is not None:
        runtime_offload_owner.remove_all_hooks()
    pipeline.enable_model_cpu_offload()
    runtime_offload_owner = pipeline


def zimage_pipeline(folder):
    import torch
    from diffusers import ZImagePipeline
    from diffusers.quantizers import PipelineQuantizationConfig
    # T4 has no native BF16. Plain FP16 can overflow in Z-Image.
    # NF4 shrinks resident weights; all remaining layers, matmuls and VAE use FP32.
    quant = PipelineQuantizationConfig(quant_backend='bitsandbytes_4bit',
        quant_kwargs={'load_in_4bit':True,'bnb_4bit_quant_type':'nf4',
                      'bnb_4bit_use_double_quant':True,'bnb_4bit_compute_dtype':torch.float32},
        components_to_quantize=['transformer','text_encoder'])
    pipeline = ZImagePipeline.from_pretrained(folder,torch_dtype=torch.float32,
        quantization_config=quant,low_cpu_mem_usage=True,local_files_only=True)
    pipeline.vae.to(dtype=torch.float32)
    return pipeline


def cleanup_media(pipeline, failed=False):
    import gc
    import torch
    try:
        if failed and pipeline is not None:
            pipeline.maybe_free_model_hooks()
    except Exception:
        runtime_health.update(ready=False,last_error_code='RUNTIME_RESET_REQUIRED')
    finally:
        gc.collect()
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            runtime_health.update(ready=False,last_error_code='RUNTIME_RESET_REQUIRED')


def validate_generation(body, kind):
    if body.get('model') != SETTINGS['model_alias']:
        raise ValueError('The requested model is not loaded. Select it and wait for Ready.')
    if kind == 'chat':
        messages = body.get('messages')
        if not isinstance(messages, list) or not 1 <= len(messages) <= 1000:
            raise ValueError('Expected 1 to 1000 conversation messages.')
        for message in messages:
            if not isinstance(message, dict) or message.get('role') not in ('system', 'user', 'assistant') or not isinstance(message.get('content'), (str, list)):
                raise ValueError('Invalid conversation message.')
        return
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000:
        raise ValueError('Use a media prompt with 1 to 16000 characters.')
    if body.get('image') and SETTINGS.get('media_family') not in ('wan22','sdxl','zimage'):
        raise ValueError('This model supports text input only. Choose Z-Image / SDXL for reference images or Wan2.2 for image-to-video.')
    if body.get('image') and (not isinstance(body['image'], str) or not re.fullmatch(r'data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+', body['image'])):
        raise ValueError('Expected a PNG, JPEG or WebP image.')


def chat_generate(job, body):
    # Background prefill avoids a long-lived Cloudflare request. Polling never repeats generation.
    connection = http.client.HTTPConnection('127.0.0.1', 8081, timeout=1800)
    job['connection'] = connection
    try:
        request = {k: body[k] for k in ('model', 'messages', 'max_tokens', 'temperature') if k in body}
        request['stream'] = True
        request.setdefault('max_tokens', 4096)
        connection.request('POST', '/v1/chat/completions', json.dumps(request),
                           {'Authorization': 'Bearer '+runtime_key, 'Content-Type': 'application/json'})
        response = connection.getresponse()
        if response.status != 200:
            raw = response.read(8192).decode('utf-8', errors='replace')
            try:
                error = json.loads(raw).get('error', {})
                detail = error.get('message', '') if isinstance(error, dict) else str(error)
            except ValueError:
                detail = ''
            raise ValueError(detail[:1000] or 'Model returned HTTP '+str(response.status))
        while not job['cancel'].is_set():
            line = response.readline(1024*1024)
            if not line:
                break
            if not line.startswith(b'data:'):
                continue
            raw = line[5:].strip()
            if raw == b'[DONE]':
                break
            event = json.loads(raw)
            if event.get('error'):
                error = event['error']
                raise ValueError(error.get('message', 'Model generation failed.') if isinstance(error, dict) else str(error))
            part = (event.get('choices') or [{}])[0].get('delta', {}).get('content', '')
            if isinstance(part, str):
                if len(job['text'])+len(part) > 1048576:
                    raise ValueError('Response reached the one-million-character limit. Ask to continue in a new request.')
                job['text'] += part
        if not job['text'] and not job['cancel'].is_set():
            raise ValueError('The model returned no text. Check its context and generation settings.')
    finally:
        connection.close()
        job.pop('connection', None)


def media_generate(job, body):
    import torch
    from PIL import Image as PILImage
    global runtime_reference_pipeline
    family = SETTINGS['media_family']
    pipeline = runtime_pipeline
    steps = 9 if family == 'zimage' else 25 if family == 'sdxl' else 30
    def progress(pipe, step, timestep, callback_kwargs):
        if job['cancel'].is_set():
            raise InterruptedError('Generation canceled.')
        latents=callback_kwargs.get('latents')
        if latents is not None and not torch.isfinite(latents).all().item():
            raise MediaFailure('NONFINITE_LATENTS','Model precision produced invalid latents. Generation was stopped before saving a black image. Restart the model or choose SDXL.')
        job['progress'] = min(99, round((step+1)*100/steps))
        return callback_kwargs
    kwargs = {'prompt': body['prompt'], 'generator': torch.Generator('cpu').manual_seed(42),
              'num_inference_steps': steps, 'callback_on_step_end': progress}
    if family == 'zimage':
        kwargs.update(width=768, height=768, guidance_scale=0.0,output_type='np')
        if body.get('image'):
            from diffusers import ZImageImg2ImgPipeline
            if runtime_reference_pipeline is None:
                runtime_reference_pipeline=ZImageImg2ImgPipeline(**runtime_pipeline.components)
            pipeline=runtime_reference_pipeline
            picture=PILImage.open(io.BytesIO(base64.b64decode(body['image'].split(',',1)[1],validate=True)))
            if picture.width*picture.height>40000000:
                raise ValueError('Choose an image with fewer than 40 million pixels.')
            from PIL import ImageOps
            kwargs.update(image=ImageOps.fit(picture.convert('RGB'),(768,768)),strength=0.6)
    elif family == 'sdxl':
        kwargs.update(width=1024, height=1024, guidance_scale=5.0,output_type='np')
        if body.get('image'):
            from diffusers import AutoPipelineForImage2Image
            if runtime_reference_pipeline is None:
                runtime_reference_pipeline=AutoPipelineForImage2Image.from_pipe(runtime_pipeline)
            pipeline=runtime_reference_pipeline
            picture=PILImage.open(io.BytesIO(base64.b64decode(body['image'].split(',',1)[1],validate=True)))
            if picture.width*picture.height>40000000:
                raise ValueError('Choose an image with fewer than 40 million pixels.')
            from PIL import ImageOps
            kwargs.update(image=ImageOps.fit(picture.convert('RGB'),(1024,1024)),strength=0.6)
            kwargs.pop('width',None);kwargs.pop('height',None)
    elif family == 'wan21':
        kwargs.update(width=832, height=480, num_frames=33, guidance_scale=5.0)
    elif family == 'wan22':
        # Conservative T4 preview; official native 720p is not claimed to fit these GPUs.
        kwargs.update(width=640, height=384, num_frames=33, guidance_scale=5.0)
        if body.get('image'):
            from diffusers import WanImageToVideoPipeline
            if runtime_reference_pipeline is None:
                runtime_reference_pipeline=WanImageToVideoPipeline(**runtime_pipeline.components)
            pipeline=runtime_reference_pipeline
            picture = PILImage.open(io.BytesIO(base64.b64decode(body['image'].split(',', 1)[1], validate=True)))
            if picture.width*picture.height > 40000000:
                raise ValueError('Choose an image with fewer than 40 million pixels.')
            kwargs['image'] = picture.convert('RGB').resize((640,384))
        else:
            pipeline = runtime_pipeline
    else:
        raise ValueError('Unsupported media model.')
    activate_media_pipeline(pipeline)
    with torch.inference_mode():
        result = pipeline(**kwargs)
    if job['cancel'].is_set():
        raise InterruptedError('Generation canceled.')
    if job['kind'] == 'image':
        target = runtime_private / (job['id']+'.png')
        import numpy as np
        pixels=validate_pixels(result.images[0])
        if np.issubdtype(pixels.dtype,np.floating):
            pixels=(np.clip(pixels,0,1)*255).round().astype('uint8')
        PILImage.fromarray(pixels).save(target)
        job['mime'] = 'image/png'
    else:
        from diffusers.utils import export_to_video
        target = runtime_private / (job['id']+'.mp4')
        validate_pixels(result.frames[0])
        export_to_video(result.frames[0], str(target), fps=16)
        job['mime'] = 'video/mp4'
    if target.stat().st_size > 128*1024*1024:
        target.unlink()
        raise ValueError('Generated media exceeds 128 MB.')
    job['file'] = target
    job['progress'] = 100


def execute_job(job, body):
    try:
        if job['cancel'].is_set():
            return
        job['state'] = 'running'
        job['error_code']=''
        (chat_generate if job['kind']=='chat' else media_generate)(job, body)
        job['state'] = 'canceled' if job['cancel'].is_set() else 'complete'
        if job['state']=='complete':
            runtime_health['last_error_code']=''
    except Exception as exc:
        job['error_code']=getattr(exc,'code','')
        if type(exc).__name__ in ('OutOfMemoryError','MemoryError'):
            job['error_code']='OUT_OF_MEMORY'
        runtime_health['last_error_code']=job['error_code'] or type(exc).__name__
        job['state'] = 'canceled' if job['cancel'].is_set() else 'error'
        # Whitelisted validation errors contain no credentials, request objects or file paths.
        if isinstance(exc, (ValueError, InterruptedError)):
            detail = str(exc)[:1000]
            for secret in (runtime_key, SETTINGS.get('run_token', '')):
                if secret:
                    detail = detail.replace(secret, '[redacted]')
            job['error'] = detail
        elif job['error_code']=='OUT_OF_MEMORY':
            job['error']='GPU memory was exhausted. Recovery was attempted. Restart the session or use a smaller model.'
        else:
            job['error'] = 'GPU generation failed ('+type(exc).__name__+'). Check memory and model logs; try another model.'
    finally:
        if job['kind']!='chat' and runtime_offload_owner is not None:
            cleanup_media(runtime_offload_owner,failed=job['state']!='complete')
            if not runtime_health['ready']:
                job.update(state='error',error_code='RUNTIME_RESET_REQUIRED',error='The GPU runtime could not recover safely. Stop this session in Compute and start a new one.')
                if isinstance(globals().get('state'),dict):
                    state.update(state='error',url='')
        if job['cancel'].is_set():
            job['state'] = 'canceled'


class RuntimeHTTP(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def setup(self):
        super().setup()
        self.connection.settimeout(30)
    def log_message(self, *args):
        pass
    def reply(self, data, status=200):
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection','close')
        self.close_connection=True
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        self.handle_request()
    def do_POST(self):
        self.handle_request()
    def legacy_chat(self, path):
        length = int(self.headers.get('Content-Length',0))
        if length < 0 or length > JOB_LIMIT:
            return self.reply({'error':'Request exceeds 8 MB.'},413)
        payload = self.rfile.read(length) if self.command=='POST' else None
        connection = http.client.HTTPConnection('127.0.0.1',8081,timeout=1800)
        try:
            connection.request(self.command,path,payload,{'Authorization':'Bearer '+runtime_key,'Content-Type':'application/json'})
            response = connection.getresponse()
            self.send_response(response.status)
            self.send_header('Content-Type',response.getheader('Content-Type','application/json'))
            self.send_header('Transfer-Encoding','chunked')
            self.send_header('Cache-Control','no-store')
            self.end_headers()
            while True:
                block = response.read1(8192)
                if not block:
                    break
                self.wfile.write(('%x\r\n'%len(block)).encode()+block+b'\r\n')
                self.wfile.flush()
            self.wfile.write(b'0\r\n\r\n')
        finally:
            connection.close()
    def handle_request(self):
        try:
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer '+runtime_key):
                return self.reply({'error': 'Invalid model credential.'}, 401)
            from urllib.parse import urlsplit, parse_qs
            url = urlsplit(self.path)
            path = url.path
            if path == '/v1/models' and self.command == 'GET':
                return self.reply({'data': [{'id': SETTINGS['model_alias'], 'type': SETTINGS.get('model_kind','chat')} ],'studio_runtime':{**runtime_health,'build':SETTINGS.get('runtime_build'),'precision':'nf4-fp32' if SETTINGS.get('media_family')=='zimage' else None}},200 if runtime_health['ready'] else 503)
            if runtime_chat and path in ('/v1/chat/completions','/v1/completions','/v1/responses','/v1/messages'):
                return self.legacy_chat(path)
            match = re.fullmatch(r'/v1/(chat|media)/jobs(?:/([a-f0-9]{32})(?:/(file|cancel))?)?', path)
            if not match:
                return self.reply({'error': 'Use background jobs for this model.'}, 404)
            namespace, ident, action = match.groups()
            kind = 'chat' if runtime_chat else SETTINGS['model_kind']
            if (namespace == 'chat') != runtime_chat:
                return self.reply({'error': 'Select and load the requested model first.'}, 409)
            if not ident and self.command == 'POST':
                length = int(self.headers.get('Content-Length', 0))
                if not 0 < length <= JOB_LIMIT:
                    return self.reply({'error': 'Request exceeds 8 MB. Reduce images or conversation history.'}, 413)
                raw = self.rfile.read(length)
                if len(raw) != length:
                    return self.reply({'error': 'Incomplete request.'}, 400)
                body = json.loads(raw)
                if not isinstance(body,dict):
                    raise ValueError('Expected an object.')
                ident = body.get('request_id', '')
                if not isinstance(ident,str) or not re.fullmatch('[a-f0-9]{32}', ident):
                    raise ValueError('Invalid request ID.')
                if not runtime_health['ready']:
                    return self.reply({'error':'The model requires a session restart after a GPU failure.','code':'RUNTIME_RESET_REQUIRED'},503)
                validate_generation(body, kind)
                fingerprint = hashlib.sha256(raw).hexdigest()
                with runtime_lock:
                    if ident in runtime_jobs:
                        old = runtime_jobs[ident]
                        return self.reply(job_public(old), 200) if old['fingerprint']==fingerprint else self.reply({'error':'Request ID already used for another request.'},409)
                    for key, old in list(runtime_jobs.items()):
                        if old['state'] not in ('queued','running') and time.monotonic()-old['created'] > 1800:
                            if old.get('file'):
                                old['file'].unlink(missing_ok=True)
                            del runtime_jobs[key]
                    if any(j['state'] in ('queued','running') for j in runtime_jobs.values()):
                        return self.reply({'error':'The GPU is already generating. Wait or cancel the current task.'},409)
                    if len(runtime_jobs) >= 8:
                        # Evict oldest completed result, bound RAM and disk.
                        key = next(iter(runtime_jobs))
                        old = runtime_jobs.pop(key)
                        if old.get('file'):
                            old['file'].unlink(missing_ok=True)
                    job = {'id':ident,'kind':kind,'state':'queued','created':time.monotonic(),'cancel':threading.Event(),'text':'','fingerprint':fingerprint}
                    runtime_jobs[ident] = job
                    threading.Thread(target=execute_job,args=(job,body),daemon=True).start()
                return self.reply(job_public(job),202)
            job = runtime_jobs.get(ident)
            if not job:
                return self.reply({'error':'Task is no longer available. The GPU session may have restarted.'},404)
            if action == 'cancel' and self.command == 'POST':
                if job['state'] in ('queued','running'):
                    job['cancel'].set()
                    connection = job.get('connection')
                    if connection:
                        connection.close()
                return self.reply(job_public(job))
            if self.command != 'GET':
                return self.reply({'error':'Unsupported task operation.'},405)
            if action == 'file':
                if job['state'] != 'complete' or not job.get('file'):
                    return self.reply({'error':'Output is not ready.'},409)
                self.send_response(200)
                self.send_header('Content-Type',job['mime'])
                self.send_header('Content-Length',str(job['file'].stat().st_size))
                self.send_header('Cache-Control','no-store')
                self.end_headers()
                with job['file'].open('rb') as source:
                    shutil.copyfileobj(source,self.wfile)
                return
            return self.reply(job_public(job,parse_qs(url.query).get('offset',['0'])[0]))
        except ValueError as exc:
            self.reply({'error':str(exc)[:500] if not isinstance(exc,json.JSONDecodeError) else 'Expected valid JSON content.'},400)
        except (TypeError,KeyError):
            self.reply({'error':'Invalid model request or unsupported input.'},400)
        except (BrokenPipeError,ConnectionResetError):
            pass


def start_runtime_server(key, private, chat=False):
    global runtime_key, runtime_private, runtime_chat
    runtime_key, runtime_private, runtime_chat = key, private, chat
    server = ThreadingHTTPServer(('127.0.0.1',8080),RuntimeHTTP)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever,daemon=True).start()
    return server


def media_main():
    global startup_phase, runtime_pipeline
    boot = report(bootstrap=True)
    if boot.get('stop'):
        return
    key = boot.get('model_api_key','')
    if len(key)<24:
        raise RuntimeError('Manager model key is missing')
    threading.Thread(target=watcher,daemon=True).start()
    private=Path('/tmp/gpu-manager');private.mkdir(mode=0o700,exist_ok=True)
    work=Path('/kaggle/working/gpu-manager');work.mkdir(parents=True,exist_ok=True)
    state['state']='loading'
    startup_phase='media dependencies'
    run([sys.executable,'-m','pip','install','-q','diffusers==0.36.0','transformers==4.57.3','accelerate==1.12.0','safetensors==0.7.0','sentencepiece==0.2.1','imageio==2.37.2','imageio-ffmpeg==0.6.0','Pillow==12.0.0'])
    if SETTINGS['media_family']=='zimage':
        run([sys.executable,'-m','pip','install','-q','bitsandbytes==0.48.2'])
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError('A CUDA GPU is required for media generation.')
    from huggingface_hub import snapshot_download
    from diffusers import AutoPipelineForText2Image, ZImagePipeline, WanPipeline, AutoencoderKLWan
    startup_phase='media model download'
    spec=SETTINGS['media_model']
    patterns=['*.json','*.txt','*.model','*.safetensors']
    ignore=['*.fp16.safetensors','*.bf16.safetensors','vae_1_0/*'] if SETTINGS['media_family']!='sdxl' else ['*.bf16.safetensors','vae_1_0/*']
    if SETTINGS['media_family']=='sdxl':
        patterns=['*.json','*.txt','*.model','*fp16.safetensors']
    folder=snapshot_download(spec['repo'],revision=spec['revision'],cache_dir=str(private/'cache'),allow_patterns=patterns,ignore_patterns=ignore,max_workers=2)
    startup_phase='media pipeline loading'
    family=SETTINGS['media_family']
    if family=='sdxl':
        runtime_pipeline=AutoPipelineForText2Image.from_pretrained(folder,torch_dtype=torch.float16,variant='fp16',use_safetensors=True,local_files_only=True)
    elif family=='zimage':
        runtime_pipeline=zimage_pipeline(folder)
    else:
        vae=AutoencoderKLWan.from_pretrained(folder,subfolder='vae',torch_dtype=torch.float32,local_files_only=True)
        runtime_pipeline=WanPipeline.from_pretrained(folder,vae=vae,torch_dtype=torch.float16,local_files_only=True)
    activate_media_pipeline(runtime_pipeline)
    if hasattr(runtime_pipeline.vae,'enable_tiling'):
        runtime_pipeline.vae.enable_tiling()
    if hasattr(runtime_pipeline.vae,'enable_slicing'):
        runtime_pipeline.vae.enable_slicing()
    start_runtime_server(key,private)
    startup_phase='tunnel executable download'
    cloudflared=private/'cloudflared'
    with urllib.request.urlopen('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',timeout=60) as src,cloudflared.open('wb') as out:
        shutil.copyfileobj(src,out)
    cloudflared.chmod(0o700)
    serve_tunnel(boot,key,work,private)
