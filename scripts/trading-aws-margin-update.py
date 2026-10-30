#!/usr/bin/env python3
"""Enable bounded automatic PAPER margin on the existing PAPER SQLite worker; preserve accounts."""
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

BASE='7efb855514d59e9ff7218ca713a13841ca6972fe'
ORIGIN='https://github.com/AgustinGettar/content-factory-renderer.git'
CURRENT=Path('/opt/lumi-trading/current')
RELEASES=Path('/opt/lumi-trading/releases')
ENV=Path('/etc/lumi-trading/worker.env')
DB=Path('/var/lib/lumi-trading/trading.sqlite')
ALLOWED={'test/trading-laboratory.test.js', 'scripts/trading-aws-margin-update.py', 'lib/trading/simulator.js', 'lib/trading/learning.js', 'lib/trading/portfolio.js', 'lib/trading/margin.js', 'test/trading-margin.test.js', 'lib/trading/engine.js', 'docs/trading/MARGIN.md', 'lib/trading/laboratory.js', 'lib/trading/monitor-projection.js', 'lib/trading/chart-evidence.js', 'lib/trading/frequency.js', 'lib/trading/notifier.js', 'test/trading_aws_margin_update_test.py'}

def run(args,**kwargs):
    return subprocess.run(args,check=True,capture_output=True,text=True,
                          timeout=kwargs.pop('timeout',45),**kwargs).stdout.strip()

def validate_env(env):
    expected={'LUMI_RUNTIME_ENV':'staging','LUMI_TRADING_MODE':'PAPER',
              'LUMI_TRADING_PLATFORM':'EC2','LUMI_TRADING_STORAGE':'SQLITE',
              'LUMI_TRADING_DB_PATH':str(DB),'LUMI_TRADING_AWS_INSTANCE_ID':'i-0ae2ad0bb886f3d7f',
              'LUMI_TRADING_AWS_REGION':'eu-north-1','LUMI_TRADING_SOURCE_BRANCH':'lumi-trading-aws'}
    if any(env.get(k)!=v for k,v in expected.items()):raise RuntimeError('EXISTING_PAPER_SQLITE_REQUIRED')

def validate_scope(changed):
    if not changed or any(p not in ALLOWED for p in changed):raise RuntimeError('OUTSIDE_MARGIN_SCOPE')

def as_worker(release,script,*args):
    return run(['runuser','-u','lumitrading','--','/usr/bin/node-24','--input-type=module','-e',script,*args],cwd=release)

def fingerprint(release):
    return as_worker(release,"""
      import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
      const db=new DatabaseSync('/var/lib/lumi-trading/trading.sqlite',{readOnly:true,timeout:3000});
      if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('REPAIR_DATABASE_INTEGRITY');
      const hash=createHash('sha256');
      for(const table of ['state','events','outbox','metadata'])for(const row of db.prepare('SELECT * FROM '+table+' ORDER BY '+(table==='metadata'?'key':'id')).iterate())hash.update(JSON.stringify(row));
      console.log(hash.digest('hex'));db.close();
    """)

def service():
    raw=run(['systemctl','show','lumi-trading.service','--property=ActiveState,SubState,MainPID,NRestarts,ExecMainStatus'])
    return dict(line.split('=',1) for line in raw.splitlines() if '=' in line)

