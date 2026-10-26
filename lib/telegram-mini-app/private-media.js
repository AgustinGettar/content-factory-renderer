import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
// Descriptors are verified at ingestion/derivation. Every caller must recheck
// session, ownership, ticket (where applicable), and private bucket before this.
export async function sendPrivateMedia(req,res,storage,a){
 const size=a.size,etag='"'+a.sha256+'"';let range=null;
 const raw=req.headers['if-range']&&req.headers['if-range']!==etag?null:req.headers.range;
 if(raw){const m=/^bytes=(\d*)-(\d*)$/.exec(raw);if(m&&(m[1]||m[2])){const start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2])),end=m[1]?(m[2]?Math.min(size-1,Number(m[2])):size-1):size-1;if(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<=end&&start<size)range={start,end};}if(!range)return res.status(416).set('Content-Range','bytes */'+size).end();}
 res.type(a.mime).set({'Accept-Ranges':'bytes','Content-Length':String(range?range.end-range.start+1:size),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':a.sha256,ETag:etag});
 if(range)res.status(206).set('Content-Range',`bytes ${range.start}-${range.end}/${size}`);
 if(req.method==='HEAD')return res.end();
 if(!storage.openRead){ // Isolated stores without network; production always supplies openRead.
  const bytes=await storage.download(a.bucket,a.path);if(!bytes||bytes.length!==size||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error('MEDIA_INTEGRITY');return res.send(range?bytes.subarray(range.start,range.end+1):bytes);
 }
 const controller=new AbortController(),closed=()=>controller.abort();res.once('close',closed);
 try{const upstream=await storage.openRead(a.bucket,a.path,{range:range?`bytes=${range.start}-${range.end}`:undefined,signal:controller.signal});
  const expected=range?range.end-range.start+1:size,mime=upstream.headers.get('content-type')?.split(';')[0];
  if(upstream.status!==(range?206:200)||Number(upstream.headers.get('content-length'))!==expected||mime&&mime!==a.mime&&mime!=='application/octet-stream'||range&&upstream.headers.get('content-range')!==`bytes ${range.start}-${range.end}/${size}`){await upstream.body?.cancel();throw Error('MEDIA_UPSTREAM_RANGE_INVALID');}
  await pipeline(Readable.fromWeb(upstream.body),res);
 }catch(e){if(!res.headersSent)for(const h of ['Content-Length','Content-Range','Content-Type','ETag','X-Content-SHA256'])res.removeHeader(h);throw e;}finally{res.removeListener('close',closed);}
}
export function processDiagnostic(error,timeoutMs,started){
 const stderr=typeof error.stderr==='string'?error.stderr:Buffer.isBuffer(error.stderr)?error.stderr.toString():'';
 // No command arguments, source paths, URLs, owner IDs or credentials in receipts.
 const tail=stderr.split('\n').filter(l=>/error|invalid|failed|killed|memory|timed out/i.test(l)).slice(-8).map(l=>l.replace(/https?:\/\/\S+/g,'[URL]').replace(/(?:\/[^\s:]+)+/g,'[path]').replace(/(token|key|secret|authorization)[=: ]+\S+/ig,'$1=[redacted]').slice(0,300));
 return {exit_code:Number.isInteger(error.code)?error.code:null,signal:typeof error.signal==='string'?error.signal:null,killed:error.killed===true,timeout_ms:timeoutMs,elapsed_ms:Math.round(performance.now()-started),stderr_tail:tail,process_rss_bytes:process.memoryUsage().rss,detail:tail.length?'PROCESS_RECEIPT':'NO_STDERR_DETAIL'};
}
