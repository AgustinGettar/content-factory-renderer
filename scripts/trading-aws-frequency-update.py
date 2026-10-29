#!/usr/bin/env python3
"""Root-only, pinned addition of a second paper account on the existing worker.

No credentials in input or output. The authenticated CloudShell caller supplies
the exact reviewed commit. Reuses unchanged dependencies and preserves state.
"""
import json
import fcntl
import os
from pathlib import Path
import re
import subprocess
import sys
import time

BASE = '4aad0cd56511e6fa68ec1aedd53616f3850c83a0'
ORIGIN = 'https://github.com/AgustinGettar/content-factory-renderer.git'
CURRENT = Path('/opt/lumi-trading/current')
RELEASES = Path('/opt/lumi-trading/releases')
ALLOWED = {'lib/trading/core.js','lib/trading/frequency.js','lib/trading/engine.js',
           'lib/trading/notifier.js','lib/trading/simulator.js',
           'scripts/trading-aws-frequency-update.py','test/trading-frequency.test.js',
           'test/trading_aws_frequency_update_test.py',
           'docs/trading/FREQUENCY.md'}


def run(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, check=True,
                          timeout=kwargs.pop('timeout', 45), **kwargs).stdout.strip()


def env_values():
    path=Path('/etc/lumi-trading/worker.env')
    if path.stat().st_mode & 0o077:
        raise RuntimeError('PRIVATE_CONFIGURATION_PERMISSIONS')
    values=dict(line.split('=',1) for line in path.read_text().splitlines() if '=' in line)
    if values.get('LUMI_TRADING_MODE')!='PAPER' or values.get('LUMI_TRADING_AWS_INSTANCE_ID')!='i-0ae2ad0bb886f3d7f':
        raise RuntimeError('EXISTING_PAPER_INSTANCE_REQUIRED')
    return {**os.environ,**values}


def inspect_frequency(release, env, apply_check=False):
    script="""
      import {createClient} from '@supabase/supabase-js';
      import {assertTradingRuntime} from './lib/trading/runtime-guard.js';
      import {initializeFrequency,FREQUENCY_VERSION} from './lib/trading/frequency.js';
      await assertTradingRuntime(process.env);
      const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:(u,o={})=>fetch(u,{...o,signal:AbortSignal.timeout(8000)})}});
      const {data,error}=await db.from('lumi_trading_state').select('state,updated_at,revision').eq('id','KRAKEN_BTCUSD_PAPER').single();
      if(error)throw Error('STATE_READ_FAILED');
      if(data.state.capital?.initialCash!=='100')throw Error('BASE_CAPITAL_MUST_BE_100');
      if(process.env.LUMI_UPDATE_PREFLIGHT==='true')initializeFrequency(structuredClone(data.state),Date.now());
      const f=data.state.frequency,heartbeat=Date.now()-Date.parse(data.updated_at);
      const committed=!!f&&f.version===FREQUENCY_VERSION&&f.protocol?.initialCash==='100';
      console.log(JSON.stringify({frequency_committed:committed,frequency_version:f?.version??null,frequency_initial_cash:f?.protocol?.initialCash??null,frequency_equity:f?.account?.equity??null,baseline_equity:data.state.research.versions[data.state.research.active].account.equity,heartbeat_recent:heartbeat>=-10000&&heartbeat<45000,revision:data.revision,updated_at:data.updated_at}));
    """
    return json.loads(run(['/usr/bin/node-24','--input-type=module','-e',script],cwd=release,
                          env={**env,'LUMI_UPDATE_PREFLIGHT':'true' if apply_check else 'false'},timeout=30))


def switch_to(path):
    temp=CURRENT.with_name('.lumi-current-update')
    if temp.exists() or temp.is_symlink():
        temp.unlink()
    temp.symlink_to(path)
    temp.replace(CURRENT)


def create_worktree(old,release,target):
    # The service runs as lumitrading; public source must remain readable by it.
    # The installer otherwise retains a private umask and never rewrites secrets.
    previous=os.umask(0o022)
    try:
        run(['git','-C',str(old),'worktree','add','--detach',str(release),target])
    finally:
        os.umask(previous)


