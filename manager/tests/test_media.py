import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

class BackgroundRuntimeTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('media_runtime',Path(__file__).resolve().parents[1]/'notebook/media.py')
        self.m=importlib.util.module_from_spec(spec)
        self.m.SETTINGS={'model_alias':'test-chat','model_kind':'chat'}
        self.m.threading=threading;self.m.time=time;self.m.Path=Path;self.m.re=__import__('re');self.m.json=json
        self.m.shutil=__import__('shutil');self.m.http=__import__('http');spec.loader.exec_module(self.m)
        self.temp=tempfile.TemporaryDirectory();self.m.runtime_key='key';self.m.runtime_private=Path(self.temp.name);self.m.runtime_chat=True
        self.server=self.m.ThreadingHTTPServer(('127.0.0.1',0),self.m.RuntimeHTTP);self.server.daemon_threads=True
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.temp.cleanup()
    def call(self,path,body=None,key='key'):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=3)
        conn.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,{'Authorization':'Bearer '+key,'Content-Type':'application/json'})
        reply=conn.getresponse();result=(reply.status,json.loads(reply.read()));conn.close();return result
    def body(self,ident='a'*32):return {'request_id':ident,'model':'test-chat','messages':[{'role':'user','content':'长问题'*1000}]}
    def test_submit_returns_before_prefill_and_replay_does_not_generate_twice(self):
        started=[];release=threading.Event()
        def generate(job,body):started.append(body);release.wait(2);job['text']='回答'*40000
        self.m.chat_generate=generate
        a,b=self.call('/v1/chat/jobs',self.body());self.assertEqual(a,202)
        self.assertIn(b['state'],('queued','running'));self.assertEqual(len(started),1)
        self.assertEqual(self.call('/v1/chat/jobs',self.body())[0],200)
        changed=self.body();changed['messages'][0]['content']='different'
        self.assertEqual(self.call('/v1/chat/jobs',changed)[0],409)
        self.assertEqual(self.call('/v1/chat/jobs',self.body('b'*32))[0],409)
        release.set()
        for _ in range(100):
            a,b=self.call('/v1/chat/jobs/'+'a'*32)
            if b['state']=='complete':break
            time.sleep(.005)
        self.assertEqual(b['offset'],65536)
        a,tail=self.call('/v1/chat/jobs/'+'a'*32+'?offset=65536');self.assertEqual(tail['text'],'回答'*7232)
        self.assertEqual(tail['offset'],80000);self.assertEqual(len(started),1)
    def test_legacy_openai_stream_keeps_utf8_and_original_model_credential(self):
        from unittest.mock import patch
        from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
        seen=[];payload='data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'.encode()
        class Llama(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                seen.append((self.path,self.headers['Authorization'],json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
        origin=ThreadingHTTPServer(('127.0.0.1',0),Llama);threading.Thread(target=origin.serve_forever,daemon=True).start()
        connection=http.client.HTTPConnection
        try:
            with patch.object(self.m.http.client,'HTTPConnection',side_effect=lambda host,port,**kwargs:connection(host,origin.server_port if port==8081 else port,**kwargs)):
                client=connection('127.0.0.1',self.server.server_port,timeout=3);client.request('POST','/v1/chat/completions',json.dumps({'model':'test-chat','messages':[{'role':'user','content':'中文问题'}],'stream':True}),{'Authorization':'Bearer key','Content-Type':'application/json'})
                response=client.getresponse();self.assertEqual(response.status,200);self.assertEqual(response.read(),payload);client.close()
            self.assertEqual(seen[0][0],'/v1/chat/completions');self.assertEqual(seen[0][1],'Bearer key');self.assertEqual(seen[0][2]['messages'][0]['content'],'中文问题')
        finally:
            origin.shutdown();origin.server_close()
    def test_auth_model_validation_cancel_and_no_path_access(self):
        self.assertEqual(self.call('/v1/models',key='bad')[0],401)
        self.assertEqual(self.call('/v1/chat/jobs/../../file')[0],404)
        wrong=self.body();wrong['model']='other';self.assertEqual(self.call('/v1/chat/jobs',wrong)[0],400)
        def generate(job,body):job['cancel'].wait(2)
        self.m.chat_generate=generate
        self.call('/v1/chat/jobs',self.body());self.call('/v1/chat/jobs/'+'a'*32+'/cancel',{})
        for _ in range(100):
            a,b=self.call('/v1/chat/jobs/'+'a'*32)
            if b['state']=='canceled':break
            time.sleep(.005)
        self.assertEqual(b['state'],'canceled');self.assertEqual(self.call('/v1/chat/jobs/'+'a'*32+'/file')[0],409)
    def test_bounded_body_and_complete_media_file(self):
        self.m.runtime_chat=False;self.m.SETTINGS={'model_alias':'image','model_kind':'image','media_family':'sdxl'}
        def generate(job,body):
            job['file']=Path(self.temp.name)/'output.png';job['file'].write_bytes(b'PNG');job['mime']='image/png'
        self.m.media_generate=generate
        self.assertEqual(self.call('/v1/media/jobs',{'request_id':'d'*32,'model':'image','prompt':'x'*16001})[0],400)
        self.assertEqual(self.call('/v1/media/jobs',{'request_id':'d'*32,'model':'image','prompt':'a photo'})[0],202)
        for _ in range(100):
            _,b=self.call('/v1/media/jobs/'+'d'*32)
            if b['state']=='complete':break
            time.sleep(.005)
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port);conn.request('GET','/v1/media/jobs/'+'d'*32+'/file',headers={'Authorization':'Bearer key'});r=conn.getresponse();self.assertEqual(r.read(),b'PNG');conn.close()
        self.m.validate_generation({'model':'image','prompt':'ok'},'image')
        self.m.SETTINGS['media_family']='wan21'
        with self.assertRaises(ValueError):
            self.m.validate_generation({'model':'image','prompt':'ok','image':'data:image/png;base64,YQ=='},'image')

class TunnelRuntimeTests(unittest.TestCase):
    def test_shared_tunnel_uses_private_executable_and_reports_ready_before_monitoring(self):
        from unittest.mock import patch
        spec=importlib.util.spec_from_file_location('runner',Path(__file__).resolve().parents[1]/'notebook/runner.py')
        runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        runner.SETTINGS={'tunnel_mode':'vpc','model_url':'https://studio-vpc.invalid','manager_url':'https://gpu.example.net'}
        launches=[]
        class Proc:
            count=0
            def poll(self):
                self.count+=1
                return None if self.count==1 else 0
        with tempfile.TemporaryDirectory() as folder,patch.object(runner,'launch',side_effect=lambda args,log:(launches.append(args) or Proc())),patch.object(runner,'report',return_value={'model_reachable':True}),patch.dict(runner.os.environ,{},clear=False):
            private=Path(folder)
            with self.assertRaisesRegex(RuntimeError,'unexpectedly'):
                runner.serve_tunnel({'tunnel_token':'test'},'model-key',private,private)
            self.assertEqual(launches[0][0],str(private/'cloudflared'))
            self.assertIn('quic',launches[0]);self.assertEqual(runner.state['state'],'ready')

if __name__=='__main__':unittest.main()
