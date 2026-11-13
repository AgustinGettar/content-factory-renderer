// The existing owner-private Sites dispatch protects every route. The AWS
// writer additionally needs a distinct runtime key; no browser mutation API.
const headers={'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length||b.length<32)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;};
async function limited(request,max){const reader=request.body?.getReader();if(!reader)throw Error('BODY_REQUIRED');let n=0;const chunks=[];while(true){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>max){await reader.cancel();throw Error('BODY_TOO_LARGE');}chunks.push(value);}const bytes=new Uint8Array(n);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length;}return bytes;}
const HISTORY_VERSION='secondary-history-page-1.0.0',HISTORY_MAX_BYTES=512*1024;
const HISTORY_KINDS=new Set(['SELECTED','FILLED','PARTIAL_FILL','PARTIAL_CLOSE','CLOSED','NOT_FILLED','ORDER_REMAINDER_CANCELLED','FUNDING_RECONCILED']);
const historyCursor=value=>typeof value==='string'&&/^(0|[1-9]\d{0,15})$/.test(value)&&Number.isSafeInteger(Number(value));
const stableHistory=value=>Array.isArray(value)?value.map(stableHistory):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableHistory(value[key])])):value;
const historyHash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(stableHistory(value)))))].map(x=>x.toString(16).padStart(2,'0')).join('');
const onlyKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const numeric=value=>value===null||typeof value==='string'&&value.length<=80&&value.trim()!==''&&Number.isFinite(Number(value));
const code=value=>value===null||typeof value==='string'&&/^[A-Za-z0-9_:.\/-]{1,160}$/.test(value);
const safeTime=value=>value===null||Number.isSafeInteger(value)&&value>=0;
const recordKeys=['event_id','source_cursor','id','type','at','created_at','ledger','realTrading','reason','amount_scope','accounted','manual','training_eligibility','pnl','fill_pnl','fees','gross','funding','price','qty','fee','entry','remaining_qty','cumulative_qty','requested_qty','amount','net_adjustment','net_after','fill_id','direction','pattern','quality','execution_state','order_state','timeframe','leverage','funding_complete','result_final','plan','profit_protection','evidence_flags'];
const moneyKeys=['pnl','fill_pnl','fees','gross','funding','price','qty','fee','entry','remaining_qty','cumulative_qty','requested_qty','amount','net_adjustment','net_after'];
function validHistoryRecord(r,now){
 if(!onlyKeys(r,recordKeys)||!historyCursor(r.source_cursor)||r.source_cursor==='0'||!HISTORY_KINDS.has(r.type)||r.ledger!=='FREQUENT_PAPER'||r.realTrading!==false||typeof r.accounted!=='boolean'||typeof r.manual!=='boolean'||typeof r.id!=='string'||r.id.length>160||typeof r.event_id!=='string'||r.event_id.length>160||!Number.isSafeInteger(r.at)||r.at<0||r.at>now+10000||typeof r.created_at!=='string'||!Number.isFinite(Date.parse(r.created_at))||Date.parse(r.created_at)>now+10000)return false;
 const scope=r.type==='CLOSED'?'OPERATION_TOTAL':r.type==='PARTIAL_CLOSE'?'EXECUTION_FRAGMENT':r.type==='FUNDING_RECONCILED'?'ACCOUNTING_ADJUSTMENT':['FILLED','PARTIAL_FILL'].includes(r.type)?'ENTRY_FRAGMENT':'ORDER_EVENT';
 if(r.amount_scope!==scope||r.accounted!==(scope!=='ORDER_EVENT')||!onlyKeys(r.training_eligibility,['status','reason'])||!['UNKNOWN','PENDING','EXCLUDED'].includes(r.training_eligibility.status)||!code(r.training_eligibility.reason))return false;
 if(moneyKeys.some(key=>r[key]!==undefined&&!numeric(r[key]))||['reason','fill_id','direction','pattern','quality','execution_state','order_state'].some(key=>r[key]!==undefined&&!code(r[key])))return false;
 if(r.timeframe!==null&&(!Number.isInteger(r.timeframe)||r.timeframe<=0||r.timeframe>10080)||r.leverage!==null&&(!Number.isFinite(r.leverage)||r.leverage<1||r.leverage>100)||['funding_complete','result_final'].some(key=>r[key]!==null&&typeof r[key]!=='boolean'))return false;
 const p=r.plan;if(!onlyKeys(p,['id','pattern','direction','entry_revision','movement_id','parent_id','timeframe','leg_index','entry','stop','target','holding_ms','sizing','versions']))return false;
 if(['id','pattern','direction','entry_revision','movement_id','parent_id'].some(key=>p[key]!==undefined&&!code(p[key]))||['entry','stop','target','holding_ms'].some(key=>p[key]!==undefined&&!numeric(p[key]))||p.timeframe!==null&&(!Number.isInteger(p.timeframe)||p.timeframe<=0)||p.leg_index!==null&&(!Number.isInteger(p.leg_index)||p.leg_index<0||p.leg_index>2))return false;
 if(!onlyKeys(p.sizing,['qty','exposure','initial_margin','risk','target_net','leverage','reserved'])||Object.values(p.sizing).some(value=>!numeric(value))||!onlyKeys(p.versions,['entry','execution','economic','exit'])||Object.values(p.versions).some(value=>!code(value)))return false;
 const t=r.profit_protection;if(t!==null){if(!onlyKeys(t,['state','exit_policy_version','activation_blocker','exit_reason','deadline_reason','peak_net','protected_net','required_activation_net','activation_net','basis_qty','remaining_qty','peak_net_per_unit','protected_net_per_unit','peak_at','floor_at','trailing_activated_at','effective_expires_at','exit_intent_at']))return false;
  for(const [key,value] of Object.entries(t))if(['state','exit_policy_version','activation_blocker','exit_reason','deadline_reason'].includes(key)?!code(value):key.endsWith('_at')?!safeTime(value):!numeric(value))return false;
 }
 return onlyKeys(r.evidence_flags,['entry_fills_observed','execution_receipt','liquidity_receipt','funding_receipt','data_gaps'])&&Object.values(r.evidence_flags).every(value=>typeof value==='boolean');
}
async function validateHistoryPage(d,now){
 if(!onlyKeys(d,['version','kind','mode','realTrading','ledger','cursor','previous_cursor','high_watermark','records','backfill_complete','generated_at','hash'])||d.version!==HISTORY_VERSION||!['PAGE','TIP'].includes(d.kind)||d.mode!=='PAPER'||d.realTrading!==false||d.ledger!=='FREQUENT_PAPER'||!historyCursor(d.cursor)||!historyCursor(d.high_watermark)||d.previous_cursor!==null&&(!historyCursor(d.previous_cursor)||d.previous_cursor==='0')||!Array.isArray(d.records)||d.records.length>40||d.kind==='PAGE'&&d.records.length!==40||typeof d.backfill_complete!=='boolean'||d.kind==='PAGE'&&d.backfill_complete||!Number.isSafeInteger(d.generated_at)||d.generated_at<0||d.generated_at>now+10000||typeof d.hash!=='string'||!/^[a-f0-9]{64}$/.test(d.hash))return false;
 const previous=Number(d.previous_cursor??0);if(Number(d.cursor)<previous||Number(d.high_watermark)<Number(d.cursor)||d.kind==='PAGE'&&d.high_watermark!==d.cursor)return false;
 if(d.records.some((r,i)=>!validHistoryRecord(r,now)||Number(r.source_cursor)<=previous||i>0&&Number(r.source_cursor)>=Number(d.records[i-1].source_cursor)))return false;
 if((d.records[0]?.source_cursor??d.previous_cursor??'0')!==d.cursor||new Set(d.records.map(r=>r.event_id)).size!==d.records.length)return false;
 const unsigned={...d};delete unsigned.hash;return equal(await historyHash(unsigned),d.hash);
}
const historyPageKey=cursor=>'trading/history/pages/'+cursor+'.json';
const historyReceipt=d=>json({ok:true,version:HISTORY_VERSION,kind:d.kind,cursor:d.cursor,hash:d.hash});
async function readHistory(request,env,now){
 if(request.method!=='GET')return json({error:'METHOD_NOT_ALLOWED'},405);
 if(request.headers.get('sec-fetch-site')==='cross-site')return json({error:'FORBIDDEN'},403);
 const u=new URL(request.url),requested=u.searchParams.get('cursor');if([...u.searchParams.keys()].some(key=>key!=='cursor')||requested!==null&&(!historyCursor(requested)||requested==='0'))return json({error:'INVALID_HISTORY_CURSOR'},400);
 const tipObject=await env.BUCKET.get('trading/history/tip.json'),tip=tipObject?await tipObject.json():null;
 const object=requested===null?tipObject:await env.BUCKET.get(historyPageKey(requested));
 if(!object)return requested===null?json({version:HISTORY_VERSION,records:[],previous_cursor:null,backfill_complete:false,generated_at:now,status:'ARCHIVE_PENDING'}):json({error:'HISTORY_CURSOR_NOT_FOUND'},404);
 const d=requested===null?tip:await object.json();return json({version:HISTORY_VERSION,records:d.records,previous_cursor:d.previous_cursor,backfill_complete:tip?.backfill_complete===true,generated_at:tip?.generated_at??d.generated_at,latest_complete_cursor:tip?.previous_cursor??null});
}
async function writeHistory(request,env,now){
 const body=await limited(request,HISTORY_MAX_BYTES),d=JSON.parse(new TextDecoder().decode(body));if(!await validateHistoryPage(d,now))return json({error:'INVALID_HISTORY_PAGE'},400);
 if(d.kind==='PAGE'){
  const key=historyPageKey(d.cursor),oldPageObject=await env.BUCKET.get(key),oldPage=oldPageObject?await oldPageObject.json():null;
  if(oldPage&&oldPage.hash!==d.hash)return json({error:'HISTORY_PAGE_IMMUTABLE'},409);
  const headObject=await env.BUCKET.get('trading/history/head.json'),head=headObject?await headObject.json():{cursor:'0'};
  if(oldPage&&Number(head.cursor)>=Number(d.cursor))return historyReceipt(d);
  if((d.previous_cursor??'0')!==head.cursor)return json({error:'HISTORY_CHAIN_CONFLICT'},409);
  if(!oldPageObject){const written=await env.BUCKET.put(key,body,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'},customMetadata:{cursor:d.cursor,sha256:d.hash}});if(!written)return json({error:'CONCURRENT_HISTORY_UPDATE'},409);}
  const stored=await env.BUCKET.put('trading/history/head.json',new TextEncoder().encode(JSON.stringify({cursor:d.cursor,hash:d.hash})),{onlyIf:headObject?{etagMatches:headObject.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});if(!stored)return json({error:'CONCURRENT_HISTORY_UPDATE'},409);
  return historyReceipt(d);
 }
 const headObject=await env.BUCKET.get('trading/history/head.json'),head=headObject?await headObject.json():{cursor:'0'};if((d.previous_cursor??'0')!==head.cursor)return json({error:'HISTORY_TIP_CHAIN_CONFLICT'},409);
 const oldObject=await env.BUCKET.get('trading/history/tip.json'),old=oldObject?await oldObject.json():null;
 if(old&&old.hash===d.hash)return historyReceipt(d);
 if(old&&(Number(d.cursor)<Number(old.cursor)||Number(d.high_watermark)<Number(old.high_watermark)||Number(d.previous_cursor??0)<Number(old.previous_cursor??0)||d.generated_at<old.generated_at))return json({error:'OLDER_HISTORY_TIP'},409);
 if(old&&d.cursor===old.cursor&&d.previous_cursor===old.previous_cursor&&JSON.stringify(stableHistory(d.records))!==JSON.stringify(stableHistory(old.records)))return json({error:'HISTORY_RECORD_IMMUTABLE'},409);
 const written=await env.BUCKET.put('trading/history/tip.json',body,{onlyIf:oldObject?{etagMatches:oldObject.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'},customMetadata:{cursor:d.cursor,sha256:d.hash}});if(!written)return json({error:'CONCURRENT_HISTORY_UPDATE'},409);return historyReceipt(d);
}
export async function awsMonitor(request,env,now=Date.now()){
 const u=new URL(request.url),path=u.pathname;
 if(!env.BUCKET)return json({error:'AWS_MONITOR_NOT_CONFIGURED'},503);
 if(path==='/api/monitor/history'){try{return await readHistory(request,env,now);}catch{return json({error:'HISTORY_STORAGE_UNAVAILABLE'},503);}}
 if(path==='/api/monitor'||path==='/api/monitor/live'){
  if(request.method!=='GET')return json({error:'METHOD_NOT_ALLOWED'},405);
  if(request.headers.get('sec-fetch-site')==='cross-site')return json({error:'FORBIDDEN'},403);
  const object=path==='/api/monitor/live'?(await env.BUCKET.get('trading/live.json')??await env.BUCKET.get('trading/snapshot.json')):await env.BUCKET.get('trading/snapshot.json');if(!object)return json({error:'AWS_MIGRATION_PENDING'},503);
  const d=await object.json();return json({...d,served_at:now});
 }
 if(!equal(request.headers.get('X-Trading-Ingest-Key'),env.LUMI_TRADING_PUBLISH_KEY))return json({error:'FORBIDDEN'},403);
 if(path==='/api/aws/ready'&&request.method==='GET')return json({ready:true,storage:'AWS_SQLITE',live_refresh_ms:2000});
 if(request.method!=='PUT')return json({error:'METHOD_NOT_ALLOWED'},405);
 try{
  if(path==='/api/aws/history')return await writeHistory(request,env,now);
  if(path==='/api/aws/snapshot'||path==='/api/aws/live'){
   const storageKey=path==='/api/aws/live'?'trading/live.json':'trading/snapshot.json';
   const body=await limited(request,path==='/api/aws/live'?1024*1024:6*1024*1024),d=JSON.parse(new TextDecoder().decode(body));
   if(d.schema!==1||!['AWS_SQLITE','AWS_MIGRATION_PENDING'].includes(d.storage)||!Number.isSafeInteger(d.revision)||!Number.isFinite(d.generated_at)||d.generated_at>now+10000||!Number.isFinite(Date.parse(d.updated_at))||Date.parse(d.updated_at)>now+10000)return json({error:'INVALID_SNAPSHOT'},400);
   const old=await env.BUCKET.get(storageKey),previous=old?await old.json():null;
   if(previous&&(d.revision<previous.revision||d.generated_at<previous.generated_at||previous.storage==='AWS_SQLITE'&&d.storage==='AWS_MIGRATION_PENDING'))return json({error:'OLDER_SNAPSHOT'},409);
   const put=await env.BUCKET.put(storageKey,body,{onlyIf:old?{etagMatches:old.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'},customMetadata:{revision:String(d.revision)}});
   if(!put)return json({error:'CONCURRENT_UPDATE'},409);return json({ok:true,revision:d.revision});
  }
  if(path==='/api/aws/backup'){
   const slot=u.searchParams.get('slot'),iv=request.headers.get('X-Backup-IV'),tag=request.headers.get('X-Backup-Tag'),sha=request.headers.get('X-Backup-SHA256'),revision=request.headers.get('X-Backup-Revision');
   if(!/^[0-2]$/.test(slot??'')||!/^[a-f0-9]{24}$/.test(iv??'')||!/^[a-f0-9]{32}$/.test(tag??'')||!/^[a-f0-9]{64}$/.test(sha??'')||!/^\d+$/.test(revision??''))return json({error:'INVALID_BACKUP'},400);
   const body=await limited(request,16*1024*1024),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',body))].map(x=>x.toString(16).padStart(2,'0')).join('');
   if(!equal(hash,sha))return json({error:'BACKUP_CHECKSUM'},400);
   await env.BUCKET.put('trading/backup-'+slot+'.enc',body,{customMetadata:{iv,tag,sha,revision,created_at:new Date(now).toISOString(),format:'AES-256-GCM+GZIP+SQLITE-v1'}});
   return json({ok:true,sha});
  }
  return json({error:'NOT_FOUND'},404);
 }catch{return json({error:'INVALID_BODY_OR_STORAGE'},400);}
}
const candlesCache=new Map();
export async function marketCandles(request,fetchImpl=fetch,now=Date.now()){
 if(request.method!=='GET')return json({error:'METHOD_NOT_ALLOWED'},405);
 if(request.headers.get('sec-fetch-site')==='cross-site')return json({error:'FORBIDDEN'},403);
 const tf=Number(new URL(request.url).searchParams.get('interval'));if(![1,15,60,240].includes(tf))return json({error:'INVALID_INTERVAL'},400);
 const cached=candlesCache.get(tf);if(cached&&now-cached.generated_at<15000)return json(cached);
 try{
  const r=await fetchImpl('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval='+tf,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error();
  const d=await r.json(),rows=d.result?.XXBTZUSD;if(d.error?.length||!Array.isArray(rows)||rows.length<2)throw Error();
  const candles=rows.map((b,i)=>({start:Number(b[0])*1000,end:(Number(b[0])+tf*60)*1000,open:Number(b[1]),high:Number(b[2]),low:Number(b[3]),close:Number(b[4]),volume:Number(b[6]),closed:i<rows.length-1}));
  if(candles.some(b=>![b.start,b.open,b.high,b.low,b.close].every(Number.isFinite)||b.low<=0||b.high<b.low||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)))throw Error();
  const value={source:'KRAKEN_REST_OHLC',symbol:'BTC/USD',interval:tf,generated_at:now,candles};candlesCache.set(tf,value);return json(value);
 }catch{return json({error:'MARKET_UNAVAILABLE'},503);}
}
