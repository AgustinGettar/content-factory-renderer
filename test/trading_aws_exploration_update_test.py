import importlib.util
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('exploration_update', Path(__file__).parents[1] / 'scripts/trading-aws-exploration-update.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class ExplorationDeploymentTests(unittest.TestCase):
    def test_update_preserves_every_unrelated_setting_and_secret_value(self):
        source = '# existing worker\nLUMI_TRADING_MODE=PAPER\nTOKEN="test-only=a=b"\nLUMI_TRADING_SECONDARY_PROFILE=secondary-growth-1.0.0\n'
        changed = M.updated_env(source, M.PROFILE, '100')
        self.assertIn('TOKEN="test-only=a=b"\n', changed)
        self.assertEqual(M.read_env(changed)['LUMI_TRADING_SECONDARY_PROFILE'], M.PROFILE)
        self.assertEqual(M.updated_env(changed, M.PROFILE, '100'), changed)
        self.assertEqual(M.read_env(M.updated_env(changed, 'OFF', '100'))['LUMI_TRADING_SECONDARY_PROFILE'], 'OFF')

    def test_real_mode_and_other_instance_are_never_deployed(self):
        env = {'LUMI_RUNTIME_ENV': 'staging', 'LUMI_TRADING_MODE': 'PAPER', 'LUMI_TRADING_PLATFORM': 'EC2',
               'LUMI_TRADING_STORAGE': 'SQLITE', 'LUMI_TRADING_DB_PATH': str(M.DB),
               'LUMI_TRADING_AWS_REGION': 'eu-north-1', 'LUMI_TRADING_AWS_INSTANCE_ID': 'i-0ae2ad0bb886f3d7f',
               'LUMI_TRADING_SOURCE_BRANCH': 'lumi-trading-aws', 'LUMI_TRADING_SECONDARY_EXECUTION': 'secondary-futures-1.0.0'}
        M.validate_env(env)
        for key, value in [('LUMI_TRADING_MODE', 'LIVE'), ('LUMI_TRADING_AWS_INSTANCE_ID', 'another'), ('LUMI_TRADING_SOURCE_BRANCH', 'main')]:
            with self.assertRaisesRegex(RuntimeError, 'AUTHORIZED_PAPER'):
                M.validate_env({**env, key: value})


class IsolatedDeploymentTests(unittest.TestCase):
    """Real temporary Git/SQLite/filesystem; the service and migration are mocked.

    All origins are local directories. No AWS, network, real service or worker DB.
    """

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='lumi-deploy-isolated-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.releases = self.root / 'releases'
        self.releases.mkdir()
        self.old = self.releases / 'active'
        self.old.mkdir()
        self.remote = self.root / 'origin.git'
        self.git('init', '--bare', str(self.remote), cwd=self.root)
        self.git('init', '-b', M.BRANCH)
        self.git('config', 'user.name', 'Isolated deployment test')
        self.git('config', 'user.email', 'isolated@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.relative = 'lib/trading/secondary-exploration.js'
        self.tracked = self.old / self.relative
        self.tracked.parent.mkdir(parents=True)
        self.tracked.write_text('old isolated source\n')
        self.git('add', self.relative)
        self.git('commit', '-m', 'isolated baseline')
        self.before = self.git('rev-parse', 'HEAD')
        self.tracked.write_text('new isolated source\n')
        self.git('commit', '-am', 'isolated candidate')
        self.target = self.git('rev-parse', 'HEAD')
        self.git('remote', 'add', 'origin', str(self.remote))
        self.git('push', 'origin', 'HEAD:refs/heads/' + M.BRANCH)
        self.git('checkout', '--detach', self.before)
        (self.old / 'node_modules').mkdir()
        (self.old / 'node_modules' / 'existing-dependency').write_text('same dependency\n')
        self.current = self.root / 'current'
        self.current.symlink_to(self.old, target_is_directory=True)
        self.db = self.root / 'data' / 'trading.sqlite'
        self.db.parent.mkdir()
        with sqlite3.connect(self.db) as conn:
            conn.execute('CREATE TABLE isolated_marker(value TEXT)')
            conn.execute("INSERT INTO isolated_marker VALUES ('original ledger remains intact')")
        self.db_hash = hashlib.sha256(self.db.read_bytes()).hexdigest()
        self.env = self.root / 'worker.env'
        values = {'LUMI_RUNTIME_ENV': 'staging', 'LUMI_TRADING_MODE': 'PAPER',
                  'LUMI_TRADING_PLATFORM': 'EC2', 'LUMI_TRADING_STORAGE': 'SQLITE',
                  'LUMI_TRADING_DB_PATH': str(self.db), 'LUMI_TRADING_AWS_REGION': 'eu-north-1',
                  'LUMI_TRADING_AWS_INSTANCE_ID': 'i-0ae2ad0bb886f3d7f',
                  'LUMI_TRADING_SOURCE_BRANCH': M.BRANCH,
                  'LUMI_TRADING_SECONDARY_EXECUTION': 'secondary-futures-1.0.0',
                  'LUMI_TRADING_SECONDARY_PROFILE': 'secondary-growth-1.0.0',
                  'UNRELATED_TEST_VALUE': 'preserve-this'}
        self.original_env = ''.join(key + '=' + value + '\n' for key, value in values.items())
        self.env.write_text(self.original_env)
        os.chmod(self.env, 0o640)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for key, value in {'CURRENT': self.current, 'RELEASES': self.releases,
                           'ENV': self.env, 'DB': self.db, 'ORIGIN': str(self.remote)}.items():
            self.stack.enter_context(patch.object(M, key, value))
        self.actions = []
        original_run = M.run

        def run(args, cwd=None, timeout=45):
            if args[0] == 'systemctl':
                self.actions.append({'action': args[1], 'env': self.env.read_text(),
                                     'release': self.current.resolve()})
                return 'active' if args[1] == 'is-active' else ''
            return original_run(args, cwd=cwd, timeout=timeout)

        self.stack.enter_context(patch.object(M, 'run', side_effect=run))
        self.migration = self.stack.enter_context(patch.object(
            M, 'verify_migration', return_value={'compatible': True, 'idempotent': True}))
        self.stack.enter_context(patch.object(M, 'snapshot', return_value={
            'revision': 20, 'state': {}, 'counts': {'events': 10, 'outbox': 2}}))
        self.wait_active = self.stack.enter_context(patch.object(M, 'wait_active', return_value={
            'revision': 21, 'profile': M.PROFILE, 'profile_active': True,
            'counts': {'events': 11, 'outbox': 3}}))

    def git(self, *args, cwd=None):
        result = subprocess.run(['git', *args], cwd=cwd or self.old,
                                capture_output=True, text=True, check=True, timeout=15)
        return result.stdout.strip()

    def deploy(self, target=None):
        with patch.object(sys, 'argv', ['isolated-update', target or self.target,
                                       '--expected-current', self.before]), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            M.main()
        return json.loads(output.getvalue().splitlines()[-1])

    def candidate(self):
        release = self.releases / self.target
        self.git('clone', '--shared', '--no-checkout', str(self.old), str(release), cwd=self.root)
        self.git('checkout', '--detach', self.target, cwd=release)
        return release

    def assert_source_and_ledger_preserved(self):
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.before)
        self.assertEqual(self.tracked.read_text(), 'old isolated source\n')
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), self.db_hash)

    def test_success_fetches_through_active_repo_and_reuses_exact_dependencies(self):
        report = self.deploy()
        release = self.releases / self.target
        self.assertEqual(report['status'], 'DEPLOYED')
        self.assertEqual(self.current.resolve(), release)
        self.assertEqual(self.git('rev-parse', 'HEAD', cwd=release), self.target)
        self.assertEqual(self.git('rev-parse', 'FETCH_HEAD'), self.target)
        self.assertFalse((release / '.git' / 'FETCH_HEAD').exists(), 'candidate never needs remote credentials')
        self.assertEqual((release / 'node_modules').resolve(), (self.old / 'node_modules').resolve())
        self.assertEqual([row['action'] for row in self.actions], ['stop', 'start'])
        self.assertEqual(M.read_env(self.env.read_text()), {
            **M.read_env(self.original_env),
            'LUMI_TRADING_SECONDARY_PROFILE': M.PROFILE,
            'LUMI_TRADING_SECONDARY_NOMINAL_USD': '100',
        })
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o640)
        self.assertEqual(report['backup']['disk_space']['margin_bytes'], 256 * 1024 * 1024)
        self.assert_source_and_ledger_preserved()

    def test_mismatched_remote_head_stops_before_service_or_configuration_changes(self):
        with self.assertRaisesRegex(RuntimeError, 'TRADING_BRANCH_HEAD_CHANGED'):
            self.deploy(target=self.before)
        self.assertEqual(self.actions, [])
        self.assertEqual(self.env.read_text(), self.original_env)
        self.assertEqual(self.current.resolve(), self.old)
        self.assert_source_and_ledger_preserved()

    def test_branch_advance_during_preflight_is_rechecked_before_stop(self):
        def preflight(*args):
            self.git('update-ref', 'refs/heads/' + M.BRANCH, self.before, cwd=self.remote)
            return {'compatible': True}
        self.migration.side_effect = preflight
        with self.assertRaisesRegex(RuntimeError, 'TRADING_BRANCH_HEAD_CHANGED'):
            self.deploy()
        self.assertEqual(self.actions, [])
        self.assertEqual(self.env.read_text(), self.original_env)
        self.assert_source_and_ledger_preserved()

    def test_staged_changes_in_the_active_release_are_preserved_and_block_deploy(self):
        self.tracked.write_text('unpublished user change\n')
        self.git('add', self.relative)
        with self.assertRaisesRegex(RuntimeError, 'COMMAND_FAILED_GIT'):
            self.deploy()
        self.assertEqual(self.actions, [])
        self.assertEqual(self.git('show', ':' + self.relative), 'unpublished user change')
        self.assertEqual(self.env.read_text(), self.original_env)

    def test_dirty_existing_candidate_is_not_treated_as_the_tested_commit(self):
        release = self.candidate()
        (release / self.relative).write_text('different untested candidate\n')
        with self.assertRaisesRegex(RuntimeError, 'COMMAND_FAILED_GIT'):
            self.deploy()
        self.assertEqual(self.actions, [])
        self.assert_source_and_ledger_preserved()

    def test_existing_candidate_with_different_dependencies_is_rejected(self):
        release = self.candidate()
        (release / 'node_modules').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'UNEXPECTED_DEPENDENCIES'):
            self.deploy()
        self.assertEqual(self.actions, [])
        self.assert_source_and_ledger_preserved()

    def test_configuration_change_during_preflight_is_preserved_before_stop(self):
        external = self.original_env + 'USER_CONCURRENT_CHANGE=kept\n'
        def preflight(*args):
            self.env.write_text(external)
            return {'compatible': True}
        self.migration.side_effect = preflight
        with self.assertRaisesRegex(RuntimeError, 'WORKER_CONFIGURATION_CHANGED'):
            self.deploy()
        self.assertEqual(self.actions, [])
        self.assertEqual(self.env.read_text(), external)
        self.assert_source_and_ledger_preserved()

    def test_concurrent_release_change_is_preserved_before_stop(self):
        external = self.root / 'external-release'
        external.mkdir()
        def preflight(*args):
            self.current.unlink()
            self.current.symlink_to(external, target_is_directory=True)
            return {'compatible': True}
        self.migration.side_effect = preflight
        with self.assertRaisesRegex(RuntimeError, 'DEPLOYED_RELEASE_CHANGED'):
            self.deploy()
        self.assertEqual(self.actions, [])
        self.assertEqual(self.current.resolve(), external)
        self.assertEqual(self.env.read_text(), self.original_env)

    def test_final_quiescent_lease_does_not_overwrite_a_concurrent_configuration(self):
        external = self.original_env + 'USER_CONCURRENT_CHANGE=kept\n'
        calls = 0
        def preflight(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.env.write_text(external)
            return {'compatible': True}
        self.migration.side_effect = preflight
        with self.assertRaisesRegex(RuntimeError, 'WORKER_CONFIGURATION_CHANGED'):
            self.deploy()
        self.assertEqual([row['action'] for row in self.actions], ['stop', 'start'])
        self.assertEqual(self.actions[-1]['env'], external)
        self.assertEqual(self.env.read_text(), external)
        self.assertEqual(self.current.resolve(), self.old)
        self.assert_source_and_ledger_preserved()

    def test_failure_after_env_write_before_swap_restores_env_before_old_binary_start(self):
        # A genuine filesystem failure between the two mutations.
        self.current.with_name('current.exploration-next').mkdir()
        with self.assertRaises(FileExistsError):
            self.deploy()
        self.assertEqual([row['action'] for row in self.actions], ['stop', 'start'])
        self.assertEqual(self.actions[-1]['env'], self.original_env)
        self.assertEqual(self.actions[-1]['release'], self.old)
        self.assertEqual(self.env.read_text(), self.original_env)
        self.assertEqual(self.current.resolve(), self.old)
        self.assert_source_and_ledger_preserved()

    def test_failed_start_after_swap_keeps_compatible_binary_and_disables_profile(self):
        self.wait_active.side_effect = RuntimeError('DEPLOYMENT_NOT_CONFIRMED')
        with self.assertRaisesRegex(RuntimeError, 'DEPLOYMENT_NOT_CONFIRMED'):
            self.deploy()
        self.assertEqual([row['action'] for row in self.actions], ['stop', 'start', 'stop', 'start'])
        self.assertEqual(self.current.resolve(), self.releases / self.target)
        self.assertEqual(M.read_env(self.actions[-1]['env'])['LUMI_TRADING_SECONDARY_PROFILE'], 'OFF')
        self.assertEqual(M.read_env(self.env.read_text())['UNRELATED_TEST_VALUE'], 'preserve-this')
        self.assert_source_and_ledger_preserved()

    def test_backup_space_gate_uses_database_bytes_plus_margin_before_stopping(self):
        with patch.object(M.shutil, 'disk_usage', return_value=SimpleNamespace(free=self.db.stat().st_size)):
            with self.assertRaisesRegex(RuntimeError, 'BACKUP_DISK_SPACE_INSUFFICIENT'):
                self.deploy()
        self.assertEqual(self.actions, [])
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual(self.env.read_text(), self.original_env)
        self.assert_source_and_ledger_preserved()


if __name__ == '__main__':
    unittest.main()
