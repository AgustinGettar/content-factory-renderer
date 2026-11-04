#!/usr/bin/env python3
"""Deploy externally tested secondary PAPER modules. No tests/training on EC2.

One graceful restart, consistent backup, exact-head lease, existing dependencies.
Rollback retains the compatible parser and ledger, disabling only quant admission.
"""
import argparse, fcntl, importlib.util, json, os, re, time
from pathlib import Path

_spec=importlib.util.spec_from_file_location('lumi_deploy_base',Path(__file__).with_name('trading-aws-exploration-update.py'))
base=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(base)
FLAGS={
 'LUMI_TRADING_SECONDARY_PROFIT_POLICY':'secondary-profit-policy-2.0.0',
 'LUMI_TRADING_SECONDARY_RISK_BUDGET':'secondary-risk-budget-2.0.0',
 'LUMI_TRADING_SECONDARY_TIMEFRAMES':'secondary-timeframes-2.0.0',
 'LUMI_TRADING_SECONDARY_QUANT':'secondary-quant-1.0.0',
}
ALLOWED={
 'lib/trading/dashboard-publisher.js','lib/trading/multi-pattern-paper.js',
 'lib/trading/secondary-entry-economics.js','lib/trading/secondary-futures-engine.js',
 'lib/trading/secondary-futures-runtime.js','lib/trading/secondary-futures.js',
 'lib/trading/secondary-monitor-activity.js','lib/trading/secondary-profit-policy.js',
 'lib/trading/secondary-risk-budget.js','lib/trading/secondary-timeframes.js',
 'scripts/trading-worker.mjs','scripts/trading-aws-quant-update.py',
 'scripts/trading-quant-download.py','scripts/trading-quant-research.mjs',
 'test/secondary-quant.test.js','test/trading_aws_quant_update_test.py',
}
PREFIXES=('lib/trading/quant-','docs/trading/QUANT-','deploy/trading/compact-panel/')
def allowed_path(path):
    return '..' not in path.split('/') and (path in ALLOWED or path.startswith(PREFIXES))
def candidate_env(original,quant=True):
    current=base.read_env(original);base.validate_env(current)
    if current.get('LUMI_TRADING_SECONDARY_PROFILE')!=base.PROFILE:
        raise RuntimeError('EXISTING_PAPER_EXPLORATION_REQUIRED')
    if current.get('LUMI_TRADING_SECONDARY_CAPITAL_ALLOCATION')!=base.CAPITAL_ALLOCATION:
        raise RuntimeError('FINITE_CAPITAL_REQUIRED')
    updates={**FLAGS,'LUMI_TRADING_SECONDARY_QUANT':FLAGS['LUMI_TRADING_SECONDARY_QUANT'] if quant else 'OFF'}
    lines=[line for line in original.splitlines() if line.split('=',1)[0].strip() not in updates]
    result='\n'.join(lines+[f'{k}={v}' for k,v in updates.items()])+'\n'
    after=base.read_env(result)
    if any(after.get(k)!=v for k,v in current.items() if k not in FLAGS):
        raise RuntimeError('UNRELATED_CONFIGURATION_CHANGED')
    return result
def complete_frames(data):
    return all(type(data.get(str(tf))) is int and data[str(tf)]>0 for tf in [1,5,15,30,60,240,1440])
