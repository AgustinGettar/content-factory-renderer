import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('context_update', Path(__file__).parents[1] / 'scripts/trading-aws-context-update.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ContextUpdateTests(unittest.TestCase):
    def env(self):
        return {'LUMI_RUNTIME_ENV': 'staging', 'LUMI_TRADING_MODE': 'PAPER',
                'LUMI_TRADING_PLATFORM': 'EC2', 'LUMI_TRADING_STORAGE': 'SQLITE',
                'LUMI_TRADING_DB_PATH': str(m.DB),
                'LUMI_TRADING_AWS_INSTANCE_ID': 'i-0ae2ad0bb886f3d7f',
                'LUMI_TRADING_AWS_REGION': 'eu-north-1',
                'LUMI_TRADING_SOURCE_BRANCH': 'lumi-trading-aws',
                'LUMI_TRADING_SECONDARY_PROFILE': 'secondary-growth-1.0.0',
                'LUMI_TRADING_ENTRY_PROFILE': 'agile-5bars-1.0.0',
                'LUMI_TRADING_CONTEXT_PROFILE': 'context-maker-1.0.0',
                'LUMI_TRADING_MAKER_SIZING': 'maker-sizing-1.0.0',
                'LUMI_TRADING_NET_EXITS': 'net-exit-1.0.0',
                'LUMI_TRADING_LEVERAGE_PROFILE': 'secondary-boost-1.0.0',
                'LUMI_TRADING_CAPACITY_PROFILE': 'secondary-capacity-1.0.0'}

    def valid_health(self):
        return {'service': {'ActiveState': 'active', 'SubState': 'running', 'MainPID': '123',
                            'UnitFileState': 'enabled', 'Restart': 'on-failure'},
                **dict.fromkeys(m.HEALTH_KEYS, True), 'remote_backup_error': 'BACKUP_UPLOAD_FAILED'}

    def test_only_existing_paper_instance_and_profiles_are_accepted(self):
        good = self.env()
        m.validate_env(good)
        for key in good:
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'PAPER_SQLITE'):
                m.validate_env({**good, key: 'other'})

    def test_scope_rejects_unrelated_code_and_infrastructure(self):
        m.validate_scope(['lib/trading/notifier.js', 'lib/trading/engine.js'])
        for paths in [[], ['server.js'], ['scripts/trading-worker.mjs'],
                      ['lib/trading/simulator.js'], ['lib/trading/frequency.js'], ['scripts/trading-aws-sqlite-update.py']]:
            with self.subTest(paths=paths), self.assertRaisesRegex(RuntimeError, 'OUTSIDE_CONTEXT_RECOVERY_SCOPE'):
                m.validate_scope(paths)

    def test_health_requires_continuity_without_waiting_for_an_entry_or_remote_backup(self):
        good = self.valid_health()
        self.assertTrue(m.complete(good))
        for key in m.HEALTH_KEYS:
            self.assertFalse(m.complete({**good, key: False}), key)
        for key, value in [('ActiveState', 'failed'), ('SubState', 'dead'),
                           ('UnitFileState', 'disabled'), ('Restart', 'no')]:
            self.assertFalse(m.complete({**good, 'service': {**good['service'], key: value}}))

    def test_database_process_runs_as_service_user(self):
        with patch.object(m, 'run', return_value='{}') as call:
            m.as_worker(Path('/release'), 'readonly')
        self.assertEqual(call.call_args.args[0][:4], ['runuser', '-u', 'lumitrading', '--'])

    def transaction(self, fail=None, was_running=True):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        old, release = root / 'old', root / 'new'
        old.mkdir()
        release.mkdir()
        current = root / 'current'
        current.symlink_to(old)
        config = b'PRIVATE_CONFIGURATION_UNCHANGED\n'
        envpath = root / 'worker.env'
        envpath.write_bytes(config)
        db = root / 'trading.sqlite'
        db.write_bytes(b'COMPLETE_LEDGER_UNCHANGED')
        calls = []

        def stop():
            calls.append('stop')
            if fail == 'stop':
                raise RuntimeError('STOP_FAILED')

        def switch(path):
            calls.append(('switch', path.name))
            current.unlink()
            current.symlink_to(path)
            if fail == 'switch' and path == release:
                raise RuntimeError('SWITCH_RESPONSE_FAILED')

        def run(args, **kwargs):
            calls.append(tuple(args))
            if fail == 'start' and args[:2] == ['systemctl', 'start']:
                raise RuntimeError('START_RESPONSE_FAILED')
            return ''

        hashes = ['same', 'wrong' if fail == 'backup' else 'same',
                  'changed' if fail == 'database' else 'same']
        migration = types.SimpleNamespace(stop_writer=stop, switch_to=switch)
        with patch.multiple(m, CURRENT=current, ENV=envpath, DB=db), \
             patch.object(m, 'run', side_effect=run), \
             patch.object(m, 'fingerprint', side_effect=hashes), \
             patch.object(m, 'as_worker', side_effect=lambda *a: calls.append('backup')):
            if fail:
                with self.assertRaises(RuntimeError):
                    m.prepare_and_start(migration, old, release, config, was_running)
                backup = None
            else:
                backup = m.prepare_and_start(migration, old, release, config, was_running)
        self.assertEqual(envpath.read_bytes(), config)
        self.assertEqual(db.read_bytes(), b'COMPLETE_LEDGER_UNCHANGED')
        return calls, current.resolve().name, backup

    def test_verified_backup_and_preservation_precede_switch_and_start(self):
        calls, current, backup = self.transaction()
        self.assertEqual(current, 'new')
        self.assertIsNotNone(backup)
        self.assertLess(calls.index('stop'), calls.index('backup'))
        self.assertLess(calls.index('backup'), calls.index(('switch', 'new')))
        self.assertLess(calls.index(('switch', 'new')), calls.index(('systemctl', 'start', 'lumi-trading.service')))
        self.assertEqual(calls.count(('systemctl', 'start', 'lumi-trading.service')), 1)

    def test_backup_or_database_mismatch_resumes_previous_service(self):
        for failure in ['backup', 'database', 'stop']:
            with self.subTest(failure=failure):
                calls, current, _ = self.transaction(failure)
                self.assertEqual(current, 'old')
                self.assertNotIn(('switch', 'new'), calls)
                self.assertEqual(calls.count(('systemctl', 'start', 'lumi-trading.service')), 1)

    def test_uncertain_switch_before_new_start_restores_previous_release(self):
        calls, current, _ = self.transaction('switch')
        self.assertEqual(current, 'old')
        self.assertIn(('switch', 'old'), calls)
        self.assertLess(calls.index(('switch', 'old')), calls.index(('systemctl', 'start', 'lumi-trading.service')))

    def test_failed_target_start_never_rolls_back_new_activity(self):
        calls, current, _ = self.transaction('start')
        self.assertEqual(current, 'new')
        self.assertNotIn(('switch', 'old'), calls)
        self.assertEqual(calls.count(('systemctl', 'start', 'lumi-trading.service')), 1)

    def test_failed_preparation_does_not_start_previously_inactive_worker(self):
        calls, current, _ = self.transaction('database', was_running=False)
        self.assertEqual(current, 'old')
        self.assertNotIn(('systemctl', 'start', 'lumi-trading.service'), calls)

    def test_already_running_target_is_not_stopped_or_restarted(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        target = 'a' * 40
        releases = root / 'releases'
        release = releases / target
        release.mkdir(parents=True)
        (release / 'package-lock.json').write_text('unchanged')
        (release / 'node_modules').mkdir()
        current = root / 'current'
        current.symlink_to(release)
        envpath = root / 'worker.env'
        envpath.write_text('\n'.join(k + '=' + v for k, v in self.env().items()))
        envpath.chmod(0o600)
        config = envpath.read_bytes()
        db = root / 'trading.sqlite'
        db.write_text('unchanged')
        calls = []
        clock = [0]

        def run(args, **kwargs):
            calls.append(args)
            if args[0] == 'git':
                if 'rev-parse' in args:
                    return target
                if 'get-url' in args:
                    return m.ORIGIN
                if '--name-only' in args:
                    return 'lib/trading/notifier.js\nlib/trading/engine.js'
            return ''

        loader = types.SimpleNamespace(exec_module=lambda module: None)
        good = self.valid_health()
        with patch.object(m.os, 'geteuid', return_value=0), \
             patch.multiple(m, CURRENT=current, RELEASES=releases, ENV=envpath, DB=db), \
             patch.object(m, 'validate_env'), patch.object(m, 'run', side_effect=run), \
             patch.object(m, 'preflight_state'), \
             patch.object(m, 'prepare_and_start') as restart, \
             patch.object(m.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_uid=os.getuid())), \
             patch.object(m.importlib.util, 'spec_from_file_location', return_value=types.SimpleNamespace(loader=loader)), \
             patch.object(m.importlib.util, 'module_from_spec', return_value=types.SimpleNamespace()), \
             patch.object(m, 'service', return_value=good['service']), \
             patch.object(m, 'status', side_effect=lambda *a: dict(good)), \
             patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(m.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0] + n)):
            result = m.update(target)
        self.assertTrue(result['verified'])
        self.assertTrue(result['stable_65s'])
        self.assertFalse(result['backup_created'])
        restart.assert_not_called()
        self.assertFalse(any(c[0] == 'systemctl' for c in calls))
        self.assertEqual(envpath.read_bytes(), config)
        self.assertEqual(db.read_text(), 'unchanged')

    def test_error_report_excludes_secret_messages_and_frames(self):
        row = {'__REALTIME_TIMESTAMP': '123000', 'MESSAGE': json.dumps({
            'event': 'lumi_trading_worker_attention_required', 'code': 'TRADING_STATE_VERSION_UNSUPPORTED',
            'error_class': 'Error', 'frames': ['engine.js:12:3', 'private-token'], 'message': 'secret'})}
        with patch.object(m, 'run', return_value=json.dumps(row)):
            result = m.recent_errors()
        self.assertEqual(result, [{'at': 123, 'code': 'TRADING_STATE_VERSION_UNSUPPORTED',
                                   'error_class': 'Error', 'frames': ['engine.js:12:3']}])


if __name__ == '__main__':
    unittest.main()
