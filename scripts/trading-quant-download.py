#!/usr/bin/env python3
"""External-only public futures history. No credentials, account API or worker DB."""
import argparse, concurrent.futures, datetime, hashlib, json, os, pathlib, time, urllib.request

def main():
    if pathlib.Path('/etc/lumi-trading/worker.env').exists() or os.environ.get('LUMI_TRADING_DB_PATH'):
        raise SystemExit('EXTERNAL_RESEARCH_HOST_REQUIRED')
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--end', default=None)
    args = parser.parse_args()
    end = int(datetime.datetime.fromisoformat(args.end.replace('Z', '+00:00')).timestamp()) if args.end else int(time.time()) // 60 * 60
    output = pathlib.Path(args.output); output.mkdir(parents=True, exist_ok=True)
    # Frozen collection scope. Higher frames require enough causal context.
    scopes = {1: 30, 5: 60, 15: 120, 30: 120, 60: 180, 240: 365, 1440: 500}
    def one(item):
        tf, days = item
        resolution = {1:'1m',5:'5m',15:'15m',30:'30m',60:'1h',240:'4h',1440:'1d'}[tf]
        stop = end // (tf*60) * tf*60
        start = stop-days*86400; cursor=start; rows={}; requests=[]
        for page in range(100):
            if cursor >= stop: break
            upper=min(stop, cursor+4999*tf*60)
            url=f'https://futures.kraken.com/api/charts/v1/trade/PF_XBTUSD/{resolution}?from={cursor}&to={upper}&count=5000'
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(url, timeout=30) as response:
                        raw=response.read()
                    payload=json.loads(raw)
                    if not isinstance(payload.get('candles'),list): raise ValueError('CANDLE_RESPONSE_INVALID')
                    break
                except Exception:
                    if attempt==2: raise
            requests.append({'url':url,'sha256':hashlib.sha256(raw).hexdigest(),'fetched_at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
            batch=payload['candles']
            for c in batch:
                t=int(c['time'])
                if start*1000<=t and t+tf*60000<=stop*1000:
                    row={'start':t,'end':t+tf*60000,**{k:float(c[k]) for k in ['open','high','low','close','volume']}}
                    if t in rows and rows[t]!=row: raise ValueError('CONFLICTING_HISTORY')
                    rows[t]=row
            cursor=upper+tf*60
        data=sorted(rows.values(),key=lambda x:x['start'])
        gaps=[{'after':a['end'],'next':b['start']} for a,b in zip(data,data[1:]) if b['start']!=a['end']]
        encoded=json.dumps(data,separators=(',',':')).encode()
        (output/f'{tf}.json').write_bytes(encoded)
        result={'timeframe':tf,'bars':len(data),'first':data[0]['start'] if data else None,'last':data[-1]['end'] if data else None,'gaps':gaps,'sha256':hashlib.sha256(encoded).hexdigest(),'requests':requests}
        print(json.dumps({k:result[k] for k in ['timeframe','bars','first','last']}),flush=True)
        return str(tf),result
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        manifest=dict(pool.map(one,scopes.items()))
    record={'version':1,'source':'KRAKEN_PUBLIC_PF_XBTUSD_TRADE_CANDLES','end':end*1000,'real_trading':False,'historical_bbo':False,'frames':manifest}
    (output/'manifest.json').write_text(json.dumps(record,indent=2))

if __name__=='__main__': main()