def status(release):
    data=json.loads(as_worker(release,"""
      import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync('/var/lib/lumi-trading/trading.sqlite',{readOnly:true,timeout:3000});
      const row=db.prepare('SELECT * FROM state').get(),s=JSON.parse(row.state),now=Date.now();
      const a=s.research.versions[s.research.active].account;
      const recent=(t,max)=>Number.isFinite(t)&&now>=t&&now-t<max;
      const audit=db.prepare("SELECT payload FROM events WHERE kind='FEED_AUDIT' ORDER BY created_at DESC LIMIT 1").get();
      const f=audit?JSON.parse(audit.payload):null;
      const meta=db.prepare("SELECT value FROM metadata WHERE key='dashboard'").get();
      const p=meta?JSON.parse(meta.value):null;
      const n=db.prepare("SELECT status,receipt FROM outbox WHERE json_extract(payload,'$.type')='MARGIN_ENABLED' ORDER BY created_at DESC LIMIT 1").get();
      const receipt=n?.receipt?JSON.parse(n.receipt):{};
      console.log(JSON.stringify({at:now,revision:row.revision,updated_at:row.updated_at,
        primary:a.equity,secondary:s.frequency?.account.equity,
        timeframes:s.timeframes?.frames??[],timeframe_status:s.timeframes?.status??null,
        timeframes_configured:s.schema===4&&s.timeframes?.frames?.join(',')==='1,15,60,240'&&s.timeframes.status==='ACTIVE',
        margin_status:s.margin?.status??null,margin_configured:s.schema===4&&s.margin?.status==='ACTIVE'&&s.margin?.protocol?.leverage?.join(',')==='1,2,3'&&s.margin.protocol.realTrading===false,
        heartbeat_recent:recent(Date.parse(row.updated_at),45000)&&Date.parse(row.lease_until)>now,
        market_recent:!!f&&recent(f.at,15000)&&f.feed.connected&&f.feed.reconciled&&f.feed.system==='online'&&f.at>=f.feed.quote?.event_at&&f.at-f.feed.quote.event_at<=5000&&f.at>=f.feed.trade?.event_at&&f.at-f.feed.trade.event_at<=30000,
        market_sample_at:f?.at??null,
        dashboard_recent:!!p&&recent(p.at,45000),backup_confirmed:!!p&&recent(p.backup_at,3700000),
        telegram:n?.status??'PENDING',telegram_receipt:!!n&&n.status==='DELIVERED'&&Number.isSafeInteger(receipt.message_id)&&receipt.message_id>0,
        dashboard_error:/^(DASHBOARD_|BACKUP_)[A-Z_]{1,80}$/.test(p?.error??'')?p.error:null}));db.close();
    """))
    data['service']=service()
    return data