def verify_live(previous_revision,timeout=180):
    deadline=time.monotonic()+timeout;last=None
    while time.monotonic()<deadline:
        service=base.run(['systemctl','show',base.SERVICE,'--property=ActiveState,NRestarts,MainPID'])
        snapshot=base.snapshot();s=snapshot['state'];x=s['secondaryExecution'];q=x.get('market',{}).get('quote') or {};now=int(time.time()*1000)
        quant=x.get('quant') or {};frames=x.get('timeframe_execution',{}).get('frames',{})
        last={'revision':snapshot['revision'],'service':service,'status':x['status'],'quote_age_ms':now-q.get('event_at',0),'quant_version':quant.get('version'),'quant_active':quant.get('active'),'quant_errors':quant.get('counts',{}).get('errors'),
              'equity':s['frequency']['account']['equity'],'positions':len(s['frequency']['account'].get('positions',{})),
              'timeframes':{k:{'last_cutoff':v.get('last_cutoff'),'completed':v.get('counts',{}).get('completed'),'status':v.get('last_status'),'blocker':v.get('blocker'),'quant_regime':v.get('quant_regime',{}).get('regime')} for k,v in frames.items()}}
        data=x.get('market',{}).get('closed_at',{})
        healthy=('ActiveState=active' in service and snapshot['revision']>previous_revision+2 and 0<=last['quote_age_ms']<=5000 and quant.get('active') is True and quant.get('counts',{}).get('errors',0)==0
                 and x.get('profit_policy',{}).get('version')==FLAGS['LUMI_TRADING_SECONDARY_PROFIT_POLICY']
                 and x.get('risk_budget',{}).get('version')==FLAGS['LUMI_TRADING_SECONDARY_RISK_BUDGET']
                 and x.get('timeframe_execution',{}).get('version')==FLAGS['LUMI_TRADING_SECONDARY_TIMEFRAMES']
                 and frames.get('1',{}).get('counts',{}).get('completed',0)>0
                 and complete_frames(data)
                 and not any(x.get('market',{}).get('frame_errors',{}).values()))
        if healthy:return last
        time.sleep(3)
    raise RuntimeError('QUANT_LIVE_VERIFICATION_TIMEOUT')
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--target',required=True);parser.add_argument('--expected-current',required=True);parser.add_argument('--ci-run-id',required=True);args=parser.parse_args()
    if not all(re.fullmatch('[0-9a-f]{40}',s) for s in [args.target,args.expected_current]) or not re.fullmatch('[0-9]+',args.ci_run_id):raise RuntimeError('EXACT_COMMIT_AND_CI_REQUIRED')
    with (base.DB.parent/'deploy-exploration.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        old=base.CURRENT.resolve();original=base.ENV.read_text();updated=candidate_env(original)
        base.require_deployment_lease(old,args.expected_current,original);base.require_clean(old);base.fetch_target(old,args.target)
        release=base.RELEASES/args.target
        if not release.exists():
            base.run(['git','-c','pack.threads=1','-c','pack.windowMemory=16m','clone','--no-local','--no-checkout',str(old),str(release)],timeout=60)
            base.run(['git','fetch','--no-tags','--no-write-fetch-head',str(old),args.target],cwd=release,timeout=60)
            base.run(['git','remote','set-url','origin',base.ORIGIN],cwd=release)
            base.run(['git','checkout','--detach',args.target],cwd=release)
        base.require_candidate(release,args.target);base.run(['git','merge-base','--is-ancestor',args.expected_current,args.target],cwd=release)
        changed=base.run(['git','diff','--name-only',args.expected_current,args.target],cwd=release).splitlines()
        if not changed or any(not allowed_path(p) for p in changed):raise RuntimeError('OUTSIDE_SECONDARY_QUANT_SCOPE')
        base.share_dependencies(old,release);base.require_backup_space();base.require_branch_head(old,args.target)
        stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime());stopped=False;swapped=False;env_written=False
        try:
            base.require_deployment_lease(old,args.expected_current,original);base.require_candidate(release,args.target)
            base.run(['systemctl','stop',base.SERVICE],timeout=30);stopped=True
            before=base.snapshot();backup=base.consistent_backup('quant-'+stamp)
            # No test, training, backtest or dependency installer executes here.
            base.require_deployment_lease(old,args.expected_current,original);base.require_branch_head(old,args.target)
            base.write_env(updated);env_written=True
            link=base.CURRENT.with_name('current.quant-next')
            if link.is_symlink():link.unlink()
            link.symlink_to(release,target_is_directory=True);os.replace(link,base.CURRENT);swapped=True
            base.run(['systemctl','start',base.SERVICE],timeout=20)
            live=verify_live(before['revision'])
            report={'status':'DEPLOYED_VERIFIED','at':stamp,'commit':args.target,'previous_commit':args.expected_current,'ci_run_id':args.ci_run_id,'before_revision':before['revision'],'after':live,'backup':backup,'changed_paths':changed,'capital_added':'0','realTrading':False,'tests_on_worker':False,'rollback':'SAME_COMPATIBLE_RELEASE_QUANT_OFF_NO_LEDGER_RESTORE'}
            out=base.DB.parent/('deploy-quant-'+stamp+'.json');out.write_text(json.dumps(report,indent=2));os.chmod(out,0o600);print(json.dumps(report))
        except Exception:
            if swapped:
                if base.CURRENT.resolve()!=release or base.ENV.read_text()!=updated:raise RuntimeError('DEPLOYMENT_LEASE_LOST_DURING_RECOVERY')
                base.run(['systemctl','stop',base.SERVICE],timeout=30);base.write_env(candidate_env(updated,quant=False));base.run(['systemctl','start',base.SERVICE],timeout=20)
            elif stopped:
                if env_written:
                    if base.ENV.read_text()!=updated:raise RuntimeError('CONFIGURATION_LEASE_LOST_DURING_RECOVERY')
                    base.write_env(original)
                base.run(['systemctl','start',base.SERVICE],timeout=20)
            raise
if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error) if re.fullmatch('[A-Z_]+',str(error)) else type(error).__name__
        print(json.dumps({'status':'ATTENTION_REQUIRED','code':code,'ledger_restored':False}),flush=True);raise SystemExit(1)
