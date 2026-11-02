import importlib.util
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
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

    def test_omitted_profit_options_preserve_current_policy_and_parameters_exactly(self):
        source = ('UNRELATED="keep=a=b"\nLUMI_TRADING_SECONDARY_PROFIT_POLICY="' + M.PROFIT_POLICY + '"\n'
                  'LUMI_TRADING_SECONDARY_MIN_EXPECTED_NET_TARGET_FRACTION=0.004\n'
                  'LUMI_TRADING_SECONDARY_TRAILING_RETRACEMENT_FRACTION=.3\n'
                  'LUMI_TRADING_SECONDARY_TRAILING_EXTENSION_MS=1200000\n'
                  'LUMI_TRADING_SECONDARY_TRAILING_STAGNATION_MS=300000\n')
        changed = M.updated_env(source, M.PROFILE, '100', M.profit_env_changes())
        self.assertTrue(changed.startswith(source))
        for key in M.PROFIT_ENV_KEYS:
            self.assertEqual(M.read_env(changed)[key], M.read_env(source)[key])

    def test_explicit_profit_configuration_is_idempotent_and_off_keeps_parameters(self):
        changes = M.profit_env_changes(M.PROFIT_POLICY, '0.002', '0.25', '900000', '600000')
        self.assertEqual(list(changes.values()), [M.PROFIT_POLICY, '0.002', '0.25', '900000', '600000'])
        updated = M.updated_env('UNRELATED=kept\n', M.PROFILE, '100', changes)
        self.assertEqual(M.updated_env(updated, M.PROFILE, '100', changes), updated)
        off = M.read_env(M.updated_env(updated, M.PROFILE, '100', M.profit_env_changes('OFF')))
        self.assertEqual(off['LUMI_TRADING_SECONDARY_PROFIT_POLICY'], 'OFF')
        self.assertEqual(off['LUMI_TRADING_SECONDARY_PROFILE'], M.PROFILE)
        self.assertEqual(off['LUMI_TRADING_SECONDARY_MIN_EXPECTED_NET_TARGET_FRACTION'], '0.002')
        self.assertEqual(off['UNRELATED'], 'kept')

    def test_profit_parameters_require_an_explicit_valid_active_flag(self):
        with self.assertRaisesRegex(RuntimeError, 'PROFIT_POLICY_FLAG_REQUIRED'):
            M.profit_env_changes(min_expected_net_target_fraction='0.002')
        with self.assertRaisesRegex(RuntimeError, 'PROFIT_PARAMETERS_REQUIRE_ACTIVE_POLICY'):
            M.profit_env_changes('OFF', trailing_retracement_fraction='0.25')
        with self.assertRaisesRegex(RuntimeError, 'PROFIT_POLICY_VERSION_UNSUPPORTED'):
            M.profit_env_changes('LIVE')
        for fraction in ['0', '-.2', '1', 'Infinity', 'NaN', '1e-3', '', '$(ignored)']:
            with self.subTest(fraction=fraction), self.assertRaisesRegex(RuntimeError, 'PROFIT_FRACTION_INVALID'):
                M.profit_env_changes(M.PROFIT_POLICY, fraction)
        for duration in ['0', '-1', '1.5', '86400001', 'NaN']:
            with self.subTest(duration=duration), self.assertRaisesRegex(RuntimeError, 'PROFIT_DURATION_INVALID'):
                M.profit_env_changes(M.PROFIT_POLICY, trailing_extension_ms=duration)

    def test_wait_active_requires_the_effective_policy_hash_parameters_and_state(self):
        expected = {'version': M.PROFIT_POLICY, 'active': True, 'policy_hash': 'a' * 64,
                    'policy': {'min_expected_net_target_fraction': '0.002'}}
        row = {'revision': 21, 'state': {'secondaryExecution': {
            'exploration': {'active': True, 'version': M.PROFILE}, 'profit_policy': expected}},
            'counts': {'events': 3, 'outbox': 2}}
        with patch.object(M, 'run', return_value='active'), patch.object(M, 'snapshot', return_value=row):
            result = M.wait_active(20, True, expected)
        self.assertEqual(result['profit_policy'], expected)
        for wrong in [{**expected, 'active': False}, {**expected, 'policy_hash': 'b' * 64},
                      {**expected, 'policy': {'min_expected_net_target_fraction': '0.0002'}}, None]:
            altered = {**row, 'state': {'secondaryExecution': {**row['state']['secondaryExecution'], 'profit_policy': wrong}}}
            with self.subTest(wrong=wrong), patch.object(M, 'run', return_value='active'), \
                    patch.object(M, 'snapshot', return_value=altered), patch.object(M.time, 'sleep'), \
                    patch.object(M.time, 'monotonic', side_effect=[0, 1, 46]), \
                    self.assertRaisesRegex(RuntimeError, 'DEPLOYMENT_NOT_CONFIRMED'):
                M.wait_active(20, True, expected)


