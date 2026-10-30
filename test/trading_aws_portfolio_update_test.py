import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

path=Path(__file__).resolve().parents[1]/'scripts/trading-aws-portfolio-update.py'
spec=importlib.util.spec_from_file_location('update',path);update=importlib.util.module_from_spec(spec);spec.loader.exec_module(update)
TARGET='b'*40


class UpdateTests(unittest.TestCase):
    def test_public_release_readable_by_worker_and_private_umask_restored(self):
        with tempfile.TemporaryDirectory() as temp:
            release=Path(temp)/'release'
            def fake_git(args):
                release.mkdir();(release/'code.js').write_text('public code')
            previous=os.umask(0o077)
            try:
                with patch.object(update,'run',side_effect=fake_git):update.create_worktree(Path(temp),release,TARGET)
                self.assertEqual(release.stat().st_mode&0o777,0o755)
                self.assertEqual((release/'code.js').stat().st_mode&0o777,0o644)
                restored=os.umask(0o077);self.assertEqual(restored,0o077)
            finally:os.umask(previous)

    def exercise(self,committed=None,scope_bad=False,preflight_error=False,success=False):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);releases=root/'releases';releases.mkdir()
            old=releases/update.BASE;new=releases/TARGET;old.mkdir();new.mkdir()
            for release in [old,new]:(release/'package-lock.json').write_text('unchanged-lock')
            (old/'node_modules').mkdir()
            current=root/'current';current.symlink_to(old)
            calls=[];reads=0
            def run(args,**kwargs):
                calls.append(args)
                if args[0]=='git':
                    if 'rev-parse' in args:return TARGET if str(new) in args else update.BASE
                    if 'get-url' in args:return update.ORIGIN
                    if '--name-only' in args:return 'server.js' if scope_bad else 'lib/trading/engine.js'
                    return ''
                if args[:2]==['systemctl','show']:return 'active' if current.resolve()==new else 'inactive'
                return ''
            def inspect(release,env,apply_check=False):
                nonlocal reads
                if apply_check:
                    if preflight_error:raise RuntimeError('NOT_UNUSED')
                    return {'initial_cash':None}
                reads+=1
                if success:return {'portfolio_committed':True,'heartbeat_recent':True,'frequency_initial_cash':'100','frequency_equity':'100','revision':2,'updated_at':'fixture'}
                if reads==1:raise RuntimeError('LOST_REPLY')
                if committed is None:raise RuntimeError('READ_STILL_UNAVAILABLE')
                return {'portfolio_committed':committed}
            with patch.object(update,'CURRENT',current),patch.object(update,'RELEASES',releases),\
                 patch.object(update,'run',side_effect=run),patch.object(update,'env_values',return_value={}),\
                 patch.object(update,'inspect_portfolio',side_effect=inspect),patch.object(update.os,'geteuid',return_value=0),\
                 redirect_stdout(io.StringIO()) as out:
                if success:update.update(TARGET)
                else:
                    with self.assertRaises(RuntimeError):update.update(TARGET)
                final=current.resolve().name
            return final,calls,out.getvalue()

    def test_success_stages_then_stops_and_starts_only_trading(self):
        final,calls,out=self.exercise(success=True)
        self.assertEqual(final,TARGET);self.assertEqual(json.loads(out)['frequency_initial_cash'],'100')
        services=[a for a in calls if a[0]=='systemctl']
        self.assertTrue(all('lumi-trading.service' in a for a in services))
        self.assertEqual(sum(a[:2]==['systemctl','start'] for a in calls),1)

    def test_preflight_failure_keeps_old_worker_running(self):
        final,calls,_=self.exercise(preflight_error=True)
        self.assertEqual(final,update.BASE);self.assertFalse(any(a[0]=='systemctl' for a in calls))

    def test_unrelated_file_change_rejected_before_stop(self):
        final,calls,_=self.exercise(scope_bad=True)
        self.assertEqual(final,update.BASE);self.assertFalse(any(a[0]=='systemctl' for a in calls))

    def test_lost_reply_after_committed_portfolio_never_restores_old_policy(self):
        final,calls,_=self.exercise(committed=True)
        self.assertEqual(final,TARGET);self.assertEqual(sum(a[:2]==['systemctl','start'] for a in calls),1)

    def test_unknown_commit_status_does_not_restore_old_policy(self):
        final,_,_=self.exercise(committed=None)
        self.assertEqual(final,TARGET)

    def test_known_uncommitted_failure_restores_previous_release(self):
        final,calls,_=self.exercise(committed=False)
        self.assertEqual(final,update.BASE);self.assertEqual(sum(a[:2]==['systemctl','start'] for a in calls),2)


if __name__=='__main__':unittest.main()
