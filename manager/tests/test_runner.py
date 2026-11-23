import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("runner", Path(__file__).parents[1] / "notebook/runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTest(unittest.TestCase):
    def test_callback_identifies_app_and_parses_private_bootstrap_without_logging(self):
        settings={"manager_url":"https://gpu.example.net", "run_id":"test-run", "run_token":"PRIVATE_CALLBACK_TOKEN"}
        response=io.BytesIO(json.dumps({"model_api_key":"PRIVATE_MODEL_KEY"}).encode())
        with patch.object(runner,"SETTINGS",settings,create=True), patch.object(runner.callback_opener,"open",return_value=response) as request:
            result=runner.report(bootstrap=True)
            req=request.call_args.args[0]
            self.assertEqual(req.get_header('User-agent'),'KaggleGpuManager/0.1.3')
            self.assertEqual(req.get_header('Authorization'),'Bearer PRIVATE_CALLBACK_TOKEN')
            self.assertEqual(json.loads(req.data)['bootstrap'],True)
            self.assertEqual(result['model_api_key'],'PRIVATE_MODEL_KEY')

    def test_callback_error_exposes_status_and_cloudflare_marker_but_no_response_or_credential(self):
        settings={"manager_url":"https://gpu.example.net", "run_id":"test-run", "run_token":"PRIVATE_CALLBACK_TOKEN"}
        error=urllib.error.HTTPError('https://example.net/private?secret=PRIVATE_URL',403,'Forbidden',
            {'cf-ray':'abcdef123-LAX'},io.BytesIO(b'error code: 1010 PRIVATE_CALLBACK_TOKEN PRIVATE_RESPONSE'))
        with patch.object(runner,"SETTINGS",settings,create=True),patch.object(runner.callback_opener,"open",side_effect=error):
            with self.assertRaises(RuntimeError) as raised:
                runner.report(bootstrap=True)
            message=str(raised.exception)
            self.assertIn('HTTP 403',message)
            self.assertIn('Cloudflare error 1010',message)
            self.assertIn('Ray abcdef123-LAX',message)
            self.assertNotIn('PRIVATE_',message)

    def test_callback_credential_failure_is_distinguished_from_cloudflare_denial(self):
        settings={"manager_url":"https://gpu.example.net", "run_id":"test-run", "run_token":"PRIVATE_TOKEN"}
        error=urllib.error.HTTPError('https://gpu.example.net/agent/test-run',401,'Unauthorized',{},
            io.BytesIO(json.dumps({"error":"运行端认证失败"}).encode()))
        with patch.object(runner,"SETTINGS",settings,create=True),patch.object(runner.callback_opener,"open",side_effect=error):
            with self.assertRaisesRegex(RuntimeError,'HTTP 401.*credential rejected'):
                runner.report()

    def test_callback_redirect_handler_refuses_redirecting_private_request(self):
        self.assertIsNone(runner.NoCallbackRedirect().redirect_request(None,None,302,'Found',{},'https://other.example/login'))

    def test_callback_non_json_does_not_echo_body_or_continue_to_gpu_setup(self):
        settings={"manager_url":"https://gpu.example.net", "run_id":"test-run", "run_token":"PRIVATE_TOKEN"}
        with patch.object(runner,"SETTINGS",settings,create=True),patch.object(runner.callback_opener,"open",return_value=io.BytesIO(b'<html>PRIVATE_BODY</html>')),patch.object(runner,"launch") as launch:
            with self.assertRaisesRegex(RuntimeError,'non-JSON') as raised:
                runner.main()
            self.assertNotIn('PRIVATE_',str(raised.exception))
            launch.assert_not_called()

    def test_blank_optional_projector_is_disabled_without_selecting_a_directory(self):
        with patch.object(runner.glob, 'glob') as glob_call:
            self.assertIsNone(runner.find_one('', required=False))
            glob_call.assert_not_called()

    def test_optional_and_ambiguous_model_paths(self):
        with patch.object(runner.glob, "glob", return_value=[]):
            self.assertIsNone(runner.find_one("**/mmproj.gguf", required=False))
            with self.assertRaises(RuntimeError):
                runner.find_one("**/model.gguf")
        with patch.object(runner.glob, "glob", return_value=["/a/model.gguf", "/b/model.gguf"]):
            with self.assertRaises(RuntimeError):
                runner.find_one("**/model.gguf")

    def test_stop_at_bootstrap_never_starts_gpu_setup(self):
        with patch.object(runner, "report", return_value={"stop": True}), patch.object(runner, "launch") as proc:
            runner.main()
            proc.assert_not_called()

    def test_missing_model_key_fails_before_setup(self):
        with patch.object(runner, "report", return_value={}), patch.object(runner, "launch") as proc:
            with self.assertRaises(RuntimeError):
                runner.main()
            proc.assert_not_called()


class LongContextTest(unittest.TestCase):
    def asset(self, data):
        import hashlib
        return {"url":"https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/resolve/"+"a"*40+"/model.gguf",
                "size":len(data),"sha256":hashlib.sha256(data).hexdigest()}

    def test_fixed_model_asset_is_hashed_cached_and_never_receives_service_credentials(self):
        data=b'GGUF-model-fixture'
        class Opener:
            def open(self, request, timeout):
                self.request=request
                return io.BytesIO(data)
        opener=Opener()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            result=runner.download_asset(self.asset(data),root,'weights',opener)
            self.assertEqual(result.read_bytes(),data)
            self.assertIsNone(opener.request.get_header('Authorization'))
            with patch.object(opener,'open',side_effect=AssertionError('cached file must not download again')):
                self.assertEqual(runner.download_asset(self.asset(data),root,'weights',opener),result)

    def test_download_integrity_size_revision_and_redirects_are_enforced(self):
        data=b'GGUF-correct'
        class Opener:
            def open(self,*args,**kw):return io.BytesIO(b'wrong-content')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError,'size|SHA256'):
                runner.download_asset(self.asset(data),Path(directory),'vision',Opener())
            asset=self.asset(data);asset['url']=asset['url'].replace('a'*40,'main')
            with self.assertRaisesRegex(RuntimeError,'fixed revision'):
                runner.download_asset(asset,Path(directory),'weights',Opener())
        for url in ['http://huggingface.co/file','https://127.0.0.1/file','https://huggingface.co.evil.test/file','https://user:password@huggingface.co/file']:
            self.assertFalse(runner.asset_url_allowed(url))
            with self.assertRaisesRegex(RuntimeError,'redirect'):
                runner.AssetRedirect().redirect_request(None,None,302,'Found',{},url)
        self.assertTrue(runner.asset_url_allowed('https://cas-bridge.xethub.hf.co/file?signature=value'))

    def test_network_interruption_resumes_matching_byte_range_and_hashes_the_full_file(self):
        data=b'GGUF-fixture-with-resume'
        class Broken(io.BytesIO):
            def read(self,n=-1):
                if self.tell():raise OSError('connection lost')
                return super().read(4)
        class Tail(io.BytesIO):
            status=206
            headers={'Content-Range':'bytes 4-22/23'}
        class Opener:
            count=0
            def open(self,request,timeout):
                self.count+=1
                if self.count==1:return Broken(data)
                self.range=request.get_header('Range');return Tail(data[4:])
        opener=Opener()
        with tempfile.TemporaryDirectory() as directory:
            result=runner.download_asset(self.asset(data),Path(directory),'weights',opener)
            self.assertEqual(result.read_bytes(),data)
            self.assertEqual(opener.range,'bytes=4-')

    def test_server_must_confirm_the_full_single_slot_context_before_announcement(self):
        props={"default_generation_settings":{"n_ctx":262144},"total_slots":1}
        self.assertEqual(runner.verify_context(props,262144),262144)
        for bad in [{}, {"default_generation_settings":{"n_ctx":131072},"total_slots":1}, {"default_generation_settings":{"n_ctx":262144},"total_slots":2}]:
            with self.assertRaisesRegex(RuntimeError,'not confirmed'):
                runner.verify_context(bad,262144)

    def test_256k_is_one_context_with_quantized_cache_and_vision_projector(self):
        with patch.object(runner,'SETTINGS',{'context_size':262144,'model_alias':'qwen3.8-27b','kv_cache_type':'q4_0'},create=True):
            args=runner.model_arguments('/tmp/llama-server','weights.gguf','vision.gguf','PRIVATE_MODEL_KEY')
        for flag,value in [('--ctx-size','262144'),('--parallel','1'),('--cache-type-k','q4_0'),('--cache-type-v','q4_0'),('--flash-attn','on'),('--ctx-checkpoints','0'),('--mmproj','vision.gguf')]:
            self.assertEqual(args[args.index(flag)+1],value)
        with patch.object(runner,'SETTINGS',{'context_size':16384,'model_alias':'old-profile'},create=True):
            args=runner.model_arguments('/tmp/llama-server','old.gguf',None,'PRIVATE_MODEL_KEY')
            self.assertNotIn('--cache-type-k',args)
            self.assertNotIn('--mmproj',args)


if __name__ == "__main__":
    unittest.main()
