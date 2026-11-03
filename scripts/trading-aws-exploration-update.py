#!/usr/bin/env python3
"""Deploy the authorized secondary PAPER profile with an additive, tested migration.

No dependency installation, test suites, exchange orders or infrastructure changes.
After migration the supported reversal is the requested policy OFF on this compatible code;
never restore an older binary or a stale ledger over newly recorded operations.
"""
import argparse
from decimal import Decimal
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
PROFIT_POLICY = 'secondary-profit-policy-1.0.0'
EARLY_PROFIT_POLICY = 'secondary-profit-policy-2.0.0'
PROFIT_ENV_KEYS = ('LUMI_TRADING_SECONDARY_PROFIT_POLICY',
                   'LUMI_TRADING_SECONDARY_MIN_EXPECTED_NET_TARGET_FRACTION',
                   'LUMI_TRADING_SECONDARY_TRAILING_RETRACEMENT_FRACTION',
                   'LUMI_TRADING_SECONDARY_TRAILING_EXTENSION_MS',
                   'LUMI_TRADING_SECONDARY_TRAILING_STAGNATION_MS')
NEURAL_MODES = ('OFF', 'COLLECTING', 'ADVISORY', 'ASSISTED')
NEURAL_PATHS = {
    'LUMI_TRADING_NEURAL_MODEL_PATH': '/var/lib/lumi-trading/neural/model.json',
    'LUMI_TRADING_NEURAL_CANDIDATE_PATH': '/var/lib/lumi-trading/neural/candidate.json',
    'LUMI_TRADING_NEURAL_LAST_GOOD_PATH': '/var/lib/lumi-trading/neural/last-good.json',
    'LUMI_TRADING_NEURAL_STATUS_PATH': '/var/lib/lumi-trading/neural/status.json',
}
NEURAL_ENV_KEYS = ('LUMI_TRADING_SECONDARY_NEURAL_MODE', *NEURAL_PATHS)
CAPITAL_ALLOCATION = 'secondary-capital-allocation-1.0.0'
CAPITAL_ENV_KEYS = ('LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION',
                    'LUMI_TRADING_SECONDARY_ALLOCATION_BASE_USD',
                    'LUMI_TRADING_SECONDARY_PREFERRED_MULTIPLIER',
                    'LUMI_TRADING_SECONDARY_TARGET_EQUITY_USD',
                    'LUMI_TRADING_SECONDARY_CAPITAL_REQUEST_ID')
