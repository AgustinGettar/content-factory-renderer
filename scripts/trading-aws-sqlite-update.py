#!/usr/bin/env python3
"""Migrate only the existing AWS PAPER worker. Private bootstrap arrives on stdin.

Never create a VM, change Lumi routes, or print credentials. Stop the old writer,
verify the export barrier, import atomically, and retain all recovery material.
"""
import base64
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error

BASES={'0490929d46971285303f62ceb7443d8efdf792d7','b62f45c6f80de411a1ef69fc79427d5a2884b005'}
BASE='0490929d46971285303f62ceb7443d8efdf792d7'
ORIGIN='https://github.com/AgustinGettar/content-factory-renderer.git'
SITE='https://lumi-trading-monitor.aguzz-gettar.chatgpt.site/'
CURRENT=Path('/opt/lumi-trading/current')
RELEASES=Path('/opt/lumi-trading/releases')
ENV=Path('/etc/lumi-trading/worker.env')
STATE=Path('/var/lib/lumi-trading')
DB=STATE/'trading.sqlite'
DROPIN=Path('/etc/systemd/system/lumi-trading.service.d/storage.conf')

def run(args,**kwargs):
    return subprocess.run(args,check=True,capture_output=True,text=True,
                          timeout=kwargs.pop('timeout',45),**kwargs).stdout.strip()

def write_private(path,text):
    temp=path.with_name(path.name+'.sqlite-update-tmp')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:
        f.write(text);f.flush();os.fsync(f.fileno())
    temp.replace(path)

def source_barrier(env,bundle):
    url=env.get('SUPABASE_URL')
    if url!='https://mofjhwathxzfnjapvvst.supabase.co':
        raise RuntimeError('SOURCE_PROJECT_MISMATCH')
    key=env['SUPABASE_SERVICE_ROLE_KEY']
    request=urllib.request.Request(url+'/rest/v1/lumi_trading_state?select=revision&id=eq.KRAKEN_BTCUSD_PAPER',headers={'apikey':key,'Authorization':'Bearer '+key})
    try:
        with urllib.request.urlopen(request,timeout=12) as r:
            rows=json.loads(r.read(16384))
        if len(rows)!=1 or rows[0]['revision']!=bundle['state']['revision']:
            raise RuntimeError('SOURCE_ADVANCED_NEW_EXPORT_REQUIRED')
    except urllib.error.HTTPError as e:
        if e.code!=402 or 'exceed_egress_quota' not in e.read(4096).decode('utf-8','replace'):
            raise RuntimeError('SOURCE_CHECK_NOT_CONFIRMED') from None
        # Management export taken while Data API is restricted. The stopped
        # worker cannot write behind this barrier. Never substitute empty state.

def validate_bootstrap(payload,env):
    compressed=base64.b64decode(payload['export_gzip'],validate=True)
    if hashlib.sha256(compressed).hexdigest()!=payload['export_sha256']:
        raise RuntimeError('EXPORT_CHECKSUM_MISMATCH')
    if len(compressed)>16000000:raise RuntimeError('EXPORT_TOO_LARGE')
    bundle=json.loads(gzip.decompress(compressed))
    if bundle.get('schema')!=1 or bundle['state']['id']!='KRAKEN_BTCUSD_PAPER':
        raise RuntimeError('EXPORT_INVALID')
    if bundle['counts']!={'events':len(bundle['events']),'outbox':len(bundle['outbox'])}:
        raise RuntimeError('EXPORT_INCOMPLETE')
    owners=bundle['owners'];owner=env.get('LUMI_TELEGRAM_REVIEW_TEST_USERS')
    if len(owners)!=1 or not re.fullmatch('[1-9][0-9]+',owner or '') or any(str(owners[0].get(k))!=owner for k in ['user_id','chat_id','session_chat_id','state_chat_id']):
        raise RuntimeError('OWNER_MISMATCH')
    config=payload['runtime']
    if set(config)!={'LUMI_TRADING_SITE_ACCESS','LUMI_TRADING_PUBLISH_KEY','LUMI_TRADING_BACKUP_KEY'}:
        raise RuntimeError('RUNTIME_CONFIG_INVALID')
    if any(not isinstance(v,str) or not 32<=len(v)<=4096 or '\n' in v or '\r' in v for v in config.values()):
        raise RuntimeError('RUNTIME_CONFIG_INVALID')
    if not re.fullmatch('[a-f0-9]{64}',config['LUMI_TRADING_BACKUP_KEY']):raise RuntimeError('BACKUP_KEY_INVALID')
    return bundle,owner