class IsolatedMigrationTests(unittest.TestCase):
    """Actual pure Node migration over a read-only temporary SQLite database."""

    def test_profit_migration_is_idempotent_preserves_existing_contracts_and_never_writes_source(self):
        repository = Path(__file__).parents[1]
        node = shutil.which('node')
        self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory(prefix='lumi-profit-migration-isolated-') as directory:
            database = Path(directory) / 'isolated.sqlite'
            seed = """
import {DatabaseSync} from 'node:sqlite';
import {hash} from './lib/trading/core.js';
import {newAccount} from './lib/trading/simulator.js';
import {enablePortfolio} from './lib/trading/portfolio.js';
import {initializeSecondary,SECONDARY_MODEL} from './lib/trading/secondary-futures-engine.js';
import {installExploration,explorationContract,EXPLORATION_POLICY,EXPLORATION_VERSION} from './lib/trading/secondary-exploration.js';
import {installEntryRevision} from './lib/trading/secondary-entry-context.js';
const at=1793601000000,account=newAccount();enablePortfolio(account);
const root={frequency:{account},laboratory:{status:'RESEARCH_COMPLETE',trial:'REJECTED'},primary:{cash:'101',position:{id:'untouched'}}};
initializeSecondary(root,at);installEntryRevision(root,at);
installExploration(root,{LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION},at);
function plan(id){const contract=explorationContract(EXPLORATION_POLICY,'PULLBACK',at);const p={id,execution_model:SECONDARY_MODEL,pattern:'PULLBACK',direction:'SHORT',entry:'80000',target:'78000',stop:'81000',decision_at:at,expires_at:contract.expires_at,holding_ms:1800000,execution_contract:contract,sizing:{qty:'.0012',qty_step:'.0001'}};p.hash=hash(p);return p;}
const open=plan('legacy-open'),pending=plan('legacy-pending');
account.positions[open.id]={plan:open,qty:'.0012',entry:'80000',entry_fee:'.048',initial_margin:'48',accrued_funding:'0',entered_at:at+1100,expires_at:at+1801100};
account.pendingOrders[pending.id]={plan:pending,remaining_qty:'.0012',filled_qty:'0',remaining_reserved:'48.048',observed_capacity:'0',placed_at:pending.execution_contract.not_before};
const db=new DatabaseSync(process.argv[1]);db.exec('CREATE TABLE state(id TEXT PRIMARY KEY,revision INTEGER,state TEXT)');db.prepare('INSERT INTO state VALUES (?,?,?)').run('KRAKEN_BTCUSD_PAPER',10,JSON.stringify(root));db.close();
"""
            subprocess.run([node, '--input-type=module', '-e', seed, str(database)], cwd=repository,
                           capture_output=True, text=True, check=True, timeout=15)
            before = database.read_bytes()

            def isolated_run(args, cwd=None, timeout=45):
                self.assertEqual(args[:5], ['runuser', '-u', 'lumitrading', '--', '/usr/bin/node-24'])
                result = subprocess.run([node, *args[5:]], cwd=cwd, capture_output=True, text=True,
                                        check=True, timeout=timeout)
                return result.stdout.strip()

            settings = M.profit_env_changes(M.PROFIT_POLICY, '0.002', '0.25', '900000', '600000')
            with patch.object(M, 'DB', database), patch.object(M, 'run', side_effect=isolated_run):
                proof = M.verify_migration(repository, M.PROFILE, '100', settings)
            self.assertTrue(proof['idempotent'])
            self.assertTrue(proof['positions_preserved'])
            self.assertTrue(proof['pending_preserved'])
            self.assertEqual((proof['positions'], proof['pending']), (1, 1))
            self.assertEqual(proof['profit_policy']['version'], M.PROFIT_POLICY)
            self.assertTrue(proof['profit_policy']['active'])
            self.assertEqual(proof['profit_policy']['policy']['min_expected_net_target_fraction'], '0.002')
            self.assertEqual(len(proof['profit_policy']['policy_hash']), 64)
            self.assertEqual(database.read_bytes(), before, 'all migration state remained on an in-memory clone')


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

    def deploy(self, target=None, extra=None):
        with patch.object(sys, 'argv', ['isolated-update', target or self.target,
                                       '--expected-current', self.before, *(extra or [])]), \
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

    def test_explicit_profit_deploy_passes_effective_configuration_to_both_migration_checks(self):
        report = self.deploy(extra=['--profit-policy', M.PROFIT_POLICY,
                                    '--min-expected-net-target-fraction', '0.002',
                                    '--trailing-retracement-fraction', '0.25',
                                    '--trailing-extension-ms', '900000', '--trailing-stagnation-ms', '600000'])
        expected = M.profit_env_changes(M.PROFIT_POLICY, '0.002', '0.25', '900000', '600000')
        self.assertEqual(report['profit_configuration'], expected)
        self.assertEqual(self.migration.call_count, 2)
        for call in self.migration.call_args_list:
            self.assertEqual(call.args[3], expected)
        current = M.read_env(self.env.read_text())
        self.assertTrue(all(current[key] == value for key, value in expected.items()))
        self.assertEqual(current['UNRELATED_TEST_VALUE'], 'preserve-this')
        self.assertEqual(report['rollback']['profit_policy'], 'OFF')
        self.assertEqual(report['rollback']['profile'], M.PROFILE)
        self.assert_source_and_ledger_preserved()

    def test_failed_profit_start_uses_same_binary_and_disables_only_profit_policy(self):
        self.wait_active.side_effect = RuntimeError('DEPLOYMENT_NOT_CONFIRMED')
        with self.assertRaisesRegex(RuntimeError, 'DEPLOYMENT_NOT_CONFIRMED'):
            self.deploy(extra=['--profit-policy', M.PROFIT_POLICY,
                               '--min-expected-net-target-fraction', '0.002',
                               '--trailing-retracement-fraction', '0.25',
                               '--trailing-extension-ms', '900000', '--trailing-stagnation-ms', '600000'])
        self.assertEqual([row['action'] for row in self.actions], ['stop', 'start', 'stop', 'start'])
        self.assertEqual(self.current.resolve(), self.releases / self.target)
        current = M.read_env(self.actions[-1]['env'])
        self.assertEqual(current['LUMI_TRADING_SECONDARY_PROFIT_POLICY'], 'OFF')
        self.assertEqual(current['LUMI_TRADING_SECONDARY_PROFILE'], M.PROFILE)
        self.assertEqual(current['LUMI_TRADING_SECONDARY_MIN_EXPECTED_NET_TARGET_FRACTION'], '0.002')
        self.assertEqual(current['UNRELATED_TEST_VALUE'], 'preserve-this')
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