def update(target):
    if os.geteuid()!=0 or not re.fullmatch('[a-f0-9]{40}',target):
        raise RuntimeError('ROOT_AND_PINNED_REVISION_REQUIRED')
    old=CURRENT.resolve()
    if old.parent!=RELEASES or run(['git','-C',str(old),'rev-parse','HEAD']) not in [BASE,target]:
        raise RuntimeError('UNEXPECTED_CURRENT_RELEASE')
    env=env_values()
    if old.name==target:
        status=inspect_frequency(old,env)
        service=run(['systemctl','show','lumi-trading.service','--property=ActiveState','--value'])
        if not status['frequency_committed'] or service!='active' or not status['heartbeat_recent']:
            raise RuntimeError('FREQUENCY_CHECKPOINT_PENDING')
        print(json.dumps({'already_installed':True,'service':service,**status}))
        return
    if run(['git','-C',str(old),'remote','get-url','origin'])!=ORIGIN:
        raise RuntimeError('UNEXPECTED_SOURCE_ORIGIN')
    run(['git','-C',str(old),'diff','--exit-code'])
    run(['git','-C',str(old),'diff','--cached','--exit-code'])
    run(['git','-C',str(old),'fetch','--no-tags','origin',target],timeout=60)
    run(['git','-C',str(old),'merge-base','--is-ancestor',BASE,target])
    changed=set(run(['git','-C',str(old),'diff','--name-only',BASE,target]).splitlines())
    if not changed or changed-ALLOWED:
        raise RuntimeError('UPDATE_OUTSIDE_TRADING_SCOPE')
    release=RELEASES/target
    if not release.exists():
        create_worktree(old,release,target)
    if run(['git','-C',str(release),'rev-parse','HEAD'])!=target:
        raise RuntimeError('TARGET_REVISION_MISMATCH')
    run(['git','-C',str(release),'diff','--exit-code'])
    run(['git','-C',str(release),'diff','--cached','--exit-code'])
    if (old/'package-lock.json').read_bytes()!=(release/'package-lock.json').read_bytes():
        raise RuntimeError('DEPENDENCIES_CHANGED')
    modules=release/'node_modules'
    if not modules.exists():
        modules.symlink_to(old/'node_modules')
    if modules.resolve()!=(old/'node_modules').resolve():
        raise RuntimeError('UNEXPECTED_DEPENDENCIES')
    run(['/usr/bin/node-24','--test','test/trading-frequency.test.js'],cwd=release)
    inspect_frequency(release,env,apply_check=True)  # Read only, while old worker runs.
    switched=False
    try:
        run(['systemctl','stop','lumi-trading.service'],timeout=30)
        if run(['systemctl','show','lumi-trading.service','--property=ActiveState','--value'])!='inactive':
            raise RuntimeError('WORKER_NOT_STOPPED')
        inspect_frequency(release,env,apply_check=True)  # Recheck final checkpoint.
        switch_to(release);switched=True
        run(['systemctl','start','lumi-trading.service'])
        for attempt in range(6):
            status=inspect_frequency(release,env)
            service=run(['systemctl','show','lumi-trading.service','--property=ActiveState','--value'])
            if status['frequency_committed'] and status['heartbeat_recent'] and service=='active':
                print(json.dumps({'release':target,'service':service,**status}))
                return
            if attempt<5:time.sleep(3)
        raise RuntimeError('FREQUENCY_CHECKPOINT_PENDING')
    except Exception:
        # An older worker cannot maintain the new account. Never restore it
        # after a committed frequency checkpoint or an ambiguous database read.
        # Preserve the new process/state for an idempotent retry.
        committed=None
        try:committed=inspect_frequency(release,env)['frequency_committed']
        except Exception:pass
        if not switched or committed is False:
            run(['systemctl','stop','lumi-trading.service'],timeout=30)
            switch_to(old)
            run(['systemctl','start','lumi-trading.service'])
        raise


if __name__=='__main__':
    try:
        os.umask(0o077)
        with open('/run/lock/lumi-trading-update.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            update(sys.argv[1])
    except Exception:
        print('UPDATE_NOT_CONFIRMED: conservar la misma VM; no se mostraron secretos.')
        raise SystemExit(1)