def recent_errors():
    result=[]
    raw=run(['journalctl','-u','lumi-trading.service','-n','60','--no-pager','-o','json'])
    for line in raw.splitlines():
        try:
            row=json.loads(line);entry=json.loads(row.get('MESSAGE',''))
            if entry.get('event') not in {'lumi_trading_worker_attention_required','trading_dashboard_attention'}:continue
            code=entry.get('code','')
            if not re.fullmatch(r'(TRADING_|DASHBOARD_|BACKUP_|ERR_|SQLITE_|KRAKEN_|TELEGRAM_)[A-Z0-9_]{1,80}',code):continue
            safe={'at':int(row['__REALTIME_TIMESTAMP'])//1000,'code':code}
            if entry.get('error_class') in {'Error','TypeError','ReferenceError','SyntaxError','RangeError'}:safe['error_class']=entry['error_class']
            safe['frames']=[f for f in entry.get('frames',[]) if isinstance(f,str) and re.fullmatch(r'[a-z0-9_-]+\.(js|mjs):[0-9]+:[0-9]+',f)][:4]
            result.append(safe)
        except (ValueError,KeyError,TypeError,AttributeError):continue
    return result[-5:]

def complete(data):
    return (data['service'].get('ActiveState')=='active' and data['service'].get('SubState')=='running'
            and all(data.get(k) for k in ['heartbeat_recent','market_recent','dashboard_recent','backup_confirmed','telegram_receipt','timeframes_configured','margin_configured']))

def update(target):
    if os.geteuid()!=0 or not re.fullmatch('[a-f0-9]{40}',target):raise RuntimeError('ROOT_PINNED_RELEASE_REQUIRED')
    if ENV.is_symlink() or ENV.stat().st_mode&0o077:raise RuntimeError('PRIVATE_CONFIGURATION_REQUIRED')
    config=ENV.read_bytes();env=dict(line.split('=',1) for line in config.decode().splitlines() if '=' in line);validate_env(env)
    old=CURRENT.resolve()
    if old.parent!=RELEASES or run(['git','-C',str(old),'rev-parse','HEAD']) not in {BASE,target}:raise RuntimeError('UNEXPECTED_RELEASE')
    if run(['git','-C',str(old),'remote','get-url','origin'])!=ORIGIN:raise RuntimeError('WRONG_REPOSITORY')
    for args in [['diff','--exit-code'],['diff','--cached','--exit-code']]:run(['git','-C',str(old),*args])
    user=pwd.getpwnam('lumitrading')
    if DB.parent.is_symlink() or DB.is_symlink() or not DB.is_file() or DB.stat().st_uid!=user.pw_uid:raise RuntimeError('EXISTING_DATABASE_REQUIRED')
    run(['git','-C',str(old),'fetch','--no-tags','origin',target],timeout=60)
    run(['git','-C',str(old),'merge-base','--is-ancestor',BASE,target])
    validate_scope(run(['git','-C',str(old),'diff','--name-only',BASE,target]).splitlines())
    release=RELEASES/target
    if not release.exists():
        previous=os.umask(0o022)
        try:run(['git','-C',str(old),'worktree','add','--detach',str(release),target])
        finally:os.umask(previous)
    if run(['git','-C',str(release),'rev-parse','HEAD'])!=target:raise RuntimeError('TARGET_MISMATCH')
    for args in [['diff','--exit-code'],['diff','--cached','--exit-code']]:run(['git','-C',str(release),*args])
    if (old/'package-lock.json').read_bytes()!=(release/'package-lock.json').read_bytes():raise RuntimeError('DEPENDENCIES_CHANGED')
    if not (release/'node_modules').exists():(release/'node_modules').symlink_to(old/'node_modules')
    if (release/'node_modules').resolve()!=(old/'node_modules').resolve():raise RuntimeError('UNEXPECTED_DEPENDENCIES')
    run(['/usr/bin/node-24','--test','test/trading-margin.test.js','test/trading-timeframes.test.js','test/trading-laboratory.test.js','test/trading-engine.test.js','test/trading-portfolio.test.js','test/trading-sqlite.test.js','test/trading-telegram-transport.test.js'],cwd=release,timeout=60)
    run(['/usr/bin/node-24','--input-type=module','-e',"import {assertTradingRuntime} from './lib/trading/runtime-guard.js';await assertTradingRuntime(process.env);"],cwd=release,env={**os.environ,**env})
    spec=importlib.util.spec_from_file_location('verified_update',old/'scripts/trading-aws-sqlite-update.py')
    migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)
    # Already repaired and running: observe; never restart merely to read status.
    applied=old==release and service().get('ActiveState')=='active'
    backup=None
    if not applied:
        if shutil.disk_usage(DB.parent).free<512*1024*1024:raise RuntimeError('DISK_SPACE_REQUIRED')
        migration.stop_writer();before=fingerprint(release)
        backup=str(DB.parent/'backups'/('pre-margin-'+str(time.time_ns())+'.sqlite'))
        as_worker(release,"""
          import {DatabaseSync,backup} from 'node:sqlite';import {mkdir} from 'node:fs/promises';
          const db=new DatabaseSync('/var/lib/lumi-trading/trading.sqlite',{readOnly:true,timeout:3000});
          await mkdir('/var/lib/lumi-trading/backups',{mode:0o700,recursive:true});await backup(db,process.argv[1]);db.close();
          const copy=new DatabaseSync(process.argv[1],{readOnly:true});if(copy.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('REPAIR_BACKUP_INTEGRITY');copy.close();
        """,backup)
        if fingerprint(release)!=before or ENV.read_bytes()!=config:raise RuntimeError('STATE_OR_CONFIG_CHANGED')
        migration.switch_to(release)
        run(['systemctl','reset-failed','lumi-trading.service']);run(['systemctl','start','lumi-trading.service'])
    started=time.monotonic();result={};stable_pid=None;stable_since=started
    for attempt in range(28):
        result=status(release);current_pid=result['service'].get('MainPID')
        if current_pid!=stable_pid:stable_pid=current_pid;stable_since=time.monotonic()
        if complete(result) and time.monotonic()-stable_since>=65:break
        if result['service'].get('ActiveState')=='failed':break
        if attempt<27:time.sleep(5)
    result.update({'repair_applied':True,'release':target,'preserved_before_start':True,
                   'stable_65s':stable_pid not in {None,'0'} and time.monotonic()-stable_since>=65,
                   'backup_created':backup is not None})
    result['verified']=complete(result) and result['stable_65s']
    if not result['verified']:result['errors']=recent_errors()
    return result

if __name__=='__main__':
    try:
        os.umask(0o077)
        with open('/run/lock/lumi-trading-update.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            print(json.dumps(update(sys.argv[1])))
    except Exception as error:
        code=str(error)
        print(json.dumps({'repair_applied':False,'error':code if re.fullmatch('[A-Z_]{5,100}',code) else 'REPAIR_NOT_CONFIRMED','preserve_instance':True}))
        raise SystemExit(1)
