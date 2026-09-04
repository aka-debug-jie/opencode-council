import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('bench_live',ROOT/'benchmark/live.py')
live=importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)

class LiveAdapterTests(unittest.TestCase):
    def test_cold_offline_process_resolves_all_six_from_frozen_catalog(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);auth=root/'fake-auth'
            auth.write_text(json.dumps({'opencode-go':{'type':'api','key':'FAKE_ONLY'}}))
            request={'kind':'council','model':live.LUNA,'id':'cold','prompt':'no inference','timeout_seconds':30}
            stage,args=live.prepare_call(request,root/'call',auth_override=auth,network=False)
            self.assertFalse((stage/'data/cache/opencode/models.json').exists())
            fd=live.go_auth_fd(auth)
            try:
                at=args.index('/data/opencode/auth.json')
                args[at-2:at+1]=['--ro-bind-data',str(fd),'/data/opencode/auth.json']
                live.preflight_models(args,root/'call',fd)
            finally:
                os.close(fd)
            self.assertTrue(live.REQUIRED_MODELS <= set((root/'call/model-preflight.stdout').read_text().splitlines()))
            self.assertFalse((stage/'data/cache/opencode/models.json').exists())

    def test_missing_catalog_model_fails_before_auth_or_opencode(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'benchmark').mkdir()
            (root/'benchmark/model-catalog.json').write_text('{"opencode-go":{"models":{}}}')
            with patch.object(live,'ROOT',root),patch.object(live,'auth_path') as auth:
                with self.assertRaisesRegex(ValueError,'Frozen model catalog missing'):
                    live.prepare_call({'kind':'single','model':live.SINGLE},root/'call')
                auth.assert_not_called()

    def test_preflight_rejection_never_starts_inference(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);auth=root/'fake-auth'
            auth.write_text(json.dumps({'opencode-go':{'type':'api','key':'FAKE_ONLY'}}))
            args=['bwrap','--ro-bind',str(auth),'/data/opencode/auth.json','--chdir','/task','opencode','run']
            with patch.object(live,'prepare_call',return_value=(root,args)),patch.object(live,'auth_path',return_value=auth),patch.object(live,'preflight_models',side_effect=ValueError('unavailable')),patch.object(live,'run_bounded') as run:
                result=live.call({'kind':'single','prompt':'no calls','timeout_seconds':30},root)
                self.assertEqual(result['status'],'failed')
                self.assertEqual(result['error'],'unavailable')
                self.assertEqual(result['observable_tokens'],0)
                self.assertFalse(result['provenance']['inference_started'])
                run.assert_not_called()

    def test_timeout_root_reason_survives_missing_usage_database(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);auth=root/'fake-auth'
            auth.write_text(json.dumps({'opencode-go':{'type':'api','key':'FAKE_ONLY'}}))
            args=['bwrap','--ro-bind',str(auth),'/data/opencode/auth.json','--chdir','/task','opencode','run']
            with patch.object(live,'prepare_call',return_value=(root,args)),patch.object(live,'auth_path',return_value=auth),patch.object(live,'preflight_models'),patch.object(live,'run_bounded',return_value=(-15,'Stage deadline exceeded; process group terminated')):
                result=live.call({'kind':'single','prompt':'no calls','timeout_seconds':30},root)
            self.assertEqual(result['status'],'failed')
            self.assertEqual(result['error'],'Stage deadline exceeded; process group terminated')
            self.assertIn('usage_error',result['provenance'])
            self.assertIsNone(result['observable_tokens'])

    def test_preflight_deadline_retains_precise_reason(self):
        with tempfile.TemporaryDirectory() as d:
            with patch.object(live,'run_bounded',return_value=(-15,'Stage deadline exceeded; process group terminated')):
                with self.assertRaisesRegex(ValueError,'before inference: Stage deadline exceeded'):
                    live.preflight_models(['bwrap','--chdir','/task','opencode','run'],d,0)

    def test_failed_council_keeps_abort_reason_and_known_cost(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);auth=root/'fake-auth'
            auth.write_text(json.dumps({'opencode-go':{'type':'api','key':'FAKE_ONLY'}}))
            states=root/'data/council-state';states.mkdir(parents=True)
            (states/'run.json').write_text(json.dumps({'runId':'fixture','dispatches':[{}],
                'continuations':[],'validated':{},'status':'aborted',
                'abort':{'reason':'retry requires a recorded task failure'}}))
            args=['bwrap','--ro-bind',str(auth),'/data/opencode/auth.json','--chdir','/task','opencode','run']
            usage={'usage':{},'observable_tokens':419363,'matching_tokens':None,'session_ids':[],
                   'provenance':{}}
            with patch.object(live,'prepare_call',return_value=(root,args)),patch.object(live,'auth_path',return_value=auth),patch.object(live,'preflight_models'),patch.object(live,'run_bounded',return_value=(1,None)),patch.object(live,'usage_from_database',return_value=usage):
                result=live.call({'kind':'council','prompt':'no calls','timeout_seconds':30},root)
            self.assertEqual(result['status'],'failed')
            self.assertEqual(result['error'],'OpenCode exited 1; Council aborted: retry requires a recorded task failure')
            self.assertEqual(result['observable_tokens'],419363)
            self.assertEqual(result['provenance']['council_status'],'aborted')

    def test_material_paths_cannot_escape(self):
        with tempfile.TemporaryDirectory() as d:
            for name in ['../rubric.json','/absolute.txt','a/../../escape','opencode.json','opencode.jsonc','AGENTS.md','.opencode/agents/bench.txt']:
                with self.assertRaises(ValueError):
                    live.safe_materials({name:'private'},Path(d)/'task')
            live.safe_materials({'papers/a.txt':'evidence'},Path(d)/'task')
            self.assertEqual((Path(d)/'task/papers/a.txt').read_text(),'evidence')

    def test_actual_namespace_excludes_private_files_and_task_writes(self):
        if not shutil.which('bwrap'):
            self.fail('bwrap required: isolation must be tested, not silently skipped')
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            for name in ['task','runtime/bin','config','data/opencode']:
                (root/name).mkdir(parents=True,exist_ok=True)
            (root/'runtime/bin/opencode').touch()
            (root/'task/material.txt').write_text('public material')
            (root/'rubric.json').write_text('HIDDEN_SCORING_SENTINEL')
            (root/'auth-fixture').write_text('{}')
            code="""from pathlib import Path
assert Path('/task/material.txt').read_text() == 'public material'
assert not Path(%r).exists()
assert not Path('/runtime/rubric.json').exists()
try:
 Path('/task/changed').write_text('bad')
except OSError:
 pass
else:
 raise AssertionError('task writable')
print('isolated')
""" % str(root/'rubric.json')
            argv=live.sandbox_command(root,Path('/usr/bin/true'),root/'auth-fixture',['/usr/bin/python3','-c',code],network=False)
            result=subprocess.run(argv,text=True,capture_output=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.strip(),'isolated')

    def test_usage_uses_unique_database_messages_not_stream_events(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'data.db'
            db=sqlite3.connect(path)
            db.execute('CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT,data TEXT)')
            data={'role':'assistant','providerID':'opencode-go','modelID':'deepseek-v4-pro',
                  'tokens':{'total':130,'input':100,'output':20,'reasoning':10,'cache':{'read':0,'write':0}}}
            db.execute('INSERT INTO message VALUES(?,?,?)',('m1','s1',json.dumps(data)))
            db.commit()
            usage=live.usage_from_database(path)
            self.assertEqual(usage['matching_tokens'],130)
            self.assertEqual(usage['observable_tokens'],130)
            data['tokens']['total']=0
            db.execute('UPDATE message SET data=?',(json.dumps(data),));db.commit()
            self.assertIsNone(live.usage_from_database(path)['matching_tokens'])
            data.pop('tokens')
            db.execute('UPDATE message SET data=?',(json.dumps(data),));db.commit();db.close()
            unknown=live.usage_from_database(path)
            self.assertIsNone(unknown['observable_tokens'])
            self.assertEqual(unknown['known_observable_tokens'],0)

    def test_usage_preserves_known_categories_when_one_is_missing(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'data.db'
            db=sqlite3.connect(path)
            db.execute('CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT,data TEXT)')
            data={'role':'assistant','providerID':'opencode-go','modelID':'deepseek-v4-pro',
                  'tokens':{'total':130,'input':100,'output':20,'reasoning':10,'cache':{'read':5}}}
            db.execute('INSERT INTO message VALUES(?,?,?)',('m1','s1',json.dumps(data)))
            db.commit();db.close()
            usage=live.usage_from_database(path)
            self.assertIsNone(usage['observable_tokens'])
            self.assertEqual(usage['known_observable_tokens'],135)
            self.assertEqual(usage['usage']['input'],100)
            self.assertFalse(usage['provenance']['usage_complete'])

    def test_real_opencode_config_load_offline_with_fake_auth(self):
        binary=shutil.which('opencode')
        if not binary:
            self.fail('OpenCode required for offline adapter compatibility test')
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            for name in ['task','runtime/bin','config/opencode','data/opencode']:
                (root/name).mkdir(parents=True,exist_ok=True)
            (root/'runtime/bin/opencode').touch()
            (root/'auth-fixture').write_text('{}')
            config={'permission':live.READONLY,'agent':{'bench':{'mode':'primary','model':live.SINGLE,'permission':live.READONLY}}}
            (root/'config/opencode/opencode.json').write_text(json.dumps(config))
            args=live.sandbox_command(root,Path(binary).resolve(),root/'auth-fixture',
                                      ['opencode','--pure','debug','agent','bench'],network=False)
            result=subprocess.run(args,text=True,capture_output=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
            data=json.loads(result.stdout)
            self.assertEqual(data['model'],{'providerID':'opencode-go','modelID':'deepseek-v4-pro'})
            deny_bash=[p for p in data['permission'] if p['permission']=='bash']
            self.assertTrue(deny_bash)
            self.assertTrue(all(p['action']=='deny' for p in deny_bash))

    def test_final_report_is_bound_to_normal_stopped_message(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'events'
            def event(kind,message,**kw):
                return {'type':kind,'sessionID':'s','part':{'messageID':message,**kw}}
            events=[event('text','old',text='ignore'),event('text','new',text='answer'),event('step_finish','new',reason='stop')]
            p.write_text('\n'.join(map(json.dumps,events)))
            usage={'provenance':{'actual_models':[live.SINGLE]}}
            self.assertEqual(live.single_report(p,live.SINGLE,usage),'answer')
            with self.assertRaises(ValueError):live.single_report(p,live.LUNA,usage)
            events.append({'type':'error','error':'provider failure'})
            p.write_text('\n'.join(map(json.dumps,events)))
            with self.assertRaises(ValueError):live.single_report(p,live.SINGLE,usage)

    def test_final_answer_requires_all_six_nonempty_ordered_sections(self):
        valid='\n\n'.join('# '+name+'\nEvidence '+str(i) for i,name in enumerate(live.FINAL_SECTIONS))
        self.assertEqual(live.validate_final_answer(valid),valid)
        with self.assertRaisesRegex(ValueError,'six ordered'):
            live.validate_final_answer('Success')
        invalid='\n\n'.join('# '+name+('\nvalue' if i else '') for i,name in enumerate(live.FINAL_SECTIONS))
        with self.assertRaisesRegex(ValueError,'nonempty'):
            live.validate_final_answer(invalid)

    def test_council_plugin_loads_offline_with_pinned_dependencies(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);auth=root/'fake-auth';auth.write_text('{}')
            request={'kind':'council','model':live.LUNA,'id':'offline','prompt':'no calls','timeout_seconds':15}
            stage,argv=live.prepare_call(request,root/'call',auth_override=auth,network=False)
            at=argv.index('--chdir')
            argv=argv[:at+2]+['opencode','debug','agent','debate']
            result=subprocess.run(argv,text=True,capture_output=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
            config=json.loads(result.stdout)
            self.assertEqual(config['model'],{'providerID':'opencode-go','modelID':'gpt-5.6-luna'})
            self.assertTrue(config['hidden'])

    def test_filtered_auth_is_memory_only_and_timeout_reaps_children(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            for name in ['task','runtime/bin','config','data/opencode']:
                (root/name).mkdir(parents=True,exist_ok=True)
            (root/'runtime/bin/opencode').touch()
            auth=root/'fake-auth'
            auth.write_text(json.dumps({'opencode-go':{'type':'api','key':'FAKE_ONLY'},'other-provider':{'type':'wellknown','token':'DO_NOT_PASS'}}))
            fd=live.go_auth_fd(auth)
            try:
                marker='bench-timeout-'+uuid.uuid4().hex
                code="import json,subprocess,time; a=json.load(open('/data/opencode/auth.json')); assert list(a)==['opencode-go']; print('auth-ok',flush=True); subprocess.Popen(['/usr/bin/python3','-c','import time;time.sleep(30)',%r]); time.sleep(30)" % marker
                argv=live.sandbox_command(root,Path('/usr/bin/true'),auth,['/usr/bin/python3','-c',code],network=False)
                at=argv.index('/data/opencode/auth.json');argv[at-2:at+1]=['--ro-bind-data',str(fd),'/data/opencode/auth.json']
                rc,error=live.run_bounded(argv,None,root/'out',root/'err',1,pass_fds=(fd,))
                self.assertNotEqual(rc,0)
                self.assertIn('deadline',error)
                self.assertEqual((root/'out').read_text().strip(),'auth-ok')
                for proc in Path('/proc').iterdir():
                    if not proc.name.isdigit():continue
                    try:command=(proc/'cmdline').read_bytes()
                    except OSError:continue
                    self.assertNotIn(marker.encode(),command)
            finally:
                os.close(fd)

if __name__=='__main__':
    unittest.main()
