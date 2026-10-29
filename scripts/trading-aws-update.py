#!/usr/bin/env python3
"""Root-only, pinned release update of the existing configured paper worker.

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

BASE = 'c054ccfdd2f16f1a3cac6a67d7d19fc3e6a670eb'
ORIGIN = 'https://github.com/AgustinGettar/content-factory-renderer.git'
CURRENT = Path('/opt/lumi-trading/current')
RELEASES = Path('/opt/lumi-trading/releases')
ALLOWED = {'lib/trading/core.js','lib/trading/capital.js','lib/trading/engine.js',
           'lib/trading/notifier.js','scripts/trading-aws-update.py','test/trading-capital.test.js',
           'test/trading-core.test.js','test/trading_aws_update_test.py',
           'docs/trading/AWS.md','docs/trading/OPERATIONS.md'}


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


def inspect_capital(release, env, apply_check=False):
    script="""
      import {createClient} from '@supabase/supabase-js';
      import {assertTradingRuntime} from './lib/trading/runtime-guard.js';
      import {reconcilePaperCapital} from './lib/trading/capital.js';
      await assertTradingRuntime(process.env);
      const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:(u,o={})=>fetch(u,{...o,signal:AbortSignal.timeout(8000)})}});
      const {data,error}=await db.from('lumi_trading_state').select('state,updated_at,revision').eq('id','KRAKEN_BTCUSD_PAPER').single();
      if(error)throw Error('STATE_READ_FAILED');
      if(process.env.LUMI_UPDATE_PREFLIGHT==='true')reconcilePaperCapital(structuredClone(data.state),Date.now());
      console.log(JSON.stringify({initial_cash:data.state.capital?.initialCash??null,equity:data.state.research.versions[data.state.research.active].account.equity,revision:data.revision,updated_at:data.updated_at}));
    """
    return json.loads(run(['/usr/bin/node-24','--input-type=module','-e',script],cwd=release,
                          env={**env,'LUMI_UPDATE_PREFLIGHT':'true' if apply_check else 'false'},timeout=30))


def switch_to(path):
    temp=CURRENT.with_name('.lumi-current-update')
    if temp.exists() or temp.is_symlink():
        temp.unlink()
    temp.symlink_to(path)
    temp.replace(CURRENT)


def update(target):
    if os.geteuid()!=0 or not re.fullmatch('[a-f0-9]{40}',target):
        raise RuntimeError('ROOT_AND_PINNED_REVISION_REQUIRED')
    old=CURRENT.resolve()
    if old.parent!=RELEASES or run(['git','-C',str(old),'rev-parse','HEAD']) not in [BASE,target]:
        raise RuntimeError('UNEXPECTED_CURRENT_RELEASE')
    env=env_values()
    if old.name==target:
        status=inspect_capital(old,env)
        print(json.dumps({'already_installed':True,**status}))
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
        run(['git','-C',str(old),'worktree','add','--detach',str(release),target])
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
    run(['/usr/bin/node-24','--test','test/trading-capital.test.js'],cwd=release)
    inspect_capital(release,env,apply_check=True)  # Read only, while old worker runs.
    switched=False
    try:
        run(['systemctl','stop','lumi-trading.service'],timeout=30)
        if run(['systemctl','show','lumi-trading.service','--property=ActiveState','--value'])!='inactive':
            raise RuntimeError('WORKER_NOT_STOPPED')
        inspect_capital(release,env,apply_check=True)  # Recheck final checkpoint.
        switch_to(release);switched=True
        run(['systemctl','start','lumi-trading.service'])
        for attempt in range(6):
            status=inspect_capital(release,env)
            if status['initial_cash']=='100':
                print(json.dumps({'release':target,'service':run(['systemctl','show','lumi-trading.service','--property=ActiveState','--value']),**status}))
                return
            if attempt<5:time.sleep(3)
        raise RuntimeError('CAPITAL_CHECKPOINT_PENDING')
    except Exception:
        # Do not roll back to the old 10,000 policy after a committed USD100
        # checkpoint, including an ambiguous database response. Keep the new
        # release in that case so a retry can reconcile without undoing money.
        committed=None
        try:committed=inspect_capital(release,env)['initial_cash']=='100'
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
