import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image

class MediaSafetyTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('media_safety',Path(__file__).resolve().parents[1]/'notebook/media.py')
        self.m=importlib.util.module_from_spec(spec)
        for key,value in {'threading':threading,'time':time,'Path':Path,'re':re,'json':json,'shutil':shutil}.items():setattr(self.m,key,value)
        spec.loader.exec_module(self.m);self.m.SETTINGS={'model_alias':'z-image-turbo','model_kind':'image','media_family':'zimage'}
        self.temp=tempfile.TemporaryDirectory();self.m.runtime_private=Path(self.temp.name)
        self.empty=0
        class Generator:
            def manual_seed(self,seed):return self
        self.torch=types.SimpleNamespace(float32='float32',Generator=lambda device:Generator(),inference_mode=contextlib.nullcontext,isfinite=np.isfinite,cuda=types.SimpleNamespace(is_available=lambda:True,empty_cache=self.clear))
        self.modules=patch.dict(sys.modules,{'torch':self.torch});self.modules.start()
    def clear(self):self.empty+=1
    def tearDown(self):self.modules.stop();self.temp.cleanup()
    def job(self,ident='a'*32):return {'id':ident,'kind':'image','state':'queued','created':time.monotonic(),'cancel':threading.Event(),'text':''}
    def pipe(self):
        class Pipeline:
            enabled=0;freed=0;removed=0;fail=None;bad_latents=False;calls=[];components={'shared':'weights'}
            def enable_model_cpu_offload(self):self.enabled+=1
            def remove_all_hooks(self):self.removed+=1
            def maybe_free_model_hooks(self):self.freed+=1
            def __call__(self,**kwargs):
                self.calls.append(kwargs)
                if self.fail:raise self.fail
                kwargs['callback_on_step_end'](self,0,0,{'latents':np.array([np.nan if self.bad_latents else 0.5])})
                return types.SimpleNamespace(images=[np.full((16,16,3),0.5,dtype=np.float32)])
        return Pipeline()
    def image(self):
        out=io.BytesIO();Image.new('RGB',(5,7),(255,0,0)).save(out,format='PNG');return 'data:image/png;base64,'+base64.b64encode(out.getvalue()).decode()
    def test_invalid_numbers_black_output_and_empty_arrays_are_rejected_before_encoding(self):
        for array,code in [(np.zeros((2,2,3)),'BLACK_IMAGE'),(np.full((2,2,3),np.nan),'NONFINITE_OUTPUT'),(np.full((2,2,3),np.inf),'NONFINITE_OUTPUT'),(np.array([]),'INVALID_MEDIA_OUTPUT')]:
            with self.assertRaises(self.m.MediaFailure) as failure:self.m.validate_pixels(array)
            self.assertEqual(failure.exception.code,code)
        for array in [np.full((2,2,3),0.5),np.full((2,2,3),255,dtype=np.uint8),np.zeros((2,2,3),dtype=np.uint8)+[255,0,0]]:self.m.validate_pixels(array)
        rgba=np.zeros((2,2,4),dtype=np.uint8);rgba[...,3]=255
        with self.assertRaises(self.m.MediaFailure):self.m.validate_pixels(rgba)
    def test_zimage_policy_quantizes_weights_but_keeps_compute_and_vae_in_float32(self):
        seen={};vae=types.SimpleNamespace(to=lambda **kwargs:seen.update(vae=kwargs))
        class Config:
            def __init__(self,**kwargs):seen['quant']=kwargs
        class ZImage:
            @classmethod
            def from_pretrained(cls,folder,**kwargs):seen['load']=kwargs;return types.SimpleNamespace(vae=vae)
        with patch.dict(sys.modules,{'diffusers':types.SimpleNamespace(ZImagePipeline=ZImage),'diffusers.quantizers':types.SimpleNamespace(PipelineQuantizationConfig=Config)}):self.m.zimage_pipeline('pinned-local-model')
        self.assertEqual(seen['load']['torch_dtype'],'float32');self.assertEqual(seen['quant']['quant_kwargs']['bnb_4bit_compute_dtype'],'float32');self.assertEqual(seen['quant']['quant_kwargs']['bnb_4bit_quant_type'],'nf4');self.assertEqual(seen['quant']['components_to_quantize'],['transformer','text_encoder']);self.assertEqual(seen['vae']['dtype'],'float32')
    def test_two_images_reuse_offload_owner_and_produce_nonblack_saved_files(self):
        pipe=self.pipe();self.m.runtime_pipeline=pipe
        first,second=self.job(),self.job('b'*32)
        self.m.execute_job(first,{'prompt':'a dog'});self.m.execute_job(second,{'prompt':'a tree'})
        self.assertEqual((first['state'],second['state']),('complete','complete'));self.assertEqual(pipe.enabled,1);self.assertEqual(self.empty,2)
        self.assertEqual(pipe.calls[0]['output_type'],'np');self.assertEqual(pipe.calls[0]['width'],768)
        with Image.open(first['file']) as picture:self.assertGreater(max(v[1] for v in picture.getextrema()),0)
    def test_nonfinite_latents_fail_job_no_black_file_and_runtime_remains_answerable(self):
        pipe=self.pipe();pipe.bad_latents=True;self.m.runtime_pipeline=pipe;job=self.job();self.m.execute_job(job,{'prompt':'a tree'})
        self.assertEqual(job['state'],'error');self.assertEqual(job['error_code'],'NONFINITE_LATENTS');self.assertNotIn('file',job);self.assertEqual(list(Path(self.temp.name).glob('*.png')),[]);self.assertTrue(self.m.runtime_health['ready']);self.assertEqual(pipe.freed,1)
    def test_oom_releases_hooks_and_cache_then_allows_another_job(self):
        class OutOfMemoryError(RuntimeError):pass
        pipe=self.pipe();pipe.fail=OutOfMemoryError('private CUDA diagnostics');self.m.runtime_pipeline=pipe;job=self.job();self.m.execute_job(job,{'prompt':'a tree'})
        self.assertEqual(job['error_code'],'OUT_OF_MEMORY');self.assertEqual(job['state'],'error');self.assertNotIn('private CUDA diagnostics',job['error']);self.assertEqual(pipe.freed,1);self.assertEqual(self.empty,1)
        pipe.fail=None;second=self.job('c'*32);self.m.execute_job(second,{'prompt':'a dog'});self.assertEqual(second['state'],'complete');self.assertEqual(self.m.runtime_health['last_error_code'],'')
    def test_failed_recovery_marks_runtime_unavailable_instead_of_claiming_ready(self):
        pipe=self.pipe();pipe.fail=RuntimeError('CUDA failure')
        def broken_cleanup():raise RuntimeError('Cannot offload')
        pipe.maybe_free_model_hooks=broken_cleanup;self.m.runtime_pipeline=pipe;job=self.job();self.m.execute_job(job,{'prompt':'a tree'})
        self.assertFalse(self.m.runtime_health['ready']);self.assertEqual(job['error_code'],'RUNTIME_RESET_REQUIRED');self.assertEqual(job['state'],'error');self.assertNotIn('file',job)
    def test_zimage_and_sdxl_reference_images_reach_the_actual_image_to_image_call(self):
        for family in ['zimage','sdxl']:
            with self.subTest(family=family):
                base=self.pipe();reference=self.pipe();self.m.runtime_pipeline=base;self.m.runtime_reference_pipeline=None;self.m.runtime_offload_owner=None;self.m.SETTINGS['media_family']=family
                fake=types.SimpleNamespace(ZImageImg2ImgPipeline=lambda **components:reference,AutoPipelineForImage2Image=types.SimpleNamespace(from_pipe=lambda pipe:reference))
                body={'model':'z-image-turbo','prompt':'change colors','image':self.image()};self.m.validate_generation(body,'image')
                with patch.dict(sys.modules,{'diffusers':fake}):
                    job=self.job('d'*32);self.m.execute_job(job,body)
                self.assertEqual(job['state'],'complete',job.get('error'));kwargs=reference.calls[-1];self.assertEqual(kwargs['image'].getpixel((0,0)),(255,0,0));self.assertEqual(kwargs['strength'],0.6)
                self.assertEqual(kwargs['image'].size,(768,768) if family=='zimage' else (1024,1024))
                if family=='sdxl':self.assertNotIn('width',kwargs);self.assertNotIn('height',kwargs)
                self.assertFalse(base.calls)

if __name__=='__main__':unittest.main()
