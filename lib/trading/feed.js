import {EventEmitter} from 'node:events';
import {D,hash,validBar,M15,H1,H4,checkSeries,POLICY} from './core.js';
export const REST='https://api.kraken.com/0/public/';
export async function publicREST(method,params={},fetchImpl=fetch){
  if(!['AssetPairs','OHLC','Time','SystemStatus','Trades'].includes(method))throw Error('PUBLIC_MARKET_METHOD_ONLY');
  const r=await fetchImpl(REST+method+'?'+new URLSearchParams(params),{signal:AbortSignal.timeout(8000),cache:'no-store'});
  if(!r.ok)throw Error('KRAKEN_REST_HTTP_'+r.status);const p=await r.json();if(p.error?.length||!p.result)throw Error('KRAKEN_REST_REJECTED');return p.result;
}
export function restBars(result,minutes,receivedAt,{includeOpen=false}={}){
  const rows=result.XXBTZUSD;if(!Array.isArray(rows))throw Error('WRONG_MARKET');
  // The last Kraken OHLC item is ALWAYS uncommitted, regardless of since.
  const selected=includeOpen?rows:rows.slice(0,-1);
  return selected.map(r=>{const start=Number(r[0])*1000,b={start,end:start+minutes*60000,open:D(r[1]).toString(),high:D(r[2]).toString(),low:D(r[3]).toString(),close:D(r[4]).toString(),volume:D(r[6]).toString(),trades:Number(r[7]),available_at:receivedAt,source:'KRAKEN_REST_OHLC'};if(!validBar(b)||!includeOpen&&b.end>receivedAt)throw Error('INVALID_OR_FUTURE_BAR');return b;});
}
export function mergeBars(old,fresh){const m=new Map(old.map(b=>[b.start,b]));const corrections=[];for(const b of fresh){const p=m.get(b.start),shape=x=>[x.open,x.high,x.low,x.close].map(v=>D(v).toString()).concat(D(x.volume).toFixed(8),x.trades);if(p&&hash(shape(p))!==hash(shape(b)))corrections.push({before:p,after:b});m.set(b.start,p&&hash(shape(p))===hash(shape(b))?p:b);}return {bars:[...m.values()].sort((a,b)=>a.start-b.start),corrections};}
export class KrakenFeed extends EventEmitter {
  constructor({seed=[],fetchImpl=fetch,WebSocketImpl=globalThis.WebSocket,now=()=>Date.now()}={}){super();Object.assign(this,{fetchImpl,WebSocketImpl,now});this.series={'15':[],'60':[],'240':seed.map(b=>({...b,available_at:now()}))};this.state={connected:false,reconciled:false,system:'unknown',quote:null,trade:null,clock:null,maintenanceBlocked:false};this.counters={quotes:0,trades:0,duplicates:0,outOfOrder:0,reconnects:0};this.ids=new Map();this.minutes=new Map();this.requests=new Map();this.req=1;this.stopped=false;this.busy=false;this.gapStart=now();}
  snapshot(){return {...structuredClone(this.state),counters:{...this.counters},metadata:this.metadata};}
  incident(reason,extra={}){this.emit('incident',{type:'DATA_INCIDENT',reason,at:this.now(),...extra});}
  async bootstrap(){
    const pairs=await publicREST('AssetPairs',{pair:'XBTUSD'},this.fetchImpl),p=pairs.XXBTZUSD;
    if(p?.wsname!=='XBT/USD'||p.base!=='XXBT'||p.quote!=='ZUSD'||p.lot_multiplier!==1||!p.tick_size||!p.ordermin||!p.costmin)throw Error('KRAKEN_INSTRUMENT_MISMATCH');
    this.metadata={...p,checked_at:this.now(),symbol:'BTC/USD',kind:'SPOT',hash:hash(p)};
    await this.reconcile();
  }
  async reconcile(){
    if(this.busy)return false;this.busy=true;
    try{
      for(const tf of [15,60,240]){
        const result=await publicREST('OHLC',{pair:'XBTUSD',interval:String(tf)},this.fetchImpl),bars=restBars(result,tf,this.now());
        if(tf===15)for(const b of bars.filter(b=>b.start>=Math.ceil(this.connectedAt/60000)*60000)){
          const parts=Array.from({length:15},(_,i)=>this.minutes.get(b.start+i*60000));
          if(parts.some(x=>!x))continue;
          const rebuilt={...b,open:parts[0].open,high:Math.max(...parts.map(x=>+x.high)),low:Math.min(...parts.map(x=>+x.low)),close:parts.at(-1).close,volume:parts.reduce((s,x)=>s.plus(x.volume),D(0)).toString(),trades:parts.reduce((s,x)=>s+x.trades,0),source:'WS_RECONSTRUCTED'};
          const comparison=mergeBars([rebuilt],[b]);
          if(comparison.corrections.length)this.incident('WS_CANDLE_REPAIRED_FROM_REST',{tf,before:rebuilt,after:b});
          this.emit('reconciliation',{type:'CANDLE_RECONCILED',at:this.now(),start:b.start,source_hash:hash(rebuilt),canonical_hash:hash(b),matched:comparison.corrections.length===0});
        }
        const merged=mergeBars(this.series[tf],bars);this.series[tf]=merged.bars.slice(-(tf===240?20000:2000));
        if(merged.corrections.length)this.incident('BAR_CORRECTION',{tf,corrections:merged.corrections});
        const min=tf===240?POLICY.warmup240:tf===60?250:200,error=checkSeries(this.series[tf],tf*60000,min);if(error)throw Error(error+'_'+tf);
      }
      this.historyReady=true;this.maybeReady();return true;
    }catch(e){this.state.reconciled=false;this.incident(/^[A-Z0-9_]+$/.test(e.message)?e.message:'RECONCILIATION_FAILED');return false;}finally{this.busy=false;}
  }
  maybeReady(){const s=this.state;if(s.connected&&this.historyReady&&s.quote?.received_at>=this.connectedAt&&s.trade?.received_at>=this.connectedAt&&s.clock&&this.acks?.ticker&&this.acks?.trade&&!s.reconciled){s.reconciled=true;this.emit('ready',{at:this.now(),gapStart:this.gapStart});}}
  connect(){
    if(this.stopped)return;this.historyReady=false;this.acks={};this.state.reconciled=false;this.connectedAt=this.now();
    const ws=this.ws=new this.WebSocketImpl('wss://ws.kraken.com/v2');
    ws.addEventListener('open',()=>{this.state.connected=true;this.lastMessage=this.now();for(const channel of ['ticker','trade'])this.request({method:'subscribe',params:{channel,symbol:['BTC/USD'],snapshot:true,...(channel==='ticker'?{event_trigger:'bbo'}:{})}});void this.bootstrap().catch(()=>this.incident('BOOTSTRAP_FAILED'));});
    ws.addEventListener('message',event=>{try{this.consume(JSON.parse(event.data.toString()),this.now());}catch{this.incident('INVALID_WS_MESSAGE');this.state.reconciled=false;ws.close();}});
    ws.addEventListener('error',()=>this.incident('WS_ERROR'));
    ws.addEventListener('close',()=>{if(this.ws!==ws)return;this.gapStart=this.lastMessage||this.now();this.state.connected=false;this.state.reconciled=false;this.state.quote=null;this.counters.reconnects++;this.incident('DISCONNECTED');this.emit('disconnect',{at:this.gapStart});if(!this.stopped)this.reconnectTimer=setTimeout(()=>this.connect(),Math.min(30000,1000*2**Math.min(this.counters.reconnects,4))+Math.random()*1000);});
  }
  request(body){const req_id=this.req++;this.requests.set(req_id,this.now());this.ws?.send(JSON.stringify({...body,req_id}));}
  consume(msg,receivedAt){
    this.lastMessage=receivedAt;
    if(msg.req_id&&this.requests.has(msg.req_id)&&msg.time_in&&msg.time_out){const sent=this.requests.get(msg.req_id);this.requests.delete(msg.req_id);const lo=Date.parse(msg.time_out)-receivedAt,hi=Date.parse(msg.time_in)-sent;if(lo<=hi+5)this.state.clock={checked_at:receivedAt,error_ms:Math.max(Math.abs(lo),Math.abs(hi)),rtt_ms:receivedAt-sent,offset_interval:[lo,hi]};}
    if(msg.method==='subscribe'){if(msg.success!==true){this.incident('SUBSCRIPTION_REJECTED');this.ws?.close();return;}if(msg.result?.symbol==='BTC/USD')this.acks[msg.result.channel]=true;this.maybeReady();return;}
    if(msg.channel==='status'){const s=msg.data?.[0];this.state.system=s?.system||'unknown';this.state.maintenance=s?.upcoming_maintenance||[];this.checkMaintenance(receivedAt);return;}
    if(msg.channel==='heartbeat')return; // MUST NOT change any price timestamp.
    if(msg.channel==='ticker')for(const row of msg.data||[]){
      if(row.symbol!=='BTC/USD')throw Error('WRONG_SYMBOL');const at=Date.parse(row.timestamp);if(!Number.isFinite(at)||at>receivedAt+1000)throw Error('QUOTE_TIMESTAMP');
      if(this.state.quote&&at<this.state.quote.event_at){this.counters.outOfOrder++;this.incident('OUT_OF_ORDER_QUOTE');continue;}
      if(!(row.bid>0&&row.ask>=row.bid&&row.bid_qty>=0&&row.ask_qty>=0))throw Error('QUOTE_INVALID');
      this.state.quote={bid:String(row.bid),ask:String(row.ask),bid_qty:String(row.bid_qty),ask_qty:String(row.ask_qty),event_at:at,received_at:receivedAt,source:'KRAKEN_WS_V2_BBO',message_type:msg.type};this.counters.quotes++;this.emit('quote',this.state.quote);
    }
    if(msg.channel==='trade')for(const row of [...(msg.data||[])].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)||a.trade_id-b.trade_id)){
      if(row.symbol!=='BTC/USD'||!Number.isSafeInteger(row.trade_id)||!(row.price>0&&row.qty>0))throw Error('TRADE_INVALID');
      const key=String(row.trade_id),digest=hash(row);if(this.ids.has(key)){if(this.ids.get(key)!==digest)throw Error('CONFLICTING_TRADE');this.counters.duplicates++;continue;}this.ids.set(key,digest);if(this.ids.size>20000)this.ids.delete(this.ids.keys().next().value);
      const at=Date.parse(row.timestamp);if(!Number.isFinite(at)||at>receivedAt+1000)throw Error('TRADE_TIMESTAMP');
      const trade={id:key,price:String(row.price),qty:String(row.qty),event_at:at,received_at:receivedAt,source:'KRAKEN_WS_V2_TRADE',message_type:msg.type};
      // trade_id is documented per-book identity. Do not invent ticker sequence
      // numbers, nor assume a missing trade_id proves a missing ticker update.
      if(this.state.trade&&at<this.state.trade.event_at){this.counters.outOfOrder++;this.incident('OUT_OF_ORDER_TRADE');this.state.reconciled=false;void this.reconcile();continue;}
      this.aggregate(trade);this.state.trade=trade;this.counters.trades++;this.emit('trade',trade);
    }
    this.maybeReady();
  }
  aggregate(t){const start=Math.floor(t.event_at/60000)*60000;let b=this.minutes.get(start);if(!b){b={start,end:start+60000,open:t.price,high:t.price,low:t.price,close:t.price,volume:'0',trades:0,source:'WS_RECONSTRUCTED',available_at:t.received_at};this.minutes.set(start,b);}b.high=D(b.high).gte(t.price)?b.high:t.price;b.low=D(b.low).lte(t.price)?b.low:t.price;b.close=t.price;b.volume=D(b.volume).plus(t.qty).toString();b.trades++;b.available_at=t.received_at;while(this.minutes.size>120)this.minutes.delete(this.minutes.keys().next().value);}
  checkMaintenance(now){this.state.maintenanceBlocked=(this.state.maintenance||[]).some(m=>(m.affected_services||[]).some(x=>x.startsWith('spot'))&&Date.parse(m.cancel_before_utc||m.expected_start_utc)<=now&&now<Date.parse(m.expected_end_utc));}
  async maintain(){
    if(this.stopped)return;this.checkMaintenance(this.now());
    for(const [id,at] of this.requests)if(this.now()-at>60000)this.requests.delete(id);
    if(this.state.connected&&this.now()-this.lastMessage>15000){this.incident('HEARTBEAT_TIMEOUT');this.ws.close();return;}
    if(this.ws?.readyState===1)this.request({method:'ping'});
    if(this.state.connected&&!this.busy){
      if(!this.metadata||this.now()-this.metadata.checked_at>86400000)await this.bootstrap();
      else if(!this.state.reconciled)await this.reconcile();
    }
  }
  start(){this.connect();this.timer=setInterval(()=>{void this.maintain().catch(()=>this.incident('MAINTENANCE_RECOVERY_FAILED'));},30000);return this;}
  stop(){this.stopped=true;clearInterval(this.timer);clearTimeout(this.reconnectTimer);this.ws?.close();}
}