def check_site(config):
    req=urllib.request.Request(SITE+'api/aws/ready',headers={'OAI-Sites-Authorization':'Bearer '+config['LUMI_TRADING_SITE_ACCESS'],'X-Trading-Ingest-Key':config['LUMI_TRADING_PUBLISH_KEY']})
    with urllib.request.urlopen(req,timeout=15) as r:
        data=json.loads(r.read(4096))
    if data!={'ready':True,'storage':'AWS_SQLITE'}:raise RuntimeError('DASHBOARD_NOT_READY')

def switch_to(path):
    temp=CURRENT.with_name('.lumi-sqlite-current')
    if temp.exists() or temp.is_symlink():temp.unlink()
    temp.symlink_to(path);temp.replace(CURRENT)

def status(release):
    script="""
      import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync('/var/lib/lumi-trading/trading.sqlite',{readOnly:true,timeout:3000});
      const row=db.prepare('SELECT * FROM state').get(),s=JSON.parse(row.state);
      const a=s.research.versions[s.research.active].account;
      const last=db.prepare("SELECT payload FROM events WHERE kind='FEED_AUDIT' ORDER BY created_at DESC LIMIT 1").get();
      const f=last?JSON.parse(last.payload):null,now=Date.now();
      const p=db.prepare("SELECT value FROM metadata WHERE key='dashboard'").get();
      const publish=p?JSON.parse(p.value):null;
      const notice=db.prepare("SELECT status FROM outbox WHERE json_extract(payload,'$.type')='AWS_SQLITE_ENABLED' ORDER BY created_at DESC LIMIT 1").get();
      console.log(JSON.stringify({revision:row.revision,schema:s.schema,frequency_equity:s.frequency.account.equity,baseline_equity:a.equity,heartbeat_recent:now-Date.parse(row.updated_at)<45000&&Date.parse(row.lease_until)>now,market_recent:!!f&&now-f.at<95000&&f.feed.connected&&f.feed.reconciled&&f.feed.system==='online'&&f.at-f.feed.quote?.event_at<=5000&&f.at-f.feed.trade?.event_at<=30000,dashboard_recent:!!publish&&now-publish.at<45000,backup_confirmed:!!publish?.backup_at,telegram:notice?.status??'PENDING'}));db.close();
    """
    return json.loads(run(['/usr/bin/node-24','--input-type=module','-e',script],cwd=release))

