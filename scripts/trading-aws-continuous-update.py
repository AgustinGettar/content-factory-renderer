#!/usr/bin/env python3
"""Remove the daily PAPER selection quota on the existing isolated AWS worker.

No funding, environment changes, Telegram notices, new hosts, or live orders.
The application performs an exact legacy-protocol migration in its normal commit.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import time

BASE = '9161a98026395d969256e3a812c4a19e6edc2da0'
ORIGIN = 'https://github.com/AgustinGettar/content-factory-renderer.git'
BRANCH = 'lumi-trading-aws'
CURRENT = Path('/opt/lumi-trading/current')
RELEASES = Path('/opt/lumi-trading/releases')
ENV = Path('/etc/lumi-trading/worker.env')
DB = Path('/var/lib/lumi-trading/trading.sqlite')
ALLOWED = {
    'lib/trading/frequency.js', 'lib/trading/laboratory.js',
    'lib/trading/engine.js', 'lib/trading/monitor-projection.js',
    'test/trading-continuous.test.js', 'test/trading-frequency.test.js',
    'test/trading-timeframes.test.js', 'test/trading-engine.test.js',
    'test/trading-laboratory.test.js', 'test/trading-projection.test.js',
    'scripts/trading-aws-continuous-update.py',
    'test/trading_aws_continuous_update_test.py', 'docs/trading/CONTINUOUS.md',
}
HEALTH_KEYS = ('heartbeat_recent', 'market_recent', 'dashboard_recent',
               'continuous_protocol', 'migration_once', 'evaluations_resumed')


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True,
                          timeout=kwargs.pop('timeout', 45), **kwargs).stdout.strip()


def validate_env(env):
    expected = {
        'LUMI_RUNTIME_ENV': 'staging', 'LUMI_TRADING_MODE': 'PAPER',
        'LUMI_TRADING_PLATFORM': 'EC2', 'LUMI_TRADING_STORAGE': 'SQLITE',
        'LUMI_TRADING_DB_PATH': str(DB),
        'LUMI_TRADING_AWS_INSTANCE_ID': 'i-0ae2ad0bb886f3d7f',
        'LUMI_TRADING_AWS_REGION': 'eu-north-1',
        'LUMI_TRADING_SOURCE_BRANCH': BRANCH,
        'LUMI_TRADING_SECONDARY_PROFILE': 'secondary-growth-1.0.0',
        'LUMI_TRADING_ENTRY_PROFILE': 'agile-5bars-1.0.0',
        'LUMI_TRADING_CONTEXT_PROFILE': 'context-maker-1.0.0',
        'LUMI_TRADING_MAKER_SIZING': 'maker-sizing-1.0.0',
        'LUMI_TRADING_NET_EXITS': 'net-exit-1.0.0',
        'LUMI_TRADING_LEVERAGE_PROFILE': 'secondary-boost-1.0.0',
        'LUMI_TRADING_CAPACITY_PROFILE': 'secondary-capacity-1.0.0',
    }
    if any(env.get(k) != v for k, v in expected.items()):
        raise RuntimeError('EXISTING_PAPER_SQLITE_REQUIRED')


def validate_scope(changed):
    if not changed or any(p not in ALLOWED for p in changed):
        raise RuntimeError('OUTSIDE_CONTINUOUS_PAPER_SCOPE')


def as_worker(release, script, *args):
    return run(['runuser', '-u', 'lumitrading', '--', '/usr/bin/node-24',
                '--input-type=module', '-e', script, *args], cwd=release)


def fingerprint(release, path=DB):
    return as_worker(release, """
      import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
      const db=new DatabaseSync(process.argv[1],{readOnly:true,timeout:3000});
      if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('UPDATE_DATABASE_INTEGRITY');
      const hash=createHash('sha256');
      for(const table of ['state','events','outbox','metadata'])for(const row of db.prepare('SELECT * FROM '+table+' ORDER BY '+(table==='metadata'?'key':'id')).iterate())hash.update(JSON.stringify(row));
      console.log(hash.digest('hex'));db.close();
    """, str(path))


def preflight_protocol(release):
    # Validate migration against a read-only copy before interrupting the writer.
    as_worker(release, """
      import {DatabaseSync} from 'node:sqlite';
      import {initializeFrequency,FREQUENCY_PROTOCOL} from './lib/trading/frequency.js';
      import {hash} from './lib/trading/core.js';
      const db=new DatabaseSync('/var/lib/lumi-trading/trading.sqlite',{readOnly:true,timeout:3000});
      const row=db.prepare('SELECT id,state FROM state').get();db.close();
      if(row?.id!=='KRAKEN_BTCUSD_PAPER')throw Error('UPDATE_STATE_ID_MISMATCH');
      const s=JSON.parse(row.state);if(s.schema!==11)throw Error('UPDATE_STATE_SCHEMA_MISMATCH');
      const before=structuredClone(s),event=initializeFrequency(s,Date.now());
      if(event&&event.type!=='DAILY_SELECTION_LIMIT_REMOVED')throw Error('UPDATE_MIGRATION_EVENT_INVALID');
      if(s.frequency.protocol_hash!==hash(FREQUENCY_PROTOCOL)||s.frequency.protocol.maxSelectionsPerUTCDate!==null)throw Error('UPDATE_PROTOCOL_INVALID');
      for(const k of ['protocol','protocol_hash','protocol_history']){delete s.frequency[k];delete before.frequency[k];}
      if(JSON.stringify(s)!==JSON.stringify(before))throw Error('UPDATE_MIGRATION_CHANGED_LEDGER');
    """)


def service():
    raw = run(['systemctl', 'show', 'lumi-trading.service',
               '--property=ActiveState,SubState,MainPID,NRestarts,ExecMainStatus,UnitFileState,Restart'])
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def status(release):
    data = json.loads(as_worker(release, """
      import {DatabaseSync} from 'node:sqlite';
      import {FREQUENCY_PROTOCOL,LEGACY_FREQUENCY_PROTOCOL} from './lib/trading/frequency.js';
      import {hash} from './lib/trading/core.js';
      const db=new DatabaseSync('/var/lib/lumi-trading/trading.sqlite',{readOnly:true,timeout:3000});
      const row=db.prepare('SELECT * FROM state').get(),s=JSON.parse(row.state),now=Date.now(),f=s.frequency;
      const recent=(t,max)=>Number.isFinite(t)&&now>=t&&now-t<max;
      const audit=db.prepare("SELECT payload FROM events WHERE kind='FEED_AUDIT' ORDER BY created_at DESC LIMIT 1").get();
      const feed=audit?JSON.parse(audit.payload):null;
      const meta=db.prepare("SELECT value FROM metadata WHERE key='dashboard'").get(),p=meta?JSON.parse(meta.value):null;
      const changes=db.prepare("SELECT payload FROM events WHERE kind='DAILY_SELECTION_LIMIT_REMOVED'").all().map(x=>JSON.parse(x.payload));
      const history=(f.protocol_history??[]).filter(x=>x.reason==='DAILY_SELECTION_LIMIT_REMOVED'),activation=history.at(-1)?.at;
      const d=s.laboratory?.lastDecision??f.lastDecision;
      console.log(JSON.stringify({at:now,revision:row.revision,updated_at:row.updated_at,schema:s.schema,
        primary:s.research.versions[s.research.active].account.equity,secondary:f.account.equity,
        daily_selection_limit:f.protocol?.maxSelectionsPerUTCDate,day_selections:f.daySelections,
        open_positions:Object.keys(f.account.positions??{}).length,pending_entries:Object.keys(f.account.pendingOrders??{}).length,
        activation_at:activation,last_decision:d,
        continuous_protocol:f.protocol_hash===hash(FREQUENCY_PROTOCOL)&&hash(f.protocol)===hash(FREQUENCY_PROTOCOL)&&f.protocol.maxSelectionsPerUTCDate===null,
        migration_once:changes.length===1&&history.length===1&&history[0].protocol_hash===hash(LEGACY_FREQUENCY_PROTOCOL)&&hash(history[0].protocol)===hash(LEGACY_FREQUENCY_PROTOCOL),
        evaluations_resumed:Number.isFinite(activation)&&d?.at>activation&&d.reason!=='DAILY_SELECTION_LIMIT',
        heartbeat_recent:recent(Date.parse(row.updated_at),45000)&&Date.parse(row.lease_until)>now,
        market_recent:!!feed&&recent(feed.at,15000)&&feed.feed.connected&&feed.feed.reconciled&&feed.feed.system==='online'&&feed.at>=feed.feed.quote?.event_at&&feed.at-feed.feed.quote.event_at<=5000&&feed.at>=feed.feed.trade?.event_at&&feed.at-feed.feed.trade.event_at<=30000,
        market_sample_at:feed?.at??null,dashboard_recent:!!p&&recent(p.at,15000),dashboard_at:p?.at??null,
        dashboard_error:/^(DASHBOARD_|BACKUP_)[A-Z_]{1,80}$/.test(p?.error??'')?p.error:null,
        remote_backup_error:/^(DASHBOARD_|BACKUP_)[A-Z_]{1,80}$/.test(p?.backup_error??'')?p.backup_error:null}));db.close();
    """))
    data['service'] = service()
    return data


def recent_errors():
    result = []
    raw = run(['journalctl', '-u', 'lumi-trading.service', '-n', '60', '--no-pager', '-o', 'json'])
    for line in raw.splitlines():
        try:
            row = json.loads(line)
            entry = json.loads(row.get('MESSAGE', ''))
            if entry.get('event') not in {'lumi_trading_worker_attention_required', 'trading_dashboard_attention'}:
                continue
            code = entry.get('code', '')
            if not re.fullmatch(r'(TRADING_|DASHBOARD_|BACKUP_|ERR_|SQLITE_|KRAKEN_|TELEGRAM_)[A-Z0-9_]{1,80}', code):
                continue
            safe = {'at': int(row['__REALTIME_TIMESTAMP']) // 1000, 'code': code}
            if entry.get('error_class') in {'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'}:
                safe['error_class'] = entry['error_class']
            safe['frames'] = [f for f in entry.get('frames', []) if isinstance(f, str) and re.fullmatch(r'[a-z0-9_-]+\.(js|mjs):[0-9]+:[0-9]+', f)][:4]
            result.append(safe)
        except (ValueError, KeyError, TypeError, AttributeError):
            continue
    return result[-5:]


def complete(data):
    svc = data['service']
    return (svc.get('ActiveState') == 'active' and svc.get('SubState') == 'running'
            and svc.get('UnitFileState') == 'enabled' and svc.get('Restart') == 'on-failure'
            and all(data.get(k) for k in HEALTH_KEYS))


def prepare_and_start(migration, old, release, config, was_running):
    backup = None
    start_attempted = False
    try:
        migration.stop_writer()
        before = fingerprint(release, DB)
        backup = str(DB.parent / 'backups' / ('pre-continuous-' + str(time.time_ns()) + '.sqlite'))
        as_worker(release, """
          import {DatabaseSync,backup} from 'node:sqlite';import {mkdir} from 'node:fs/promises';
          const db=new DatabaseSync('/var/lib/lumi-trading/trading.sqlite',{readOnly:true,timeout:3000});
          await mkdir('/var/lib/lumi-trading/backups',{mode:0o700,recursive:true});
          await backup(db,process.argv[1]);db.close();
        """, backup)
        if fingerprint(release, Path(backup)) != before:
            raise RuntimeError('UPDATE_BACKUP_MISMATCH')
        if fingerprint(release, DB) != before or ENV.read_bytes() != config:
            raise RuntimeError('STATE_OR_CONFIG_CHANGED')
        migration.switch_to(release)
        run(['systemctl', 'reset-failed', 'lumi-trading.service'])
        # A failed start response may still have committed new state. Never
        # restore the old database, or run the old code, after this boundary.
        start_attempted = True
        run(['systemctl', 'start', 'lumi-trading.service'])
    except Exception:
        if not start_attempted and was_running:
            if CURRENT.resolve() != old:
                migration.switch_to(old)
            run(['systemctl', 'reset-failed', 'lumi-trading.service'])
            run(['systemctl', 'start', 'lumi-trading.service'])
        raise
    return backup


def update(target):
    if os.geteuid() != 0 or not re.fullmatch('[a-f0-9]{40}', target):
        raise RuntimeError('ROOT_PINNED_RELEASE_REQUIRED')
    if ENV.is_symlink() or ENV.stat().st_mode & 0o077:
        raise RuntimeError('PRIVATE_CONFIGURATION_REQUIRED')
    config = ENV.read_bytes()
    env = dict(line.split('=', 1) for line in config.decode().splitlines() if '=' in line)
    validate_env(env)
    old = CURRENT.resolve()
    if old.parent != RELEASES or run(['git', '-C', str(old), 'rev-parse', 'HEAD']) not in {BASE, target}:
        raise RuntimeError('UNEXPECTED_RELEASE')
    if run(['git', '-C', str(old), 'remote', 'get-url', 'origin']) != ORIGIN:
        raise RuntimeError('WRONG_REPOSITORY')
    for args in [['diff', '--exit-code'], ['diff', '--cached', '--exit-code']]:
        run(['git', '-C', str(old), *args])
    user = pwd.getpwnam('lumitrading')
    if DB.parent.is_symlink() or DB.is_symlink() or not DB.is_file() or DB.stat().st_uid != user.pw_uid:
        raise RuntimeError('EXISTING_DATABASE_REQUIRED')
    run(['git', '-C', str(old), 'fetch', '--no-tags', 'origin', BRANCH], timeout=60)
    if run(['git', '-C', str(old), 'rev-parse', 'FETCH_HEAD']) != target:
        raise RuntimeError('TARGET_NOT_BRANCH_HEAD')
    run(['git', '-C', str(old), 'merge-base', '--is-ancestor', BASE, target])
    validate_scope(run(['git', '-C', str(old), 'diff', '--name-only', BASE, target]).splitlines())
    release = RELEASES / target
    if not release.exists():
        previous = os.umask(0o022)
        try:
            run(['git', '-C', str(old), 'worktree', 'add', '--detach', str(release), target])
        finally:
            os.umask(previous)
    if run(['git', '-C', str(release), 'rev-parse', 'HEAD']) != target:
        raise RuntimeError('TARGET_MISMATCH')
    for args in [['diff', '--exit-code'], ['diff', '--cached', '--exit-code']]:
        run(['git', '-C', str(release), *args])
    if (old / 'package-lock.json').read_bytes() != (release / 'package-lock.json').read_bytes():
        raise RuntimeError('DEPENDENCIES_CHANGED')
    if not (release / 'node_modules').exists():
        (release / 'node_modules').symlink_to(old / 'node_modules')
    if (release / 'node_modules').resolve() != (old / 'node_modules').resolve():
        raise RuntimeError('UNEXPECTED_DEPENDENCIES')
    run(['/usr/bin/node-24', '--test', 'test/trading-continuous.test.js',
         'test/trading-frequency.test.js', 'test/trading-timeframes.test.js',
         'test/trading-laboratory.test.js', 'test/trading-engine.test.js',
         'test/trading-secondary-capacity.test.js', 'test/trading-sqlite.test.js'], cwd=release, timeout=60)
    run(['/usr/bin/node-24', '--input-type=module', '-e',
         "import {assertTradingRuntime} from './lib/trading/runtime-guard.js';await assertTradingRuntime(process.env);"],
        cwd=release, env={**os.environ, **env})
    preflight_protocol(release)
    spec = importlib.util.spec_from_file_location('verified_sqlite_update', old / 'scripts/trading-aws-sqlite-update.py')
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    previous_service = service()
    applied = old == release and previous_service.get('ActiveState') == 'active'
    backup = None
    if not applied:
        if shutil.disk_usage(DB.parent).free < 512 * 1024 * 1024:
            raise RuntimeError('DISK_SPACE_REQUIRED')
        backup = prepare_and_start(migration, old, release, config,
                                   previous_service.get('ActiveState') == 'active')
    started = time.monotonic()
    result = {}
    stable_pid = None
    stable_since = started
    for attempt in range(28):
        result = status(release)
        current_pid = result['service'].get('MainPID')
        if current_pid != stable_pid:
            stable_pid = current_pid
            stable_since = time.monotonic()
        if complete(result) and time.monotonic() - stable_since >= 65:
            break
        if result['service'].get('ActiveState') == 'failed':
            break
        if attempt < 27:
            time.sleep(5)
    result.update({'repair_applied': True, 'release': target,
                   'preserved_before_start': True, 'configuration_unchanged': ENV.read_bytes() == config,
                   'stable_65s': stable_pid not in {None, '0'} and time.monotonic() - stable_since >= 65,
                   'backup_created': backup is not None})
    result['verified'] = complete(result) and result['stable_65s'] and result['configuration_unchanged']
    if not result['verified']:
        result['errors'] = recent_errors()
    return result


if __name__ == '__main__':
    try:
        os.umask(0o077)
        with open('/run/lock/lumi-trading-update.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(json.dumps(update(sys.argv[1])))
    except Exception as error:
        code = str(error)
        print(json.dumps({'update_status': 'NOT_VERIFIED',
                          'error': code if re.fullmatch('[A-Z_]{5,100}', code) else 'UPDATE_NOT_CONFIRMED',
                          'preserve_instance': True}))
        raise SystemExit(1)