RISK_BUDGET = 'secondary-risk-budget-1.0.0'
TIMEFRAMES = 'secondary-timeframes-1.0.0'
RISK_ENV_KEYS = ('LUMI_TRADING_SECONDARY_RISK_BUDGET',)
TIMEFRAME_ENV_KEYS = ('LUMI_TRADING_SECONDARY_TIMEFRAMES',)
BRANCH = 'lumi-trading-aws'
BACKUP_MARGIN_BYTES = 256 * 1024 * 1024
ALLOWED = {
    'lib/trading/secondary-exploration.js', 'lib/trading/secondary-entry-context.js',
    'lib/trading/secondary-futures.js', 'lib/trading/secondary-futures-engine.js',
    'lib/trading/secondary-futures-math.js', 'lib/trading/secondary-futures-runtime.js',
    'lib/trading/secondary-monitor-activity.js', 'lib/trading/monitor-projection.js',
    'lib/trading/portfolio.js', 'scripts/trading-worker.mjs', 'test/trading-worker-startup.test.js',
    'scripts/trading-aws-exploration-update.py', 'docs/trading/PAPER-EXPLORATION.md',
    'test/secondary-futures.test.js', 'test/secondary-exploration-profile.test.js',
    'test/secondary-exploration-execution.test.js', 'test/secondary-exploration-monitor.test.js',
    'test/trading-exploration-persistence.test.js', 'test/trading_aws_exploration_update_test.py',
    'lib/trading/dashboard-publisher.js', 'test/trading-dashboard-backup.test.js',
    'test/trading-live-dashboard.test.js',
    'lib/trading/secondary-profit-policy.js', 'lib/trading/secondary-profit-protection.js',
    'lib/trading/secondary-entry-economics.js', 'test/secondary-entry-economics.test.js',
    'test/secondary-entry-profit-context.test.js', 'test/secondary-profit-monitor.test.js',
    'test/secondary-profit-policy.test.js', 'test/secondary-profit-protection.test.js',
    'test/secondary-profit-integration.test.js',
    'lib/trading/paper-controls.js', 'test/secondary-profit-controls.test.js',
    'docs/secondary-profit-policy-1.0.0.md',
    'lib/trading/secondary-neural.js', 'lib/trading/secondary-neural-data.js',
    'lib/trading/secondary-neural-runtime.js', 'lib/trading/secondary-neural-dataset.js',
    'scripts/trading-neural-export.py', 'scripts/trading-neural-train.py',
    'scripts/trading-neural-cycle.mjs', 'scripts/trading-neural-publish.py',
    'requirements-trading-neural.txt', '.github/workflows/lumi-trading-paper.yml',
    'test/secondary-neural-data.test.js', 'test/secondary-neural-runtime.test.js',
    'test/secondary-neural-dataset.test.js', 'test/secondary-neural-integration.test.js',
    'test/secondary-neural-cycle.test.js', 'test/trading_neural_trainer_test.py',
    'test/trading_neural_export_test.py', 'test/trading_neural_publish_test.py',
    'docs/trading/NEURAL-TRAINER.md', 'docs/trading/NEURAL-INTEGRATION.md',
    'lib/trading/secondary-capital-allocation.js',
    'test/secondary-capital-allocation.test.js',
    'test/secondary-capital-integration.test.js',
    'docs/trading/CAPITAL-ALLOCATION.md',
    'lib/trading/secondary-risk-budget.js', 'lib/trading/secondary-timeframes.js',
    'lib/trading/secondary-exit-advisory.js', 'lib/trading/multi-pattern-paper.js',
    'lib/trading/secondary-history-publisher.js',
    'test/secondary-risk-budget.test.js', 'test/secondary-independent-timeframes.test.js',
    'test/secondary-early-profit-protection.test.js', 'test/secondary-exit-advisory.test.js',
    'test/secondary-history-publisher.test.js', 'test/trading-secondary-monitor-activity.test.js',
    'docs/trading/EARLY-PROTECTION-2.0.0.md', 'docs/trading/EXIT-ADVISORY.md',
    'docs/trading/INDEPENDENT-TIMEFRAMES.md', 'docs/trading/RISK-BUDGET-AND-PYRAMID.md',
    'docs/trading/DURABLE-SECONDARY-HISTORY.md', 'docs/trading/EXPERIMENTAL-EVALUATION.md',
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


def profit_env_changes(profit_policy=None, min_expected_net_target_fraction=None,
                       trailing_retracement_fraction=None, trailing_extension_ms=None,
                       trailing_stagnation_ms=None):
    values = [min_expected_net_target_fraction, trailing_retracement_fraction,
              trailing_extension_ms, trailing_stagnation_ms]
    if profit_policy is None:
        if any(value is not None for value in values):
            raise RuntimeError('PROFIT_POLICY_FLAG_REQUIRED')
        return {}
    if profit_policy not in [PROFIT_POLICY, EARLY_PROFIT_POLICY, 'OFF']:
        raise RuntimeError('PROFIT_POLICY_VERSION_UNSUPPORTED')
    if profit_policy == 'OFF' and any(value is not None for value in values):
        raise RuntimeError('PROFIT_PARAMETERS_REQUIRE_ACTIVE_POLICY')
    for value in values[:2]:
        if value is not None and (not re.fullmatch(r'(?:\d+\.?\d*|\.\d+)', value)
                                  or not 0 < Decimal(value) < 1):
            raise RuntimeError('PROFIT_FRACTION_INVALID')
    for value in values[2:]:
        if value is not None and (not re.fullmatch(r'\d+', value) or not 0 < int(value) <= 86400000):
            raise RuntimeError('PROFIT_DURATION_INVALID')
    return {key: value for key, value in zip(PROFIT_ENV_KEYS, [profit_policy, *values])
            if value is not None}


def neural_env_changes(mode=None):
    if mode is None:
        return {}
    if mode not in NEURAL_MODES:
        raise RuntimeError('NEURAL_MODE_UNSUPPORTED')
    return {'LUMI_TRADING_SECONDARY_NEURAL_MODE': mode, **NEURAL_PATHS}


def capital_env_changes(mode=None, base_usd=None, preferred_multiplier=None,
                        target_equity_usd=None, request_id=None):
    values = [base_usd, preferred_multiplier, target_equity_usd, request_id]
    if mode is None:
        if any(value is not None for value in values):
            raise RuntimeError('CAPITAL_ALLOCATION_FLAG_REQUIRED')
        return {}
    if mode not in [CAPITAL_ALLOCATION, 'OFF']:
        raise RuntimeError('CAPITAL_ALLOCATION_VERSION_UNSUPPORTED')
    if mode == 'OFF' and any(value is not None for value in values):
        raise RuntimeError('CAPITAL_PARAMETERS_REQUIRE_ACTIVE_POLICY')
    for value in values[:3]:
        if value is not None and (not re.fullmatch(r'(?:\d+\.?\d*|\.\d+)', value)
                                  or not Decimal(value).is_finite() or Decimal(value) <= 0):
            raise RuntimeError('CAPITAL_PARAMETER_INVALID')
    if preferred_multiplier is not None and not 1 <= Decimal(preferred_multiplier) <= 2:
        raise RuntimeError('CAPITAL_PARAMETER_INVALID')
    if request_id is not None and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', request_id):
        raise RuntimeError('CAPITAL_REQUEST_ID_INVALID')
    return {key: value for key, value in zip(CAPITAL_ENV_KEYS, [mode, *values])
            if value is not None}


def risk_env_changes(mode=None):
    if mode is None:
        return {}
    if mode not in [RISK_BUDGET, 'OFF']:
        raise RuntimeError('RISK_BUDGET_VERSION_UNSUPPORTED')
    return {RISK_ENV_KEYS[0]: mode}


def timeframe_env_changes(mode=None):
    if mode is None:
        return {}
    if mode not in [TIMEFRAMES, 'OFF']:
        raise RuntimeError('TIMEFRAMES_VERSION_UNSUPPORTED')
    return {TIMEFRAME_ENV_KEYS[0]: mode}


def updated_env(text, profile, nominal, profit_changes=None, neural_changes=None,
                capital_changes=None, risk_changes=None, timeframe_changes=None):
    changes = {'LUMI_TRADING_SECONDARY_PROFILE': profile,
               'LUMI_TRADING_SECONDARY_NOMINAL_USD': nominal,
               **(profit_changes or {}), **(neural_changes or {}), **(capital_changes or {}),
               **(risk_changes or {}), **(timeframe_changes or {})}
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
    # Fetch through the established repository configuration. A local clone
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


def verify_migration(release, profile, nominal, profit_env=None, neural_env=None,
                     capital_env=None, risk_env=None, timeframe_env=None):
    # Read the authoritative JSON once; exercise only pure migration functions on
    # an in-memory clone, without a feed, writer lease, transport or real order.
    script = """
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {initializeSecondary} from './lib/trading/secondary-futures-engine.js';
import {installExploration} from './lib/trading/secondary-exploration.js';
import {installProfitPolicy} from './lib/trading/secondary-profit-policy.js';
const db=new DatabaseSync(process.argv[4],{readOnly:true,timeout:3000});
const row=db.prepare("SELECT state FROM state WHERE id='KRAKEN_BTCUSD_PAPER'").get();db.close();
const original=JSON.parse(row.state),state=structuredClone(original),events=[];
const at=Date.now();initializeSecondary(state,at);
const env={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:process.argv[1],LUMI_TRADING_SECONDARY_NOMINAL_USD:process.argv[2],...JSON.parse(process.argv[3]),...JSON.parse(process.argv[5]??'{}'),...JSON.parse(process.argv[6]??'{}'),...JSON.parse(process.argv[7]??'{}'),...JSON.parse(process.argv[8]??'{}')};
let installNeural=null;
if(env.LUMI_TRADING_SECONDARY_NEURAL_MODE||state.secondaryNeural)({installSecondaryNeural:installNeural}=await import('./lib/trading/secondary-neural.js'));
let installCapital=null;
if(env.LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION||state.secondaryExecution.capital_allocation)({installCapitalAllocation:installCapital}=await import('./lib/trading/secondary-capital-allocation.js'));
let installRisk=null,installTimeframes=null;
if(env.LUMI_TRADING_SECONDARY_RISK_BUDGET||state.secondaryExecution.risk_budget)({installSecondaryRiskBudget:installRisk}=await import('./lib/trading/secondary-risk-budget.js'));
if(env.LUMI_TRADING_SECONDARY_TIMEFRAMES||state.secondaryExecution.timeframe_execution)({installSecondaryTimeframes:installTimeframes}=await import('./lib/trading/secondary-timeframes.js'));
const migrate=()=>{installExploration(state,env,at,e=>events.push(e));installProfitPolicy(state,env,at,e=>events.push(e));
 if(installCapital)installCapital(state,env,at,e=>events.push(e));
 if(installRisk)installRisk(state,env,at,e=>events.push(e));
 if(installTimeframes)installTimeframes(state,env,at,e=>events.push(e));
 if(installNeural)installNeural({state,now:()=>at,event:e=>events.push(e),notice:()=>{}},env);};
migrate();const once=structuredClone(state),eventCount=events.length;migrate();
if(!isDeepStrictEqual(once,state))throw Error('MIGRATION_NOT_IDEMPOTENT');
if(events.length!==eventCount)throw Error('MIGRATION_DUPLICATED_EVENTS');
for(const key of Object.keys(original))if(!['secondaryExecution','secondaryNeural'].includes(key)&&!isDeepStrictEqual(original[key],state[key]))throw Error('MIGRATION_CHANGED_PROTECTED_STATE');
for(const key of ['protocol','protocol_hash','entry_rules','baseline'])if(!isDeepStrictEqual(original.secondaryExecution[key],state.secondaryExecution[key]))throw Error('MIGRATION_REWROTE_HISTORY');
for(const key of ['positions','pendingOrders'])if(!isDeepStrictEqual(original.frequency.account[key],state.frequency.account[key]))throw Error('MIGRATION_REWROTE_EXECUTION_CONTRACTS');
if(installCapital){
 if(!isDeepStrictEqual(original.frequency,state.frequency))throw Error('CAPITAL_INSTALL_CHANGED_ACCOUNT');
 if(!isDeepStrictEqual(original.secondaryExecution.exploration,state.secondaryExecution.exploration))throw Error('CAPITAL_INSTALL_REWROTE_EXPLORATION');
 if(!isDeepStrictEqual(original.secondaryExecution.profit_policy,state.secondaryExecution.profit_policy)&&env.LUMI_TRADING_SECONDARY_PROFIT_POLICY===original.secondaryExecution.profit_policy?.version)throw Error('CAPITAL_INSTALL_REWROTE_PROFIT_POLICY');
 if(!isDeepStrictEqual(original.secondaryExecution.capital,state.secondaryExecution.capital))throw Error('CAPITAL_INSTALL_CHANGED_FUNDING_LEDGER');
}
const advancedChanged=['risk_budget','timeframe_execution'].some(key=>!isDeepStrictEqual(original.secondaryExecution[key],state.secondaryExecution[key]));
if(advancedChanged){
 const except=(object,keys)=>Object.fromEntries(Object.entries(object).filter(([key])=>!keys.includes(key)));
 if(!isDeepStrictEqual(except(original.secondaryExecution,['risk_budget','timeframe_execution']),except(state.secondaryExecution,['risk_budget','timeframe_execution'])))throw Error('NEW_POLICIES_CHANGED_EXISTING_EXECUTION_STATE');
 if(!isDeepStrictEqual(except(original,['secondaryExecution']),except(state,['secondaryExecution'])))throw Error('NEW_POLICIES_CHANGED_PROTECTED_ROOT_STATE');
 if(!isDeepStrictEqual(original.secondaryExecution.capital_allocation,state.secondaryExecution.capital_allocation))throw Error('NEW_POLICIES_CHANGED_FUNDING_REQUEST');
}
if(events.some(event=>event.type==='PAPER_CAPITAL_TOPUP'))throw Error('MIGRATION_ATTEMPTED_CAPITAL_TOPUP');
if(original.secondaryNeural)for(const key of ['protocol','protocol_hash','counts','pending','recent','last_decisions','feature_exclusions','label_exclusions'])if(!isDeepStrictEqual(original.secondaryNeural[key],state.secondaryNeural[key]))throw Error('MIGRATION_REWROTE_NEURAL_RECORDS');
const profit=state.secondaryExecution.profit_policy,expectedProfit=profit?{version:profit.version,active:profit.active,policy_hash:profit.policy_hash,policy:profit.policy}:null;
const n=state.secondaryNeural,neural=n?{version:n.version,protocol_hash:n.protocol_hash,requested_mode:n.requested_mode}:null;
const ca=state.secondaryExecution.capital_allocation,capital=ca?{version:ca.version,active:ca.active,policy_hash:ca.policy_hash,policy:ca.policy}:null;
const projectPolicy=p=>p?{version:p.version,active:p.active,policy_hash:p.policy_hash,policy:p.policy}:null;
const riskBudget=projectPolicy(state.secondaryExecution.risk_budget),timeframes=projectPolicy(state.secondaryExecution.timeframe_execution);
console.log(JSON.stringify({compatible:true,idempotent:true,positions:Object.keys(state.frequency.account.positions).length,pending:Object.keys(state.frequency.account.pendingOrders).length,positions_preserved:true,pending_preserved:true,neural_records_preserved:true,capital_install_account_preserved:!!installCapital,migration_events:events.length,profile:state.secondaryExecution.exploration?.version,active:state.secondaryExecution.exploration?.active??false,profit_policy:expectedProfit,neural,capital_allocation:capital,risk_budget:riskBudget,timeframes,new_layers_account_preserved:isDeepStrictEqual(original.frequency,state.frequency),new_layers_funding_preserved:isDeepStrictEqual(original.secondaryExecution.capital_allocation,state.secondaryExecution.capital_allocation),capital_added:'0'}));
"""
    return json.loads(run(['runuser', '-u', 'lumitrading', '--', '/usr/bin/node-24',
                           '--max-old-space-size=96', '--input-type=module', '-e', script,
                           profile, nominal, json.dumps({key: value for key, value in (profit_env or {}).items()
                                                         if key in PROFIT_ENV_KEYS}), str(DB),
                           json.dumps({key: value for key, value in (neural_env or {}).items()
                                       if key in NEURAL_ENV_KEYS}),
                           json.dumps({key: value for key, value in (capital_env or {}).items()
                                       if key in CAPITAL_ENV_KEYS}),
                           json.dumps({key: value for key, value in (risk_env or {}).items()
                                       if key in RISK_ENV_KEYS}),
                           json.dumps({key: value for key, value in (timeframe_env or {}).items()
                                       if key in TIMEFRAME_ENV_KEYS})], cwd=release))


def profit_state_matches(current, expected):
    if expected is None:
        return current is None
    return isinstance(current, dict) and all(current.get(key) == expected.get(key)
                                             for key in ['version', 'active', 'policy_hash', 'policy'])


def neural_state_matches(current, expected):
    if expected is None:
        return True  # Legacy deployment does not introduce a neuronal requirement.
    return isinstance(current, dict) and all(current.get(key) == expected.get(key)
        for key in ['version', 'protocol_hash', 'requested_mode'])


def capital_state_matches(current, expected):
    if expected is None:
        return True
    return isinstance(current, dict) and all(current.get(key) == expected.get(key)
        for key in ['version', 'active', 'policy_hash', 'policy'])


def wait_active(previous_revision, active, expected_profit=None, expected_neural=None,
                expected_capital=None, expected_risk=None, expected_timeframes=None):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            running = run(['systemctl', 'is-active', SERVICE], timeout=5) == 'active'
            row = snapshot()
            x = row['state'].get('secondaryExecution', {})
            if (running and row['revision'] > previous_revision
                    and x.get('exploration', {}).get('active') is active
                    and profit_state_matches(x.get('profit_policy'), expected_profit)
                    and neural_state_matches(row['state'].get('secondaryNeural'), expected_neural)
                    and capital_state_matches(x.get('capital_allocation'), expected_capital)
                    and capital_state_matches(x.get('risk_budget'), expected_risk)
                    and capital_state_matches(x.get('timeframe_execution'), expected_timeframes)):
                return {'revision': row['revision'], 'profile': x.get('exploration', {}).get('version'),
                        'profile_active': active, 'profit_policy': expected_profit,
                        'neural': expected_neural, 'capital_allocation': expected_capital,
                        'risk_budget': expected_risk, 'timeframes': expected_timeframes,
                        'capital_funding_status': (x.get('capital_allocation', {}).get('funding_request') or {}).get('status'),
                        'counts': row['counts']}
        except (RuntimeError, sqlite3.Error):
            pass
        time.sleep(1)
    raise RuntimeError('DEPLOYMENT_NOT_CONFIRMED')


def neural_off_same_release(release, expected_current, original_env, candidate_env,
                            profile, nominal, profit_env, neural_env, capital_env=None,
                            layer='neural', risk_env=None, timeframe_env=None):
    """Optional config reversal: retain the compatible binary and current DB.

    A second full DB backup is unnecessary for disabling optional inference and
    could make recovery impossible on a nearly full disk. Preserve private config
    and verify contracts using read-only clones. No schema/code rollback occurs.
    """
    require_deployment_lease(release, expected_current, original_env)
    require_candidate(release, expected_current)
    migration = verify_migration(release, profile, nominal, profit_env, neural_env, capital_env, risk_env, timeframe_env)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    backup = ENV.with_name('worker.env.before-' + layer + '-off-' + stamp)
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(original_env); file.flush(); os.fsync(file.fileno())
    stopped = False
    written = False
    try:
        require_deployment_lease(release, expected_current, original_env)
        run(['systemctl', 'stop', SERVICE], timeout=30)
        stopped = True
        before = snapshot()
        migration = verify_migration(release, profile, nominal, profit_env, neural_env, capital_env, risk_env, timeframe_env)
        require_deployment_lease(release, expected_current, original_env)
        require_candidate(release, expected_current)
        write_env(candidate_env); written = True
        run(['systemctl', 'start', SERVICE], timeout=20)
        after = wait_active(before['revision'], profile == PROFILE, migration.get('profit_policy'),
                            migration.get('neural'), migration.get('capital_allocation'),
                            migration.get('risk_budget'), migration.get('timeframes'))
        report = {'status': 'NEURAL_OFF_SAME_COMPATIBLE_RELEASE' if layer == 'neural'
                           else 'CAPITAL_ALLOCATION_OFF_SAME_COMPATIBLE_RELEASE' if layer == 'capital-allocation'
                           else 'RISK_BUDGET_OFF_SAME_COMPATIBLE_RELEASE' if layer == 'risk-budget'
                           else 'TIMEFRAMES_OFF_SAME_COMPATIBLE_RELEASE' if layer == 'timeframes'
                           else 'RISK_AND_TIMEFRAMES_OFF_SAME_COMPATIBLE_RELEASE', 'at': stamp,
            'commit': expected_current, 'release': str(release),
            'backup': {'kind': 'PRIVATE_CONFIGURATION_ONLY', 'path': str(backup),
                       'database_backup_not_required': 'NO_CODE_OR_SCHEMA_CHANGE'},
            'migration': migration, 'before_revision': before['revision'], 'after': after,
            'profile': profile, 'nominal_usd': nominal, 'profit_configuration': profit_env,
            'neural_configuration': neural_env, 'capital_configuration': capital_env or {},
            'risk_configuration': risk_env or {}, 'timeframe_configuration': timeframe_env or {},
            'schema_changed': False,
            'database_restored': False, 'binary_changed': False}
        report_path = DB.parent / (layer + '-off-' + stamp + '.json')
        report_path.write_text(json.dumps(report, indent=2) + '\n'); os.chmod(report_path, 0o600)
        return report
    except Exception:
        if stopped:
            expected_env = candidate_env if written else original_env
            if CURRENT.resolve() != release or ENV.read_text() != expected_env:
                raise RuntimeError('NEURAL_OFF_LEASE_LOST_DURING_RECOVERY' if layer == 'neural'
                                   else 'CAPITAL_ALLOCATION_OFF_LEASE_LOST_DURING_RECOVERY' if layer == 'capital-allocation'
                                   else 'POLICY_OFF_LEASE_LOST_DURING_RECOVERY')
            # Once OFF is written, a failure cannot reactivate the optional layer.
            run(['systemctl', 'start', SERVICE], timeout=20)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target')
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--profile', choices=[PROFILE, 'OFF'], default=None)
    parser.add_argument('--nominal', default=None)
    parser.add_argument('--risk-budget', choices=[RISK_BUDGET, 'OFF'], default=None)
    parser.add_argument('--timeframes', choices=[TIMEFRAMES, 'OFF'], default=None)
    parser.add_argument('--neural-mode', choices=NEURAL_MODES, default=None)
    parser.add_argument('--capital-allocation', choices=[CAPITAL_ALLOCATION, 'OFF'], default=None)
    parser.add_argument('--allocation-base-usd', default=None)
    parser.add_argument('--preferred-multiplier', default=None)
    parser.add_argument('--target-equity-usd', default=None)
    parser.add_argument('--capital-request-id', default=None)
    parser.add_argument('--profit-policy', choices=[PROFIT_POLICY, EARLY_PROFIT_POLICY, 'OFF'], default=None)
    parser.add_argument('--min-expected-net-target-fraction', default=None)
    parser.add_argument('--trailing-retracement-fraction', default=None)
    parser.add_argument('--trailing-extension-ms', default=None)
    parser.add_argument('--trailing-stagnation-ms', default=None)
    args = parser.parse_args()
    if not all(re.fullmatch(r'[0-9a-f]{40}', sha) for sha in [args.target, args.expected_current]):
        raise RuntimeError('EXACT_COMMIT_REQUIRED')
    if args.nominal is not None and (not re.fullmatch(r'(?:\d+\.?\d*|\.\d+)', args.nominal) or not 0 < float(args.nominal) < float('inf')):
        raise RuntimeError('FINITE_POSITIVE_NOMINAL_REQUIRED')
    profit_changes = profit_env_changes(args.profit_policy, args.min_expected_net_target_fraction,
                                       args.trailing_retracement_fraction, args.trailing_extension_ms,
                                       args.trailing_stagnation_ms)
    neural_changes = neural_env_changes(args.neural_mode)
    capital_changes = capital_env_changes(args.capital_allocation, args.allocation_base_usd,
                                          args.preferred_multiplier, args.target_equity_usd,
                                          args.capital_request_id)
    risk_changes = risk_env_changes(args.risk_budget)
    timeframe_changes = timeframe_env_changes(args.timeframes)
    advanced_changes = bool(risk_changes or timeframe_changes)
    if advanced_changes and (profit_changes or neural_changes or capital_changes):
        raise RuntimeError('RISK_TIMEFRAME_UPDATE_CANNOT_CHANGE_EXISTING_POLICIES')
    if neural_changes and profit_changes:
        raise RuntimeError('NEURAL_UPDATE_CANNOT_CHANGE_PROFIT_POLICY')
    if capital_changes and (profit_changes or neural_changes):
        raise RuntimeError('CAPITAL_UPDATE_CANNOT_CHANGE_PROFIT_OR_NEURAL')
    with (DB.parent / 'deploy-exploration.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        original_env = ENV.read_text()
        previous_settings = read_env(original_env)
        validate_env(previous_settings)
        if advanced_changes:
            profile = previous_settings.get('LUMI_TRADING_SECONDARY_PROFILE')
            nominal = previous_settings.get('LUMI_TRADING_SECONDARY_NOMINAL_USD')
            if (profile not in [PROFILE, 'OFF'] or nominal is None
                    or args.profile is not None and args.profile != profile
                    or args.nominal is not None and args.nominal != nominal):
                raise RuntimeError('RISK_TIMEFRAME_UPDATE_MUST_PRESERVE_EXPLORATION_AND_NOMINAL')
            if any(value != 'OFF' for value in [args.risk_budget, args.timeframes] if value is not None):
                if (profile != PROFILE or previous_settings.get('LUMI_TRADING_SECONDARY_PROFIT_POLICY') != EARLY_PROFIT_POLICY
                        or previous_settings.get('LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION') not in [CAPITAL_ALLOCATION, 'OFF']):
                    raise RuntimeError('EXISTING_V2_PROFIT_AND_FINITE_CAPITAL_REQUIRED')
        elif neural_changes or capital_changes:
            profile = previous_settings.get('LUMI_TRADING_SECONDARY_PROFILE')
            nominal = previous_settings.get('LUMI_TRADING_SECONDARY_NOMINAL_USD')
            if (profile not in [PROFILE, 'OFF'] or nominal is None
                    or args.profile is not None and args.profile != profile
                    or args.nominal is not None and args.nominal != nominal):
                raise RuntimeError('NEURAL_UPDATE_MUST_PRESERVE_EXPLORATION_AND_NOMINAL' if neural_changes
                                   else 'CAPITAL_UPDATE_MUST_PRESERVE_EXPLORATION_AND_NOMINAL')
            if (args.neural_mode if neural_changes else args.capital_allocation) != 'OFF' and (profile != PROFILE
                    or previous_settings.get('LUMI_TRADING_SECONDARY_PROFIT_POLICY') != PROFIT_POLICY):
                raise RuntimeError('EXISTING_EXPLORATION_AND_PROFIT_POLICY_REQUIRED')
        else:
            # A profit-policy update does not implicitly reset the active entry
            # profile or nominal. Only explicitly supplied values may change.
            profile = args.profile or (previous_settings.get('LUMI_TRADING_SECONDARY_PROFILE', PROFILE) if args.profit_policy == EARLY_PROFIT_POLICY else PROFILE)
            nominal = args.nominal or (previous_settings.get('LUMI_TRADING_SECONDARY_NOMINAL_USD', '100') if args.profit_policy == EARLY_PROFIT_POLICY else '100')
        candidate_env = updated_env(original_env, profile, nominal, profit_changes, neural_changes, capital_changes, risk_changes, timeframe_changes)
        effective_env = read_env(candidate_env)
        effective_profit_env = {key: effective_env[key] for key in PROFIT_ENV_KEYS if key in effective_env}
        effective_neural_env = {key: effective_env[key] for key in NEURAL_ENV_KEYS if key in effective_env}
        effective_capital_env = {key: effective_env[key] for key in CAPITAL_ENV_KEYS if key in effective_env}
        effective_risk_env = {key: effective_env[key] for key in RISK_ENV_KEYS if key in effective_env}
        effective_timeframe_env = {key: effective_env[key] for key in TIMEFRAME_ENV_KEYS if key in effective_env}
        def migration_check():
            if effective_risk_env or effective_timeframe_env:
                return verify_migration(release, profile, nominal, effective_profit_env, effective_neural_env,
                                        effective_capital_env, effective_risk_env, effective_timeframe_env)
            extra = [effective_neural_env] if effective_neural_env or effective_capital_env else []
            if effective_capital_env:
                extra.append(effective_capital_env)
            return verify_migration(release, profile, nominal, effective_profit_env, *extra)
        old = CURRENT.resolve()
        require_deployment_lease(old, args.expected_current, original_env)
        require_clean(old)
        advanced_off = advanced_changes and all(value == 'OFF' for value in [args.risk_budget, args.timeframes] if value is not None)
        if (args.neural_mode == 'OFF' or args.capital_allocation == 'OFF' or advanced_off) and args.target == args.expected_current:
            layer = ('risk-timeframes' if risk_changes and timeframe_changes else 'risk-budget' if risk_changes else 'timeframes') if advanced_off else 'neural' if args.neural_mode == 'OFF' else 'capital-allocation'
            report = neural_off_same_release(old, args.expected_current, original_env, candidate_env,
                profile, nominal, effective_profit_env, effective_neural_env, effective_capital_env,
                layer, effective_risk_env, effective_timeframe_env)
            print(json.dumps(report))
            return
        fetch_target(old, args.target)
        release = RELEASES / args.target
        if not release.exists():
            previous_umask = os.umask(0o022)
            try:
                # Transfer objects locally into the new release rather than
                # adding another alternates hop to the active release chain.
                # No remote credentials/network or changes to the source tree.
                run(['git', '-c', 'pack.threads=1', '-c', 'pack.windowMemory=16m',
                     'clone', '--no-local', '--no-checkout', str(old), str(release)], timeout=60)
                # The verified target may exist only in the source FETCH_HEAD,
                # outside refs advertised by clone. Copy that exact SHA locally.
                run(['git', '-c', 'pack.threads=1', '-c', 'pack.windowMemory=16m',
                     'fetch', '--no-tags', '--no-write-fetch-head', str(old), args.target],
                    cwd=release, timeout=60)
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
        migration = migration_check()
        disk_space = require_backup_space()
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        stopped = False
        swapped = False
        configuration_written = False
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
            migration = migration_check()
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
            after = wait_active(before['revision'], profile == PROFILE, migration.get('profit_policy'),
                                migration.get('neural'), migration.get('capital_allocation'),
                            migration.get('risk_budget'), migration.get('timeframes'))
            report = {'status': 'DEPLOYED', 'at': stamp, 'previous_commit': args.expected_current,
                      'commit': args.target, 'release': str(release), 'backup': backup,
                      'migration': migration, 'before_revision': before['revision'], 'after': after,
                      'profile': profile, 'nominal_usd': nominal,
                      'profit_configuration': effective_profit_env,
                      'neural_configuration': effective_neural_env,
                      'capital_configuration': effective_capital_env,
                      'risk_configuration': effective_risk_env, 'timeframe_configuration': effective_timeframe_env,
                      'disk_space_preflight': disk_space,
                      'rollback': {'compatible_commit': args.target,
                                   'profile': profile if advanced_changes or neural_changes or capital_changes or effective_profit_env else 'OFF',
                                   'profit_policy': effective_profit_env.get('LUMI_TRADING_SECONDARY_PROFIT_POLICY')
                                                    if advanced_changes or neural_changes or effective_capital_env else 'OFF' if effective_profit_env else None,
                                   'neural_mode': 'OFF' if neural_changes else None,
                                   'capital_allocation': 'OFF' if effective_capital_env and not neural_changes and not advanced_changes else None,
                                   'risk_budget': 'OFF' if risk_changes else None,
                                   'timeframes': 'OFF' if timeframe_changes else None,
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
                # Profit admission can be disabled without reintroducing the
                # old financial gates or abandoning the recovered exploration.
                # Existing position contracts still use this compatible binary.
                if advanced_changes:
                    # Keep early protection, finite capital, neural mode and signed
                    # positions; disable only the explicitly requested new layers.
                    write_env(updated_env(candidate_env, profile, nominal,
                                          risk_changes=risk_env_changes('OFF') if risk_changes else None,
                                          timeframe_changes=timeframe_env_changes('OFF') if timeframe_changes else None))
                elif neural_changes:
                    # The authorized integration cannot disable useful-margin
                    # admission or trailing/exploration as a recovery shortcut.
                    write_env(updated_env(candidate_env, profile, nominal,
                                          neural_changes=neural_env_changes('OFF')))
                elif capital_changes or effective_capital_env:
                    # The compatible allocation OFF mode retains its finite
                    # capital marker and history; it cannot re-enable unlimited
                    # topups or weaken useful-margin/trailing/neural contracts.
                    write_env(updated_env(candidate_env, profile, nominal,
                                          capital_changes=capital_env_changes('OFF')))
                elif effective_profit_env:
                    write_env(updated_env(candidate_env, profile, nominal,
                                          {'LUMI_TRADING_SECONDARY_PROFIT_POLICY': 'OFF'}))
                else:
                    write_env(updated_env(original_env, 'OFF', nominal))
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
