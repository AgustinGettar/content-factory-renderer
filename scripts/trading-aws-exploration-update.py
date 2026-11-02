#!/usr/bin/env python3
"""Deploy the authorized secondary PAPER profile with an additive, tested migration.

No dependency installation, test suites, exchange orders or infrastructure changes.
After migration the supported reversal is PROFILE=OFF on this compatible code;
never restore an older binary or a stale ledger over newly recorded operations.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import subprocess
import time

ORIGIN = 'https://github.com/AgustinGettar/content-factory-renderer.git'
CURRENT = Path('/opt/lumi-trading/current')
RELEASES = Path('/opt/lumi-trading/releases')
ENV = Path('/etc/lumi-trading/worker.env')
DB = Path('/var/lib/lumi-trading/trading.sqlite')
SERVICE = 'lumi-trading.service'
PROFILE = 'secondary-paper-exploration-1.0.0'
BRANCH = 'lumi-trading-aws'
BACKUP_MARGIN_BYTES = 256 * 1024 * 1024
ALLOWED = {
    'lib/trading/secondary-exploration.js', 'lib/trading/secondary-entry-context.js',
    'lib/trading/secondary-futures.js', 'lib/trading/secondary-futures-engine.js',
    'lib/trading/secondary-futures-math.js', 'lib/trading/secondary-futures-runtime.js',
    'lib/trading/secondary-monitor-activity.js', 'lib/trading/monitor-projection.js',
    'lib/trading/portfolio.js', 'scripts/trading-worker.mjs',
    'scripts/trading-aws-exploration-update.py', 'docs/trading/PAPER-EXPLORATION.md',
    'test/secondary-futures.test.js', 'test/secondary-exploration-profile.test.js',
    'test/secondary-exploration-execution.test.js', 'test/secondary-exploration-monitor.test.js',
    'test/trading-exploration-persistence.test.js', 'test/trading_aws_exploration_update_test.py',
}


def run(args, cwd=None, timeout=45):
    result = subprocess.run(args, cwd=cwd, check=False, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Child output could include credential-bearing URLs. Keep it out of logs.
        raise RuntimeError('COMMAND_FAILED_' + Path(args[0]).name.upper())
    return result.stdout.strip()


def read_env(text):
    result = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        if key in result:
            raise RuntimeError('DUPLICATE_ENVIRONMENT_KEY')
        words = shlex.split(value, comments=False)
        result[key] = words[0] if len(words) == 1 else value.strip()
    return result


def validate_env(env):
    expected = {'LUMI_RUNTIME_ENV': 'staging', 'LUMI_TRADING_MODE': 'PAPER',
                'LUMI_TRADING_PLATFORM': 'EC2', 'LUMI_TRADING_STORAGE': 'SQLITE',
                'LUMI_TRADING_DB_PATH': str(DB), 'LUMI_TRADING_AWS_REGION': 'eu-north-1',
                'LUMI_TRADING_AWS_INSTANCE_ID': 'i-0ae2ad0bb886f3d7f',
                'LUMI_TRADING_SOURCE_BRANCH': 'lumi-trading-aws',
                'LUMI_TRADING_SECONDARY_EXECUTION': 'secondary-futures-1.0.0'}
    if any(env.get(key) != value for key, value in expected.items()):
        raise RuntimeError('EXISTING_AUTHORIZED_PAPER_WORKER_REQUIRED')


def updated_env(text, profile, nominal):
    changes = {'LUMI_TRADING_SECONDARY_PROFILE': profile,
               'LUMI_TRADING_SECONDARY_NOMINAL_USD': nominal}
    lines = []
    for line in text.splitlines():
        key = line.split('=', 1)[0].strip() if '=' in line else ''
        if key in changes:
            lines.append(key + '=' + changes.pop(key))
        else:
            lines.append(line)
    lines.extend(key + '=' + value for key, value in changes.items())
    return '\n'.join(lines) + '\n'


def write_env(text):
    info = ENV.stat()
    temp = ENV.with_name('worker.env.exploration.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(text)
        file.flush()
        os.fsync(file.fileno())
    os.chown(temp, info.st_uid, info.st_gid)
    os.chmod(temp, info.st_mode & 0o777)
    os.replace(temp, ENV)


def require_clean(release):
    # Neither staged nor unstaged changes may be silently discarded or deployed.
    run(['git', 'diff', '--quiet'], cwd=release)
    run(['git', 'diff', '--cached', '--quiet'], cwd=release)


def require_deployment_lease(old, expected_current, original_env):
    if CURRENT.resolve() != old:
        raise RuntimeError('DEPLOYED_RELEASE_CHANGED')
    if run(['git', 'rev-parse', 'HEAD'], cwd=old) != expected_current:
        raise RuntimeError('DEPLOYED_RELEASE_CHANGED')
    if ENV.read_text() != original_env:
        raise RuntimeError('WORKER_CONFIGURATION_CHANGED')


def fetch_target(old, target):
    # Fetch through the established repository configuration. A shared clone
    # intentionally does not inherit repository-local authentication settings.
    # Fetching objects and refs never changes the active working tree or HEAD.
    run(['git', 'fetch', '--no-tags', 'origin', BRANCH], cwd=old, timeout=60)
    if run(['git', 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], cwd=old) != target:
        raise RuntimeError('TRADING_BRANCH_HEAD_CHANGED')


def require_branch_head(old, target):
    ref = 'refs/heads/' + BRANCH
    rows = run(['git', 'ls-remote', '--exit-code', 'origin', ref], cwd=old, timeout=30).splitlines()
    if len(rows) != 1 or rows[0].split() != [target, ref]:
        raise RuntimeError('TRADING_BRANCH_HEAD_CHANGED')


def require_candidate(release, target):
    if run(['git', 'rev-parse', 'HEAD'], cwd=release) != target:
        raise RuntimeError('CANDIDATE_REVISION_MISMATCH')
    require_clean(release)


def share_dependencies(old, release):
    source = (old / 'node_modules').resolve(strict=True)
    if not source.is_dir():
        raise RuntimeError('EXISTING_DEPENDENCIES_REQUIRED')
    modules = release / 'node_modules'
    if not modules.exists() and not modules.is_symlink():
        modules.symlink_to(source, target_is_directory=True)
    if modules.resolve(strict=True) != source:
        raise RuntimeError('UNEXPECTED_DEPENDENCIES')


def require_backup_space():
    # page_count includes committed WAL pages. Read metadata only, not the DB
    # into memory, and reserve room for the backup plus normal worker growth.
    with sqlite3.connect('file:' + str(DB) + '?mode=ro', uri=True, timeout=3) as conn:
        pages = conn.execute('PRAGMA page_count').fetchone()[0]
        page_size = conn.execute('PRAGMA page_size').fetchone()[0]
    source_bytes = max(DB.stat().st_size, pages * page_size)
    available = shutil.disk_usage(DB.parent).free
    required = source_bytes + BACKUP_MARGIN_BYTES
    if available < required:
        raise RuntimeError('BACKUP_DISK_SPACE_INSUFFICIENT')
    return {'source_bytes': source_bytes, 'available_bytes': available,
            'required_bytes': required, 'margin_bytes': BACKUP_MARGIN_BYTES}


def snapshot():
    with sqlite3.connect('file:' + str(DB) + '?mode=ro', uri=True, timeout=3) as conn:
        row = conn.execute("SELECT revision,state FROM state WHERE id='KRAKEN_BTCUSD_PAPER'").fetchone()
        if not row:
            raise RuntimeError('PERSISTED_PAPER_STATE_REQUIRED')
        state = json.loads(row[1])
        counts = {table: conn.execute('SELECT count(*) FROM ' + table).fetchone()[0]
                  for table in ['events', 'outbox']}
    return {'revision': row[0], 'state': state, 'counts': counts}


def consistent_backup(stamp):
    space = require_backup_space()
    folder = DB.parent / 'backups'
    folder.mkdir(mode=0o700, exist_ok=True)
    path = folder / ('before-exploration-' + stamp + '.sqlite')
    with sqlite3.connect('file:' + str(DB) + '?mode=ro', uri=True) as source:
        with sqlite3.connect(path) as target:
            source.backup(target, pages=2048, sleep=0.005)
            if target.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('BACKUP_INTEGRITY_FAILED')
    os.chmod(path, 0o600)
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'path': str(path), 'sha256': digest.hexdigest(), 'bytes': path.stat().st_size,
            'disk_space': space}


def verify_migration(release, profile, nominal):
    # Read the authoritative JSON once; exercise only pure migration functions on
    # an in-memory clone, without a feed, writer lease, transport or real order.
    script = """
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {initializeSecondary} from './lib/trading/secondary-futures-engine.js';
import {installExploration} from './lib/trading/secondary-exploration.js';
const db=new DatabaseSync('/var/lib/lumi-trading/trading.sqlite',{readOnly:true,timeout:3000});
const row=db.prepare("SELECT state FROM state WHERE id='KRAKEN_BTCUSD_PAPER'").get();db.close();
const original=JSON.parse(row.state),state=structuredClone(original),events=[];
initializeSecondary(state,Date.now());
const env={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:process.argv[1],LUMI_TRADING_SECONDARY_NOMINAL_USD:process.argv[2]};
installExploration(state,env,Date.now(),e=>events.push(e));
const once=structuredClone(state);installExploration(state,env,Date.now(),e=>events.push(e));
if(!isDeepStrictEqual(once,state))throw Error('MIGRATION_NOT_IDEMPOTENT');
for(const key of Object.keys(original))if(key!=='secondaryExecution'&&!isDeepStrictEqual(original[key],state[key]))throw Error('MIGRATION_CHANGED_PROTECTED_STATE');
for(const key of ['protocol','protocol_hash','entry_rules','baseline'])if(!isDeepStrictEqual(original.secondaryExecution[key],state.secondaryExecution[key]))throw Error('MIGRATION_REWROTE_HISTORY');
console.log(JSON.stringify({compatible:true,idempotent:true,positions:Object.keys(state.frequency.account.positions).length,pending:Object.keys(state.frequency.account.pendingOrders).length,migration_events:events.length,profile:state.secondaryExecution.exploration?.version,active:state.secondaryExecution.exploration?.active??false}));
"""
    return json.loads(run(['runuser', '-u', 'lumitrading', '--', '/usr/bin/node-24',
                           '--max-old-space-size=96', '--input-type=module', '-e', script,
                           profile, nominal], cwd=release))


def wait_active(previous_revision, active):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            running = run(['systemctl', 'is-active', SERVICE], timeout=5) == 'active'
            row = snapshot()
            x = row['state'].get('secondaryExecution', {})
            if running and row['revision'] > previous_revision and x.get('exploration', {}).get('active') is active:
                return {'revision': row['revision'], 'profile': x.get('exploration', {}).get('version'),
                        'profile_active': active, 'counts': row['counts']}
        except (RuntimeError, sqlite3.Error):
            pass
        time.sleep(1)
    raise RuntimeError('DEPLOYMENT_NOT_CONFIRMED')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target')
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--profile', choices=[PROFILE, 'OFF'], default=PROFILE)
    parser.add_argument('--nominal', default='100')
    args = parser.parse_args()
    if not all(re.fullmatch(r'[0-9a-f]{40}', sha) for sha in [args.target, args.expected_current]):
        raise RuntimeError('EXACT_COMMIT_REQUIRED')
    if not re.fullmatch(r'(?:\d+\.?\d*|\.\d+)', args.nominal) or not 0 < float(args.nominal) < float('inf'):
        raise RuntimeError('FINITE_POSITIVE_NOMINAL_REQUIRED')
    with (DB.parent / 'deploy-exploration.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        original_env = ENV.read_text()
        validate_env(read_env(original_env))
        old = CURRENT.resolve()
        require_deployment_lease(old, args.expected_current, original_env)
        require_clean(old)
        fetch_target(old, args.target)
        release = RELEASES / args.target
        if not release.exists():
            previous_umask = os.umask(0o022)
            try:
                run(['git', 'clone', '--shared', '--no-checkout', str(old), str(release)], timeout=60)
                run(['git', 'remote', 'set-url', 'origin', ORIGIN], cwd=release)
                run(['git', 'checkout', '--detach', args.target], cwd=release)
            finally:
                os.umask(previous_umask)
        require_candidate(release, args.target)
        run(['git', 'merge-base', '--is-ancestor', args.expected_current, args.target], cwd=release)
        changed = run(['git', 'diff', '--name-only', args.expected_current, args.target], cwd=release).splitlines()
        if any(path not in ALLOWED for path in changed):
            raise RuntimeError('OUTSIDE_TRADING_EXPLORATION_SCOPE')
        share_dependencies(old, release)
        migration = verify_migration(release, args.profile, args.nominal)
        disk_space = require_backup_space()
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        stopped = False
        swapped = False
        configuration_written = False
        candidate_env = updated_env(original_env, args.profile, args.nominal)
        try:
            # A previous preflight is not permission to overwrite a newer
            # configuration, active release, candidate tree or branch head.
            require_deployment_lease(old, args.expected_current, original_env)
            require_clean(old)
            require_candidate(release, args.target)
            require_branch_head(old, args.target)
            require_backup_space()
            require_deployment_lease(old, args.expected_current, original_env)
            run(['systemctl', 'stop', SERVICE], timeout=30)
            stopped = True
            before = snapshot()
            backup = consistent_backup(stamp)
            env_backup = ENV.with_name('worker.env.before-exploration-' + stamp)
            fd = os.open(env_backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as file:
                file.write(original_env)
            # Validate the final quiescent snapshot, including any naturally
            # created order since the earlier preflight.
            migration = verify_migration(release, args.profile, args.nominal)
            require_deployment_lease(old, args.expected_current, original_env)
            require_clean(old)
            require_candidate(release, args.target)
            require_branch_head(old, args.target)
            share_dependencies(old, release)
            require_deployment_lease(old, args.expected_current, original_env)
            write_env(candidate_env)
            configuration_written = True
            link = CURRENT.with_name('current.exploration-next')
            if link.is_symlink():
                link.unlink()
            link.symlink_to(release, target_is_directory=True)
            if CURRENT.resolve() != old or ENV.read_text() != candidate_env:
                raise RuntimeError('DEPLOYMENT_LEASE_LOST_BEFORE_SWAP')
            os.replace(link, CURRENT)
            swapped = True
            run(['systemctl', 'start', SERVICE], timeout=20)
            after = wait_active(before['revision'], args.profile == PROFILE)
            report = {'status': 'DEPLOYED', 'at': stamp, 'previous_commit': args.expected_current,
                      'commit': args.target, 'release': str(release), 'backup': backup,
                      'migration': migration, 'before_revision': before['revision'], 'after': after,
                      'profile': args.profile, 'nominal_usd': args.nominal,
                      'disk_space_preflight': disk_space,
                      'rollback': {'compatible_commit': args.target, 'profile': 'OFF',
                                   'restore_old_database': False, 'old_binary_rollback_allowed': False},
                      'changed_paths': changed}
            report_path = DB.parent / ('deploy-exploration-' + stamp + '.json')
            report_path.write_text(json.dumps(report, indent=2) + '\n')
            os.chmod(report_path, 0o600)
            print(json.dumps(report))
        except Exception:
            if not swapped and stopped:
                # No new process has run, so no new execution state has been
                # committed. Undo only our own configuration write before
                # restarting the previous binary. Never overwrite a concurrent
                # change made after our lease check or point CURRENT backwards.
                if CURRENT.resolve() != old:
                    raise RuntimeError('DEPLOYMENT_LEASE_LOST_DURING_RECOVERY')
                if configuration_written:
                    if ENV.read_text() != candidate_env:
                        raise RuntimeError('CONFIGURATION_LEASE_LOST_DURING_RECOVERY')
                    write_env(original_env)
                run(['systemctl', 'start', SERVICE], timeout=20)
            elif swapped:
                # Same compatible parser/broker, unchanged orders and database.
                # Do not ever start the old broker over new execution contracts.
                if CURRENT.resolve() != release or ENV.read_text() != candidate_env:
                    raise RuntimeError('DEPLOYMENT_LEASE_LOST_DURING_RECOVERY')
                run(['systemctl', 'stop', SERVICE], timeout=30)
                write_env(updated_env(original_env, 'OFF', args.nominal))
                run(['systemctl', 'start', SERVICE], timeout=20)
            raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if re.fullmatch(r'[A-Z_]+', str(error)) else type(error).__name__
        print(json.dumps({'status': 'ATTENTION_REQUIRED', 'code': code,
                          'old_binary_not_restored': True}), flush=True)
        raise SystemExit(1)