def update(target,payload):
    if os.geteuid()!=0 or not re.fullmatch('[a-f0-9]{40}',target):raise RuntimeError('ROOT_PINNED_RELEASE_REQUIRED')
    if ENV.is_symlink() or ENV.stat().st_mode&0o077:raise RuntimeError('PRIVATE_CONFIGURATION_REQUIRED')
    env=dict(line.split('=',1) for line in ENV.read_text().splitlines() if '=' in line)
    if env.get('LUMI_TRADING_MODE')!='PAPER' or env.get('LUMI_TRADING_AWS_INSTANCE_ID')!='i-0ae2ad0bb886f3d7f':raise RuntimeError('WRONG_INSTANCE_OR_MODE')
    bundle,owner=validate_bootstrap(payload,env);check_site(payload['runtime'])
    old=CURRENT.resolve()
    if old.parent!=RELEASES or run(['git','-C',str(old),'rev-parse','HEAD']) not in BASES|{target}:raise RuntimeError('UNEXPECTED_RELEASE')
    if run(['git','-C',str(old),'remote','get-url','origin'])!=ORIGIN:raise RuntimeError('WRONG_REPOSITORY')
    for args in [['diff','--exit-code'],['diff','--cached','--exit-code']]:run(['git','-C',str(old),*args])
    run(['git','-C',str(old),'fetch','--no-tags','origin',target],timeout=60)
    run(['git','-C',str(old),'merge-base','--is-ancestor',BASE,target])
    changed=run(['git','-C',str(old),'diff','--name-only',BASE,target]).splitlines()
    if not changed or any(not re.fullmatch(r'(lib/trading/[^/]+\.(js|mjs)|scripts/trading-[^/]+\.(py|mjs)|test/trading[-_][^/]+\.(py|js)|docs/trading/[^/]+\.md)',p) for p in changed):raise RuntimeError('OUTSIDE_TRADING_SCOPE')
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
    run(['/usr/bin/node-24','--test','test/trading-sqlite.test.js','test/trading-portfolio.test.js','test/trading-notifier.test.js'],cwd=release)
    run(['/usr/bin/node-24','--input-type=module','-e',"import {assertTradingRuntime} from './lib/trading/runtime-guard.js';await assertTradingRuntime(process.env);"],cwd=release,env={**os.environ,**env})
    if STATE.is_symlink() or DB.is_symlink():raise RuntimeError('UNSAFE_STATE_PATH')
    STATE.mkdir(mode=0o700,exist_ok=True);user=pwd.getpwnam('lumitrading');os.chown(STATE,user.pw_uid,user.pw_gid)
    if not DB.exists() and __import__('shutil').disk_usage(STATE).free<512*1024*1024:raise RuntimeError('DISK_SPACE_REQUIRED')
    run(['systemctl','stop','lumi-trading.service'],timeout=35)
    if run(['systemctl','show','lumi-trading.service','--property=ActiveState','--value'])!='inactive':raise RuntimeError('OLD_WRITER_NOT_STOPPED')
    if not DB.exists():
        try:source_barrier(env,bundle)
        except Exception:
            run(['systemctl','start','lumi-trading.service'])
            raise
        # SQLite import is one transaction; rename only after successful integrity check.
        temp=STATE/'import.sqlite'
        script="""import {SQLiteStore} from './lib/trading/sqlite-store.js';import assert from 'node:assert/strict';let raw='';for await(const c of process.stdin)raw+=c;const b=JSON.parse(raw),s=new SQLiteStore('/var/lib/lumi-trading/import.sqlite',{allowEmpty:true}),prior=s.row();if(prior){assert.equal(prior.revision,b.state.revision);assert.deepEqual(prior.state,b.state.state);assert.equal(s.db.prepare('SELECT count(*) n FROM events').get().n,b.counts.events);assert.equal(s.db.prepare('SELECT count(*) n FROM outbox').get().n,b.counts.outbox);}else s.import(b);if(s.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('INTEGRITY');s.close();"""
        run(['/usr/bin/node-24','--input-type=module','-e',script],cwd=release,input=json.dumps(bundle,separators=(',',':')),timeout=60)
        temp.replace(DB);os.chown(DB,user.pw_uid,user.pw_gid);os.chmod(DB,0o600)
    else:
        script="""import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/var/lib/lumi-trading/trading.sqlite',{readOnly:true});const m=JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='migration'").get().value);if(m.revision!==Number(process.argv[1]))throw Error('DIFFERENT_IMPORT');db.close();"""
        run(['/usr/bin/node-24','--input-type=module','-e',script,str(bundle['state']['revision'])],cwd=release)
    backup=ENV.with_name('worker.env.pre-sqlite')
    if not backup.exists():write_private(backup,ENV.read_text())
    # Credentials are removed from the running Trading environment; audiovisual
    # services and their independent settings are never accessed or changed.
    new={k:v for k,v in env.items() if not k.startswith('SUPABASE_')}
    new.update(payload['runtime']);new.update({'LUMI_TRADING_STORAGE':'SQLITE','LUMI_TRADING_DB_PATH':str(DB),'LUMI_TRADING_OWNER_ID':owner})
    write_private(ENV,'\n'.join(k+'='+v for k,v in new.items())+'\n')
    DROPIN.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
    write_private(DROPIN,'[Service]\nStateDirectory=lumi-trading\nStateDirectoryMode=0700\nReadWritePaths=/var/lib/lumi-trading\nUMask=0077\n')
    switch_to(release);run(['systemctl','daemon-reload']);run(['systemctl','reset-failed','lumi-trading.service']);run(['systemctl','start','lumi-trading.service'])
    result={}
    for attempt in range(22):
        result=status(release);service=run(['systemctl','show','lumi-trading.service','--property=ActiveState','--value'])
        if service=='active' and all(result[k] for k in ['heartbeat_recent','market_recent','dashboard_recent','backup_confirmed']) and result['telegram']=='DELIVERED':break
        if attempt<21:time.sleep(5)
    print(json.dumps({'migration_committed':True,'service':service,'release':target,**result}))

if __name__=='__main__':
    try:
        os.umask(0o077)
        with open('/run/lock/lumi-trading-update.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            update(sys.argv[1],MIGRATION)
    except Exception as error:
        code=str(error)
        print(json.dumps({'migration_committed':False,'error':code if re.fullmatch('[A-Z_]{5,100}',code) else 'MIGRATION_NOT_CONFIRMED','preserve_instance':True}))
        raise SystemExit(1)
