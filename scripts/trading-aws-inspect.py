#!/usr/bin/env python3
"""Read-only service, timestamped health and staging receipt inspection over SSH."""
import json
import os
from pathlib import Path
import subprocess


def sanitize_health(rows):
    latest=None
    allowed={'event','connected','reconciled','quotes','trades','quote_age_ms','cpu_fraction','rss_bytes','revision','mode'}
    for line in rows.splitlines():
        try:
            row=json.loads(line);message=json.loads(row['MESSAGE'])
            if message.get('event')=='lumi_trading_health':
                latest={k:v for k,v in message.items() if k in allowed}
                latest['logged_at_ms']=int(row['__REALTIME_TIMESTAMP'])//1000
        except (KeyError,TypeError,ValueError):
            continue
    return latest


def main():
    state=subprocess.check_output(['systemctl','show','lumi-trading.service','--property=ActiveState,SubState,ExecMainStatus,ActiveEnterTimestamp'],text=True)
    journal=subprocess.run(['journalctl','-u','lumi-trading.service','-n','120','--no-pager','-o','json'],capture_output=True,text=True,check=True)
    result={'service':dict(line.split('=',1) for line in state.splitlines() if '=' in line),
            'last_health_sample':sanitize_health(journal.stdout)}
    config=Path('/etc/lumi-trading/worker.env')
    if config.exists():
        values=dict(line.split('=',1) for line in config.read_text().splitlines() if '=' in line)
        script="""
          import {createClient} from '@supabase/supabase-js';
          import {assertTradingRuntime} from './lib/trading/runtime-guard.js';
          try {
            await assertTradingRuntime(process.env);
            const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:(u,o={})=>fetch(u,{...o,signal:AbortSignal.timeout(8000)})}});
            const state=await db.from('lumi_trading_state').select('revision,lease_until,updated_at').eq('id','KRAKEN_BTCUSD_PAPER').single();
            const notice=await db.from('lumi_trading_outbox').select('status,receipt,finished_at').eq('kind','TECHNICAL').order('created_at',{ascending:false}).limit(1);
            if(state.error||notice.error)throw Error();
            const n=notice.data[0];
            console.log(JSON.stringify({storage_checked:true,state:state.data,technical_notice:n?{status:n.status,message_id:n.receipt?.message_id??null,response_at:n.receipt?.response_at??null,finished_at:n.finished_at,read_confirmed:false}:null}));
          } catch { console.log(JSON.stringify({storage_checked:false})); }
        """
        check=subprocess.run(['/usr/bin/node-24','--input-type=module','-e',script],cwd='/opt/lumi-trading/current',
                             env={**os.environ,**values},capture_output=True,text=True,timeout=30)
        try:result['staging']=json.loads(check.stdout)
        except ValueError:result['staging']={'storage_checked':False}
    else:
        result['configured']=False
    print(json.dumps(result,indent=2))


if __name__=='__main__':
    try:main()
    except Exception:
        print('{"inspection_failed":true}')
        raise SystemExit(1)
