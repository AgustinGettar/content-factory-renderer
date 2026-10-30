import base64
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

spec=importlib.util.spec_from_file_location('sqlite_update',Path(__file__).parents[1]/'scripts/trading-aws-sqlite-update.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def fixture():
    b={'schema':1,'state':{'id':'KRAKEN_BTCUSD_PAPER','revision':7},'events':[],'outbox':[],'counts':{'events':0,'outbox':0},'owners':[{'user_id':123,'chat_id':123,'session_chat_id':123,'state_chat_id':'123'}]}
    z=gzip.compress(json.dumps(b).encode())
    p={'export_gzip':base64.b64encode(z).decode(),'export_sha256':hashlib.sha256(z).hexdigest(),'runtime':{'LUMI_TRADING_SITE_ACCESS':'x'*64,'LUMI_TRADING_PUBLISH_KEY':'y'*64,'LUMI_TRADING_BACKUP_KEY':'a'*64}}
    env={'LUMI_TELEGRAM_REVIEW_TEST_USERS':'123','SUPABASE_URL':'https://mofjhwathxzfnjapvvst.supabase.co','SUPABASE_SERVICE_ROLE_KEY':'synthetic'}
    return p,env,b

class MigrationTests(unittest.TestCase):
    def test_verified_bootstrap_does_not_change_payload(self):
        p,env,b=fixture();before=json.dumps(p);result,owner=m.validate_bootstrap(p,env);self.assertEqual(result,b);self.assertEqual(owner,'123');self.assertEqual(json.dumps(p),before)
    def test_checksum_and_owner_mismatch_fail(self):
        p,env,b=fixture();p['export_sha256']='0'*64
        with self.assertRaisesRegex(RuntimeError,'CHECKSUM'):m.validate_bootstrap(p,env)
        p,env,b=fixture();env['LUMI_TELEGRAM_REVIEW_TEST_USERS']='124'
        with self.assertRaisesRegex(RuntimeError,'OWNER'):m.validate_bootstrap(p,env)
    def test_environment_injection_and_extra_fields_fail(self):
        for mutate in [lambda c:c.update(EXEC='x'),lambda c:c.update(LUMI_TRADING_SITE_ACCESS='a'*64+'\nBAD=1'),lambda c:c.update(LUMI_TRADING_BACKUP_KEY='z'*64)]:
            p,env,b=fixture();mutate(p['runtime'])
            with self.assertRaises(RuntimeError):m.validate_bootstrap(p,env)
    def test_source_changed_requires_new_export(self):
        p,env,b=fixture()
        with patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(b'[{"revision":8}]')):
            with self.assertRaisesRegex(RuntimeError,'SOURCE_ADVANCED'):m.source_barrier(env,b)
    def test_matching_revision_and_exact_known_quota_block_are_accepted(self):
        p,env,b=fixture()
        with patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(b'[{"revision":7}]')):m.source_barrier(env,b)
        error=urllib.error.HTTPError('https://example.test',402,'restricted',{},io.BytesIO(b'{"message":"exceed_egress_quota"}'))
        with patch.object(m.urllib.request,'urlopen',side_effect=error):m.source_barrier(env,b)
    def test_other_source_errors_do_not_authorize_stale_import(self):
        p,env,b=fixture()
        for code,body in [(401,b'no'),(500,b'exceed_egress_quota'),(402,b'other')]:
            error=urllib.error.HTTPError('https://example.test',code,'error',{},io.BytesIO(body))
            with patch.object(m.urllib.request,'urlopen',side_effect=error):
                with self.assertRaisesRegex(RuntimeError,'SOURCE_CHECK'):m.source_barrier(env,b)
    def test_another_supabase_project_is_rejected_without_network(self):
        p,env,b=fixture();env['SUPABASE_URL']='https://other.supabase.co'
        with patch.object(m.urllib.request,'urlopen') as mock:
            with self.assertRaisesRegex(RuntimeError,'SOURCE_PROJECT'):m.source_barrier(env,b)
            mock.assert_not_called()

if __name__=='__main__':unittest.main()
