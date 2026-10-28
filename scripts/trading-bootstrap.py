"""Acquire ONLY official Kraken BTC/USD historical bars; never a live quote.

HTTP ranges avoid downloading every market. ZIP CRC and downloaded member SHA256
are checked; partial retrieval is not advertised as whole-archive verification.
"""
import io, json, zipfile, hashlib, pathlib, datetime, urllib.request, time, subprocess, re

class RemoteZIP(io.RawIOBase):
    def __init__(self, url):
        self.url, self.pos = url, 0
        headers=subprocess.check_output(['curl','-fsSI','--max-time','60',url]).decode()
        self.size=int(re.findall(r'(?im)^content-length: (\d+)',headers)[-1])
    def seekable(self): return True
    def seek(self, pos, whence=0):
        self.pos = pos if whence == 0 else self.pos+pos if whence == 1 else self.size+pos
        return self.pos
    def tell(self): return self.pos
    def read(self, n=-1):
        end = self.size-1 if n < 0 else min(self.size-1,self.pos+n-1)
        if end < self.pos: return b''
        req=urllib.request.Request(self.url,headers={'Range':f'bytes={self.pos}-{end}'})
        for attempt in range(3):
            try:
                response=subprocess.check_output(['curl','-fsS','--max-time','60','--range',f'{self.pos}-{end}','-D','-',self.url])
                header,data=response.split(b'\r\n\r\n',1)
                if b'content-range:' not in header.lower(): header,data=data.split(b'\r\n\r\n',1)
                if f'bytes {self.pos}-'.encode() not in header: raise ValueError('range response not verified')
                if len(data)!=end-self.pos+1: raise ValueError('truncated range')
                self.pos += len(data)
                return data
            except Exception:
                if attempt==2: raise
                time.sleep(1)

def main():
    bars, sources = {}, []
    for quarter in ['2026Q2','2026Q3']:
        url=f'https://assets.kraken.com/marketing/institutions/Kraken_OHLCVT_{quarter}.zip'
        with zipfile.ZipFile(RemoteZIP(url)) as z:
            matches=[n for n in z.namelist() if n.rsplit('/',1)[-1] in ['XBTUSD_240.csv','BTCUSD_240.csv']]
            if len(matches)!=1: raise ValueError(f'exact BTC/USD member missing: {matches}')
            name=matches[0]; raw=z.read(name) # zipfile verifies CRC
            for row in raw.decode().strip().splitlines():
                t,o,h,l,c,v,n=row.split(',')
                start=int(t)*1000
                b={'start':start,'end':start+14400000,'open':o,'high':h,'low':l,'close':c,'volume':v,'trades':int(n),'source':'KRAKEN_ARCHIVE'}
                if start in bars and bars[start]!=b: raise ValueError('conflicting archives')
                bars[start]=b
            sources.append({'url':url,'member':name,'sha256':hashlib.sha256(raw).hexdigest(),'crc32':z.getinfo(name).CRC,'bytes':len(raw)})
    series=sorted(bars.values(),key=lambda b:b['start'])
    if len(series)<1000 or any(b['start']!=a['end'] for a,b in zip(series,series[1:])):
        raise ValueError('warmup incomplete')
    out={'kind':'HISTORICAL_ONLY','exchange':'KRAKEN','instrument':'BTC/USD_SPOT','acquired_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sources':sources,'bars240':series}
    path=pathlib.Path('data/trading/bootstrap.json');path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(out,separators=(',',':'))+'\n')
    print(json.dumps({'historical_bars':len(series),'first':series[0]['start'],'last_end':series[-1]['end'],'sources':sources}))

if __name__=='__main__':main()
