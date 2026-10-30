import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('boost_update',Path(__file__).parents[1]/'scripts/trading-aws-boost-update.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class RepairTests(unittest.TestCase):
    def env(self):
        return {'LUMI_RUNTIME_ENV':'staging','LUMI_TRADING_MODE':'PAPER','LUMI_TRADING_PLATFORM':'EC2',
                'LUMI_TRADING_STORAGE':'SQLITE','LUMI_TRADING_DB_PATH':str(m.DB),
                'LUMI_TRADING_AWS_INSTANCE_ID':'i-0ae2ad0bb886f3d7f','LUMI_TRADING_AWS_REGION':'eu-north-1',
                'LUMI_TRADING_SOURCE_BRANCH':'lumi-trading-aws','LUMI_TRADING_SECONDARY_PROFILE':'secondary-growth-1.0.0','LUMI_TRADING_ENTRY_PROFILE':'agile-5bars-1.0.0','LUMI_TRADING_CONTEXT_PROFILE':'context-maker-1.0.0','LUMI_TRADING_MAKER_SIZING':'maker-sizing-1.0.0','LUMI_TRADING_NET_EXITS':'net-exit-1.0.0'}
    def test_only_existing_paper_sqlite_instance_is_accepted(self):
        good=self.env();m.validate_env(good)
        for key in good:
            with self.subTest(key=key),self.assertRaisesRegex(RuntimeError,'PAPER_SQLITE'):
                m.validate_env({**good,key:'other'})
    def test_release_scope_excludes_audiovisual_and_migration_code(self):
        m.validate_scope(['lib/trading/secondary-boost.js','lib/trading/engine.js'])
        for paths in [[],['lib/telegram-review-v1/runtime.js'],['server.js'],['scripts/trading-aws-sqlite-update.py']]:
            with self.assertRaisesRegex(RuntimeError,'OUTSIDE_SECONDARY_BOOST_SCOPE'):m.validate_scope(paths)
    def test_database_access_is_read_by_service_user(self):
        with patch.object(m,'run',return_value='{}') as run:
            m.as_worker(Path('/release'),'readonly')
        self.assertEqual(run.call_args.args[0][:4],['runuser','-u','lumitrading','--'])
    def test_health_requires_market_persistence_backup_and_verified_receipt(self):
        d={'service':{'ActiveState':'active','SubState':'running'},**dict.fromkeys(['heartbeat_recent','market_recent','dashboard_recent','backup_confirmed','telegram_receipt','timeframes_configured','margin_configured','secondary_risk_configured','net_exits_configured','leverage_configured','evaluations_resumed'],True)}
        self.assertTrue(m.complete(d))
        for key in d.keys()-{'service'}:self.assertFalse(m.complete({**d,key:False}))
        self.assertFalse(m.complete({**d,'service':{'ActiveState':'failed','SubState':'failed'}}))
    def test_error_report_keeps_only_safe_fields(self):
        row={'__REALTIME_TIMESTAMP':'123000','MESSAGE':json.dumps({'event':'lumi_trading_worker_attention_required','code':'TRADING_CHAT_LOOKUP_REJECTED','error_class':'Error','frames':['notifier.js:12:3','private-token'],'message':'private-secret'})}
        with patch.object(m,'run',return_value=json.dumps(row)):
            result=m.recent_errors()
        self.assertEqual(result,[{'at':123,'code':'TRADING_CHAT_LOOKUP_REJECTED','error_class':'Error','frames':['notifier.js:12:3']}])
    def scenario(self,mismatch=False,already_running=False):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=Path(temp.name)
        target='a'*40;releases=root/'releases';old=releases/(target if already_running else m.BASE);old.mkdir(parents=True)
        release=releases/target;release.mkdir(exist_ok=True)
        for p in {old,release}:(p/'package-lock.json').write_text('unchanged')
        (old/'node_modules').mkdir()
        if old!=release:(release/'node_modules').symlink_to(old/'node_modules')
        current=root/'current';current.symlink_to(old)
        envpath=root/'worker.env';envpath.write_text('\n'.join(k+'='+v for k,v in self.env().items()));envpath.chmod(0o600)
        if already_running:
            with envpath.open('a') as f:f.write('\nLUMI_TRADING_LEVERAGE_PROFILE=secondary-boost-1.0.0\n')
        db=root/'trading.sqlite';db.write_text('preserved')
        calls=[];clock=[0]
        def run(args,**kwargs):
            calls.append(args)
            if args[0]=='git':
                if 'rev-parse' in args:return Path(args[2]).name
                if 'get-url' in args:return m.ORIGIN
                if '--name-only' in args:return 'lib/trading/secondary-boost.js\nlib/trading/engine.js'
            return ''
        loader=types.SimpleNamespace(exec_module=lambda module:None)
        migration=types.SimpleNamespace(stop_writer=lambda:calls.append(['stop']),switch_to=lambda path:calls.append(['switch',str(path)]))
        valid={'service':{'ActiveState':'active','SubState':'running','MainPID':'123'},**dict.fromkeys(['heartbeat_recent','market_recent','dashboard_recent','backup_confirmed','telegram_receipt','timeframes_configured','margin_configured','secondary_risk_configured','net_exits_configured','leverage_configured','evaluations_resumed'],True)}
        with patch.object(m.os,'geteuid',return_value=0),patch.multiple(m,CURRENT=current,RELEASES=releases,ENV=envpath,DB=db),patch.object(m,'validate_env'),patch.object(m,'run',side_effect=run),patch.object(m,'fingerprint',side_effect=['before','changed' if mismatch else 'before']),patch.object(m,'as_worker',side_effect=lambda *a:calls.append(['backup'])),patch.object(m.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=os.getuid())),patch.object(m.shutil,'disk_usage',return_value=types.SimpleNamespace(free=1024**3)),patch.object(m.importlib.util,'spec_from_file_location',return_value=types.SimpleNamespace(loader=loader)),patch.object(m.importlib.util,'module_from_spec',return_value=migration),patch.object(m,'service',return_value=valid['service']),patch.object(m,'status',side_effect=lambda *a:dict(valid)),patch.object(m.time,'monotonic',side_effect=lambda:clock[0]),patch.object(m.time,'sleep',side_effect=lambda n:clock.__setitem__(0,clock[0]+n)):
            if mismatch:
                with self.assertRaisesRegex(RuntimeError,'STATE_OR_CONFIG_CHANGED'):m.update(target)
                result=None
            else:result=m.update(target)
        self.assertEqual(db.read_text(),'preserved')
        if not mismatch:
            self.assertIn('LUMI_TRADING_LEVERAGE_PROFILE=secondary-boost-1.0.0',envpath.read_text())
            self.assertEqual(envpath.stat().st_mode&0o777,0o600)
        return result,calls
    def test_backup_and_unchanged_database_precede_switch_and_start(self):
        result,calls=self.scenario();self.assertTrue(result['verified']);self.assertTrue(result['stable_65s'])
        indexes={k:next(i for i,c in enumerate(calls) if c[0]==k) for k in ['stop','backup','switch']}
        self.assertLess(indexes['stop'],indexes['backup']);self.assertLess(indexes['backup'],indexes['switch'])
        starts=[i for i,c in enumerate(calls) if c[:2]==['systemctl','start']]
        self.assertEqual(len(starts),1);self.assertLess(indexes['switch'],starts[0])
    def test_changed_database_aborts_before_switch_or_restart(self):
        _,calls=self.scenario(mismatch=True)
        self.assertFalse(any(c[0]=='switch' or c[:2]==['systemctl','start'] for c in calls))
    def test_already_running_target_is_observed_without_stop_or_restart(self):
        result,calls=self.scenario(already_running=True);self.assertTrue(result['verified'])
        self.assertFalse(any(c[0] in {'stop','backup','switch','systemctl'} for c in calls))

if __name__=='__main__':unittest.main()
