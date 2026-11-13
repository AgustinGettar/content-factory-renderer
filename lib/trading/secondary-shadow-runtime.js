// Optional secondary PAPER observer. The operational thread never evaluates a
// variant, reconstructs the book, opens shadow SQLite, or awaits its writer.
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from './core.js';
import {HORIZON_SHADOW_VERSION} from './secondary-horizon-shadow.js';
import {ShadowObservationClient} from './shadow-observation-client.js';
const select=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,structuredClone(o[k])]));
const POSITION=['qty','entry','entry_fee','accrued_funding','entered_at','expires_at','initial_qty','closed_qty','remaining_risk','realized','exit_intent','quant_management','profit_protection','execution_buffer','quality','scale_out','last_funding_at','funding_pending','closed_funding_pending','target_net','initial_margin','total_entry','funding_reserved','risk_execution','management'];
const PLAN=['id','instrument','execution_model','execution_contract','exit_policy','timeframe','direction','stop','target','sizing','movement_id','entry','hash','signal_key','version','entry_revision','pattern','confirmed_at','decision_at','expires_at','holding_ms','quant_contract','active_contract','economic_policy','timeframe_contract','entry_context','limit','fill_model','order','capital_contract'];
const EVENT=['type','id','fill_id','at','entered_at','entry','price','qty','pnl','fees','fee','gross','funding','fill_pnl','fill_exit_fee','fill_funding','reason','direction','timeframe','remaining_qty','cumulative_qty','requested_qty','execution_receipt','decision_evidence','execution_comparison','liquidity_receipt','funding_receipt','exit_quote','entry_fills','entry_execution_costs','result_final','funding_complete','exit_intent','execution_state','amount_scope','quote','raw_quote_price','observed_spread_usd_per_btc','fill_exit_slippage_cost','fill_exit_spread_cost_vs_mid','costs_embedded_in_prices','exit_slippage_cost','exit_spread_cost_vs_mid','entry_slippage_cost','entry_spread_cost_vs_mid','slippage_cost','spread_cost_vs_mid','execution_side','evidence_id','evidence_at','fill_model','amount','net_adjustment','net_after','position_open','remaining_intervals','result_quality','decision_supersession','request','ledger','realTrading'];
const ECONOMIC=new Set(['SELECTED','FILLED','PARTIAL_FILL','PARTIAL_CLOSE','CLOSED','FUNDING_RECONCILED','SECONDARY_EXIT_SELECTED','SECONDARY_EXIT_PRIORITY_UPDATED','ACTIVE_SCALE_OUT_SELECTED','ACTIVE_SCALE_OUT_SETTLED','ORDER_REMAINDER_CANCELLED','NOT_FILLED']);
const positionView=p=>({...select(p,POSITION),plan:select(p.plan,PLAN)});
const liquidity=b=>select(b.x.liquidity??{},['quote_at','quote_used','trade_floor']);
export function configureExitShadow(runtime,env,{client:injected=null}={}){
 const flag=env.LUMI_TRADING_SECONDARY_EXIT_SHADOW;
 if(!flag||flag==='OFF')return false;
 if(flag!==HORIZON_SHADOW_VERSION||env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('EXIT_SHADOW_EXPLICIT_SECONDARY_PAPER_ONLY');
 const operationalPath=env.LUMI_TRADING_DB_PATH??runtime.engine.store?.path;
 const client=injected??runtime.shadowClient??new ShadowObservationClient({path:env.LUMI_TRADING_SHADOW_DB_PATH??(operationalPath?join(dirname(operationalPath),'shadow-observations.sqlite'):null),operationalPath});
 runtime.shadowClient=client;const broker=runtime.broker,stream=randomUUID();let sequence=0;
 const seen=new Map(),status=reason=>{runtime.shadowStatus={state:'DEGRADED',reason};broker.shadowStatus='DEGRADED';};
 const send=(kind,key,payload,at)=>{
  // This cache is admission-only, not a checkpoint. The client retains accepted
  // inputs until durable ACK and the shadow store deduplicates after recovery.
  // A replayed quote can be consumed with a different remaining quantity or
  // liquidity state after recovery. Preserve that distinct input; the durable
  // position cursor still suppresses a second variant snapshot for that quote.
  const id=hash(['shadow-input-v2',kind,key,...(['DECISION','QUOTE'].includes(kind)?[hash(payload)]:[])]);if(seen.has(id))return true;
  try{const accepted=client.offer({id,kind,at,received_at:at,stream_id:stream,source_seq:++sequence,payload});
   if(!accepted){status('SHADOW_INPUT_NOT_ACCEPTED');return false;}
   seen.set(id,true);if(seen.size>2048)seen.delete(seen.keys().next().value);return true;
  }catch{status('SHADOW_INPUT_ERROR');return false;}
 };
 runtime.publicFlow={get active(){return client.ended!==true&&client.paused!==true;},ingest:(message,at)=>client.flow(message,at),disconnect:(reason,at=runtime.now?.()??Date.now())=>client.disconnect(reason,at),get resync_required(){return client.ended!==true&&client.paused!==true&&client.status.resync_required===true;}};
 const contextSeen=new Map();
 const captureContexts=now=>{
  // Closed origin candles keep arriving after the real position closes. Keep
  // each changed causal context once, separately from the dense price path.
  for(const timeframe of [1,5,15,60,240]){
   const rows=runtime.series[timeframe];if(!Array.isArray(rows)||!rows.length)continue;
   const bars=rows.filter(b=>Number.isSafeInteger(b.end)&&b.end<=now&&Number.isSafeInteger(b.received_at??b.available_at)&&(b.received_at??b.available_at)<=now).slice(-20);
   if(!bars.length)continue;
   const digest=hash(bars),content=hash(bars.map(({received_at,available_at,...values})=>values));
   if(contextSeen.get(timeframe)===content)continue;
   if(send('CONTEXT',[timeframe,digest,now],{timeframe,bars:structuredClone(bars),source_hash:digest,source:'RUNTIME_CLOSED_ORIGIN_CANDLES'},now))contextSeen.set(timeframe,content);
  }
 };
 broker.prepareExitShadow=(p,q,v,now)=>{
  if(p.plan.instrument!=='PAPER:KRAKEN_FUTURES:PF_XBTUSD'||p.plan.execution_contract?.realTrading!==false)return null;
  // Small predecision projection only. Derived policy/book work runs in worker.
  const position=positionView(p),series={[p.plan.timeframe]:(runtime.series[p.plan.timeframe]??[]).slice(-20).map(b=>({...b}))};
  const payload={position,quote:structuredClone(q),valuation:structuredClone(v),series,availableQty:broker.quoteAvailable(q,v.side,p.plan.execution_contract.participation).toString(),now};
  return controlReason=>send('DECISION',[p.plan.id,q.event_at,now],{...payload,controlReason:controlReason??null},now);
 };
 broker.observeShadowClosed=(p,now)=>send('CLOSED',[p.plan.id,now],{id:p.plan.id,timeframe:p.plan.timeframe,direction:p.plan.direction,closed_at:now,net_usd:p.realized?.net??null,quantity_btc:p.closed_qty,source_receipt_missing:true,event:{type:'CLOSED',id:p.plan.id,at:now,entered_at:p.entered_at??null,timeframe:p.plan.timeframe,direction:p.plan.direction,ledger:'FREQUENT_PAPER',realTrading:false,source_receipt_missing:true}},now);
 runtime.observePostExitShadow=(q,now)=>q?send('QUOTE',['horizon',q.event_at,now],{quote:structuredClone(q),trade:null,rates:null,consumed_by_simulator:false,source:'HORIZON_CLOCK'},now):send('HEARTBEAT',now,{},now);
 runtime.observeOpportunityShadow=(decisions,{cutoff,now,timeframe})=>{
  // Full candidate identity and rejection, bounded explicitly. Never a veto.
  if(decisions.length>64){client.disconnect('OPPORTUNITY_INVENTORY_LIMIT',now);status('OPPORTUNITY_INVENTORY_LIMIT');return false;}
  const rows=decisions.map(d=>({pattern:d.pattern,reason:d.reason,plan:d.plan?{...select(d.plan,PLAN),economics:select(d.plan.economics??{},['netRR'])}:null}));
  return send('OPPORTUNITY',[timeframe,cutoff],{decisions:rows,cutoff,now,timeframe},now);
 };
 // Existing economic event callback runs first, with its original exceptions.
 // Observation never enters TradingEngine.events/notices or the primary DB.
 const originalEvent=broker.shadowOriginalEvent??broker.event;broker.shadowOriginalEvent=originalEvent;
 broker.event=e=>{
  const result=originalEvent(e);
  if(ECONOMIC.has(e.type)&&e.ledger==='FREQUENT_PAPER'&&e.realTrading!==true){try{
   const event={...select(e,EVENT),operational_commit_verified:false};if(e.plan)event.plan=structuredClone(e.plan);
   if(e.type==='CLOSED')send('CLOSED',[e.id,e.at],{id:e.id,timeframe:e.timeframe,direction:e.direction,closed_at:e.at,net_usd:e.pnl,quantity_btc:e.qty,event},e.at);
   else send('ECONOMIC',[e.type,e.id,e.fill_id??null,e.at,e.cumulative_qty??null],{event},e.at);
  }catch{status('ECONOMIC_OBSERVATION_ERROR');}}
  return result;
 };
 const originalMarket=broker.shadowOriginalMarket??broker.market.bind(broker);broker.shadowOriginalMarket=originalMarket;
 broker.market=(q,t,rates,now)=>{
  // Capture reference values without any storage or book work. Never swallow a
  // real broker exception, even when the observational side also fails.
  let before;try{before=liquidity(broker);}catch{status('LIQUIDITY_CAPTURE_ERROR');}
  try{return originalMarket(q,t,rates,now);}finally{try{
   captureContexts(now);
   const keys=Object.keys(rates??{});if(keys.length>96){client.disconnect('FUNDING_INPUT_LIMIT',now);status('FUNDING_INPUT_LIMIT');}
   else send('QUOTE',['consumed',q?.event_at??null,t?.id??null,now,hash(rates??{})],{quote:q?structuredClone(q):null,trade:t?structuredClone(t):null,rates:structuredClone(rates??{}),funding_available_at:now,consumed_by_simulator:true,liquidity_before:before,liquidity_after:liquidity(broker)},now);
  }catch{status('MARKET_CAPTURE_ERROR');}}
 };
 const active=Object.values(broker.a.positions),pending=Object.values(broker.a.pendingOrders);
 const now=runtime.now?.()??broker.now();
 if(active.length+pending.length<=64)send('BOOT',stream,{capture_version:'secondary-shadow-capture-2',active_positions:active.map(p=>({...positionView(p),plan:structuredClone(p.plan)})),pending_orders:pending.map(p=>({plan:select(p.plan,PLAN),...select(p,['remaining_qty','filled_qty','placed_at'])})),baseline_secondary:select(broker.a,['cash','equity','net','fees','closed','wins','losses']),complete_position_history:false},now);
 else{client.disconnect('BOOT_POSITION_LIMIT',now);status('BOOT_POSITION_LIMIT');}
 runtime.shadowStatus??={state:'STARTING',reason:null};return true;
}
