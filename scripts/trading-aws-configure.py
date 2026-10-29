#!/usr/bin/env python3
"""Run as root over authenticated SSH. Secrets enter through stdin, never argv."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def validate_secrets(data):
    expected={'SUPABASE_SERVICE_ROLE_KEY','LUMI_TELEGRAM_BOT_TOKEN','LUMI_TELEGRAM_REVIEW_TEST_USERS'}
    if not isinstance(data,dict) or set(data)!=expected:
        raise ValueError('INVALID_CONFIGURATION_KEYS')
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{40,4096}',data.get('SUPABASE_SERVICE_ROLE_KEY','')):
        raise ValueError('INVALID_STAGING_KEY')
    token=data.get('LUMI_TELEGRAM_BOT_TOKEN','')
    if not re.fullmatch(r'[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,100}',token):
        raise ValueError('INVALID_BOT_TOKEN')
    if not re.fullmatch(r'[1-9][0-9]{0,19}',data.get('LUMI_TELEGRAM_REVIEW_TEST_USERS','')):
        raise ValueError('ONE_PRIVATE_OWNER_REQUIRED')
    return {**data,'LUMI_TELEGRAM_BOT_ID':token.split(':')[0],'LUMI_TRADING_ALERTS':'true'}


def main():
    if os.geteuid()!=0:
        raise ValueError('ROOT_INSTALLER_REQUIRED')
    os.umask(0o077)
    config=Path('/etc/lumi-trading/worker.env')
    if config.exists():
        # A lost SSH response is not permission to overwrite secrets or replay alerts.
        # enable --now does not restart an already running unit. It also recovers
        # a disconnect after writing the file but before requesting the start.
        subprocess.run(['systemctl','disable','--now','lumi-trading-install-expiry.timer'],check=True)
        subprocess.run(['systemctl','enable','--now','lumi-trading.service'],check=True)
        print('EXISTING_CONFIGURATION_START_REQUESTED: no se reemplazaron secretos; verificar estado.')
        return
    raw=sys.stdin.read(16385)
    if len(raw)>16384:
        raise ValueError('CONFIGURATION_TOO_LARGE')
    values=dict(line.split('=',1) for line in Path('/etc/lumi-trading/worker.identity').read_text().splitlines())
    values.update(validate_secrets(json.loads(raw)))
    verify="""
      import {createClient} from '@supabase/supabase-js';
      import {assertTradingRuntime} from './lib/trading/runtime-guard.js';
      import {TradingNotifier} from './lib/trading/notifier.js';
      try {
        const env=process.env; await assertTradingRuntime(env);
        const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:(u,o={})=>fetch(u,{...o,signal:AbortSignal.timeout(8000)})}});
        await new TradingNotifier({db,env,feed:{},pending:()=>false}).verify();
        console.log('PRIVATE_STAGING_CONFIGURATION_VERIFIED');
      } catch { console.error('PRIVATE_STAGING_CONFIGURATION_NOT_VERIFIED'); process.exit(1); }
    """
    subprocess.run(['/usr/bin/node-24','--input-type=module','-e',verify],cwd='/opt/lumi-trading/current',
                   env={**os.environ,**values},timeout=45,check=True)
    with tempfile.NamedTemporaryFile('w',dir=config.parent,delete=False) as tmp:
        tmp.write(''.join(k+'='+v+'\n' for k,v in values.items()))
        name=tmp.name
    os.chmod(name,0o600)
    os.replace(name,config)
    subprocess.run(['systemctl','disable','--now','lumi-trading-install-expiry.timer'],check=True)
    subprocess.run(['systemctl','enable','--now','lumi-trading.service'],check=True)
    print('WORKER_START_REQUESTED: falta verificar feed, persistencia y recibo real de Telegram.')


if __name__=='__main__':
    try:
        main()
    except Exception:
        # Never print input, credentials, provider replies or subprocess environment.
        print('CONFIGURATION_FAILED: no se confirma activación; revisar antes de reintentar.')
        raise SystemExit(1)
