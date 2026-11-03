// One operational secondary PAPER ledger. No private exchange endpoints or real orders.
import {MultiPatternPaper} from './multi-pattern-paper.js';
import {getProfitPolicy,validateProfitContracts,isEarlyProfitContract} from './secondary-profit-policy.js';
import {evaluateEntryEconomics,evaluateEntryContext} from './secondary-entry-economics.js';
import {initializeProfitProtection,evaluateProfitProtection,scaleProfitProtection,markProfitExitPending,markProfitClosed,validateProfitProtection} from './secondary-profit-protection.js';
import {D,hash} from './core.js';
import {captureSecondaryExitAdvisory} from './secondary-exit-advisory.js';
import {RISK_EXECUTION_VERSION,isRiskContract,getRiskBudgetPolicy,validateRiskBudgetState,validateRiskContract,validateRiskRecovery,revalidatePyramidFill,revalidateRiskSelection,recordRiskSelection,riskFillQuantity,riskUnitLoss,marginSurrogate} from './secondary-risk-budget.js';
import {syncPortfolio} from './portfolio.js';
import {isExploration,getExplorationPolicy,EXPLORATION_EXECUTION_VERSION} from './secondary-exploration.js';
import {getCapitalAllocationPolicy,hasFiniteCapitalAllocation,getAllocationContract,validateCapitalAllocationContract,capitalAllocationFreeCash,capitalUnitReserve,CAPITAL_TOPUP_REASON} from './secondary-capital-allocation.js';
import {SECONDARY_VERSION,SECONDARY_MODEL,SECONDARY_PROTOCOL,isSecondary,secondaryFresh,secondaryEstimate} from './secondary-futures-math.js';
export {SECONDARY_VERSION,SECONDARY_MODEL,SECONDARY_PROTOCOL,isSecondary,secondaryFresh,secondaryEstimate} from './secondary-futures-math.js';
const P=SECONDARY_PROTOCOL,values=o=>Object.values(o??{}),n=x=>Number(x);
const round=(x,tick,up=false)=>D(x).div(tick)[up?'ceil':'floor']().mul(tick).toNumber();
const mean=x=>x.reduce((a,b)=>a+b,0)/x.length;
const ema=(b,k)=>{let v=mean(b.slice(0,k).map(x=>n(x.close)));for(const x of b.slice(k))v+=(n(x.close)-v)*2/(k+1);return v;};
const atr=b=>mean(b.slice(-14).map((x,i)=>{const c=n(b[b.length-15+i].close);return Math.max(n(x.high)-n(x.low),Math.abs(n(x.high)-c),Math.abs(n(x.low)-c));}));
export function secondaryEconomics(entry,stop,target,direction,rate,contract=null,holdingMs=contract?.holdingMs??P.holdingMs){
 const sign=direction==='LONG'?1:-1,slippage=contract?.slippage??P.slippage,entryFee=contract?.mode==='TAKER_IOC'?contract.takerFee:contract?.makerFee??P.makerFee,exitFee=contract?.takerFee??P.takerFee,exit=x=>D(x).mul(D(1).minus(D(slippage).mul(sign))),funding=D(rate).abs().mul(holdingMs/3600000),pnl=x=>exit(x).minus(entry).mul(sign).minus(D(entry).mul(entryFee)).minus(exit(x).mul(exitFee)).minus(funding),loss=pnl(stop).negated(),gain=pnl(target);
 return {loss:loss.toNumber(),gain:gain.toNumber(),netRR:loss.gt(0)?gain.div(loss).toNumber():null,fundingAllowance:funding.toNumber()};
}
export function secondaryCandidates(series,q,meta,cutoff,now,rate){
 const reject=reason=>P.patterns.map(pattern=>({pattern,reason}));
 if(!secondaryFresh(q,now))return reject('FUTURES_DATA_NOT_FRESH');
 if(!Number.isFinite(rate))return reject('FUNDING_NOT_AVAILABLE');
 const b=(series[5]??[]).filter(x=>x.end<=cutoff).slice(-256),c=(series[15]??[]).filter(x=>x.end<=cutoff).slice(-256);
 if(![b,c].every(x=>x.length>=64&&x.every((v,i)=>!i||v.start===x[i-1].end))||b.at(-1).end!==cutoff||c.at(-1).end!==Math.floor(cutoff/900000)*900000)return reject('CONTEXT_NOT_SYNCHRONIZED');
 const a=atr(b),ca=atr(c),fast=ema(c,20),slow=ema(c,50),slope=fast-ema(c.slice(0,-3),20),up=fast>slow&&slope>0&&fast-slow>=0.35*ca,down=fast<slow&&slope<0&&slow-fast>=0.35*ca;
 if(!(a>0&&ca>0))return reject('VOLATILITY_INVALID');
 const er=Math.abs(n(c.at(-1).close)-n(c.at(-21).close))/Math.max(1e-12,c.slice(-20).reduce((acc,x,i)=>acc+Math.abs(n(x.close)-n(c[c.length-21+i].close)),0)),range=!up&&!down&&er<=0.28&&Math.abs(fast-slow)<=0.6*ca;
 const last=b.at(-1),prev=b.at(-2),prior=b.slice(0,-1),e9=ema(b,9),prev9=ema(prior,9),center=mean(prior.slice(-20).map(x=>n(x.close))),sd=Math.sqrt(mean(prior.slice(-20).map(x=>(n(x.close)-center)**2))),high=Math.max(...prior.slice(-8).map(x=>n(x.high))),low=Math.min(...prior.slice(-8).map(x=>n(x.low))),vol=mean(prior.slice(-20).map(x=>n(x.volume)));
 const facts={atr5:a,atr15:ca,efficiency15:er,regime:up?'UP':down?'DOWN':range?'RANGE':'NEUTRAL'};
 return P.patterns.map(pattern=>{
  let direction=null,anchor=null;
  if(pattern==='BREAKOUT'){
   if(up&&n(last.close)>high&&n(last.close)>n(last.open)&&n(last.close)>=n(last.low)+0.75*(n(last.high)-n(last.low))&&n(last.volume)>=1.15*vol){direction='LONG';anchor=high;}
   if(down&&n(last.close)<low&&n(last.close)<n(last.open)&&n(last.close)<=n(last.low)+0.25*(n(last.high)-n(last.low))&&n(last.volume)>=1.15*vol){direction='SHORT';anchor=low;}
  }else if(pattern==='PULLBACK'){
   if(up&&n(prev.low)<=prev9&&n(last.close)>e9&&n(last.close)>n(last.open)&&n(last.close)>n(prev.close)){direction='LONG';anchor=e9;}
   if(down&&n(prev.high)>=prev9&&n(last.close)<e9&&n(last.close)<n(last.open)&&n(last.close)<n(prev.close)){direction='SHORT';anchor=e9;}
  }else if(pattern==='RANGE_REENTRY'&&range){
   if(n(prev.close)<center-2*sd&&n(last.close)>=center-2*sd&&n(last.close)>n(last.open)){direction='LONG';anchor=center-2*sd;}
   if(n(prev.close)>center+2*sd&&n(last.close)<=center+2*sd&&n(last.close)<n(last.open)){direction='SHORT';anchor=center+2*sd;}
  }
  if(!direction)return {pattern,reason:'WAIT_'+pattern,facts};
  const short=direction==='SHORT',sign=short?-1:1,tick=meta.tick_size;
  // Improve the entry at an observed level. A later trade must fill the order.
  const entry=round(short?Math.max(n(q.ask),anchor):Math.min(n(q.bid),anchor),tick,short),local=b.slice(-3),stop=round(short?Math.max(...local.map(x=>n(x.high)))+0.1*a:Math.min(...local.map(x=>n(x.low)))-0.1*a,tick,short),distance=sign*(entry-stop),distanceFromQuote=sign*((short?n(q.ask):n(q.bid))-entry);
  if(distance<0.5*a||distance>2.5*a||distanceFromQuote>1.5*a)return {pattern,reason:'STRUCTURAL_ENTRY_DISTANCE',facts};
  let target=pattern==='RANGE_REENTRY'?center:n(last.close)+sign*3*a;
  if(pattern==='PULLBACK'){const structure=short?Math.min(...prior.slice(-20).map(x=>n(x.low))):Math.max(...prior.slice(-20).map(x=>n(x.high)));if(sign*(structure-entry)>0)target=short?Math.max(target,structure):Math.min(target,structure);}
  target=round(target,tick,!short);
  const move=sign*(target-entry)/entry,econ=secondaryEconomics(entry,stop,target,direction,rate),detail={...facts,...econ,entry,stop,target,requiredMovePct:move*100,entryImprovementUSD:distanceFromQuote};
  if(!(entry>0&&stop>0&&target>0&&move>0&&move<=P.maxTargetMove))return {pattern,reason:'TARGET_OUTSIDE_SHORT_HORIZON',facts:detail};
  if(!(econ.gain>0&&econ.loss>0&&econ.netRR>=P.minNetRR))return {pattern,reason:'COST_OR_NET_RR',facts:detail};
  const titles={BREAKOUT:'Ruptura y retesteo',PULLBACK:'Retroceso en tendencia',RANGE_REENTRY:'Reentrada en rango'};
  const plan={id:hash([SECONDARY_VERSION,pattern,cutoff]),version:SECONDARY_VERSION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',family:'L',pattern,recipe:pattern,recipe_title:'PF_XBTUSD · '+titles[pattern],direction,timeframe:5,entry:String(entry),limit:String(entry),stop:String(stop),target:String(target),confirmed_at:cutoff,decision_at:now,expires_at:now+P.entryExpiryMs,holding_ms:P.holdingMs,order:'FUTURES_POST_ONLY_LIMIT',fill_model:'OBSERVED_TRADE_THROUGH_20X',criteria:['CLOSED_5M','CLOSED_15M_CONTEXT',pattern,'STRUCTURAL_LIMIT_ENTRY','NET_RR_1_5'],context:{symbol:P.symbol,stopTf:5,targetTf:5,holdingMs:P.holdingMs},economics:econ,experiment:true,study:{prediction:{status:'UNAVAILABLE',event:'NET_POSITIVE_AT_CLOSE'}}};
  plan.evidence={schema:1,at:now,default_tf:5,closed_bars:true,input_hash:hash({b,c}),panels:[{tf:5,candles:b.slice(-80),lines:[]},{tf:15,candles:c.slice(-80),lines:[]}],levels:[{name:'Nivel de entrada observado',value:anchor}],facts:Object.entries(detail).map(([label,value])=>({label,value})),rules:['Datos del contrato PF_XBTUSD, no del mercado spot.','Señal con velas cerradas; entrada límite en retesteo, retroceso o extremo del rango.','Ejecución posterior al envío: operación que atraviese el límite con al menos veinte veces la cantidad.','Stop estructural; beneficio/riesgo neto mínimo 1,5, con costes y financiación.','Salida por stop, objetivo neto, control manual o 30 minutos; ninguna ganancia garantizada.']};
  return {pattern,reason:'CANDIDATE',facts:detail,plan};
 });
}
export function initializeSecondary(root,now,event=()=>{}){
 const a=root.frequency.account;
 if(root.secondaryExecution){
  const x=root.secondaryExecution;if(x.version!==SECONDARY_VERSION||x.protocol_hash!==hash(P)||hash(x.protocol)!==hash(P))throw Error('SECONDARY_EXECUTION_PROTOCOL_MISMATCH');
  validateRiskBudgetState(root);
  const positions=values(a.positions),records=[...positions,...values(a.pendingOrders)];if(records.some(p=>!isSecondary(p)))throw Error('SECONDARY_MIXED_EXECUTION_MODELS');
  for(const row of records){const plan=row.plan,c=plan.execution_contract;if(!c)continue;
   if(![EXPLORATION_EXECUTION_VERSION,RISK_EXECUTION_VERSION].includes(c.version)||c.realTrading!==false||c.symbol!==P.symbol||!['TAKER_IOC','MAKER_LIMIT'].includes(c.mode)||!isRiskContract(plan)&&c.leverage!==2)throw Error('SECONDARY_EXECUTION_CONTRACT_UNSUPPORTED');
   validateRiskContract(plan);validateRiskRecovery(root,plan);
   if(typeof plan.hash!=='string'||!/^[a-f0-9]{64}$/.test(plan.hash)||plan.hash!==hash({...plan,hash:undefined}))throw Error('SECONDARY_EXECUTION_PLAN_INTEGRITY');
   const finite=v=>v!==null&&v!==undefined&&Number.isFinite(n(v)),positive=v=>finite(v)&&D(v).gt(0),nonnegative=v=>finite(v)&&D(v).gte(0);
   if(!positive(c.nominalUSD)||!positive(c.participation)||D(c.participation).gt(1)||![c.makerFee,c.takerFee,c.slippage].every(v=>nonnegative(v)&&D(v).lt(1))||!Number.isSafeInteger(c.latencyMs)||c.latencyMs<0||c.exitLatencyMs!==undefined&&(!Number.isSafeInteger(c.exitLatencyMs)||c.exitLatencyMs<0)||!Number.isSafeInteger(c.not_before)||c.decision_at!==plan.decision_at||c.not_before!==c.decision_at+c.latencyMs||c.expires_at!==plan.expires_at||c.expires_at<=c.not_before)throw Error('SECONDARY_EXECUTION_CONTRACT_INTEGRITY');
   if(!positive(plan.sizing?.qty)||!positive(plan.sizing?.qty_step)||![plan.entry,plan.stop,plan.target].every(positive))throw Error('SECONDARY_EXECUTION_STATE_INTEGRITY');
   validateProfitContracts(plan);
   validateCapitalAllocationContract(plan);
   if(positions.includes(row)){
    if(![row.qty,row.entry,row.initial_margin].every(positive)||!nonnegative(row.entry_fee)||!finite(row.accrued_funding??0)||D(row.qty).gt(plan.sizing.qty)||!Number.isSafeInteger(row.entered_at)||!Number.isSafeInteger(row.expires_at)||row.expires_at<=row.entered_at)throw Error('SECONDARY_EXECUTION_STATE_INTEGRITY');
    validateProfitProtection(row);
   }else if(!positive(row.remaining_qty)||!nonnegative(row.filled_qty)||!nonnegative(row.remaining_reserved)||!nonnegative(row.observed_capacity??0)||!D(row.remaining_qty).plus(row.filled_qty).eq(plan.sizing.qty)||!Number.isSafeInteger(row.placed_at)||row.placed_at!==c.not_before)throw Error('SECONDARY_EXECUTION_STATE_INTEGRITY');
  }
  return x;
 }
 if(!a.portfolio||values(a.positions).length||values(a.pendingOrders).length||a.position||a.pending)throw Error('SECONDARY_REQUIRES_FLAT_MIGRATION');
 if(root.laboratory.status!=='RESEARCH_COMPLETE'||a.halted)throw Error('SECONDARY_LEGACY_STATE_CHANGED');
 const at=now,baseline={cash:a.cash,equity:a.equity,net:a.net,fees:a.fees,closed:a.closed,wins:a.wins,losses:a.losses};
 const x=root.secondaryExecution={version:SECONDARY_VERSION,protocol:structuredClone(P),protocol_hash:hash(P),activated_at:at,status:'ACTIVE_PAPER',baseline,last_cutoff:Math.floor(now/300000)*300000,last_quote_at:0,peak:a.equity,day:new Date(now).toISOString().slice(0,10),day_start:a.equity,loss_streak:0,cooldown_until:0,decisions:{},counts:{evaluations:0,selected:0,filled:0,closed:0},source:'KRAKEN_FUTURES_PUBLIC',market_issue:'WARMUP',legacy_trial_status:root.laboratory.status};
 event({type:'SECONDARY_EXECUTION_ENABLED',at,version:SECONDARY_VERSION,baseline,ledger:'FREQUENT_PAPER',capital_added:'0',realTrading:false});return x;
}
// Additive execution records live inside the existing, atomically committed state.
// The immutable v1 protocol still governs every order without an execution_contract.
const newContract=p=>p?.execution_contract?.version===EXPLORATION_EXECUTION_VERSION||isRiskContract(p);
const minD=(a,b)=>D(a).lt(b)?D(a):D(b);
const maxD=(a,b)=>D(a).gt(b)?D(a):D(b);
const slimPlan=p=>p?Object.fromEntries(['id','version','entry_revision','execution_model','instrument','pattern','direction','recipe_title','timeframe','entry','limit','stop','target','confirmed_at','decision_at','expires_at','holding_ms','order','fill_model','execution_contract','sizing','hash','signal_key','quality','economics','economic_policy','entry_economics','entry_context','context_admission','exit_policy','timeframe_contract','movement_id','parent_id','leg_index','confirmation_id'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]])):undefined;
export class SecondaryBroker{
 constructor({root,now=()=>Date.now(),event=()=>{},notice=()=>{}}){Object.assign(this,{root,now,event,notice});this.f=root.frequency;this.a=this.f.account;this.x=initializeSecondary(root,now(),event);}
 stats(plan){
  if(!plan?.pattern)return null;
  this.x.by_pattern_version??={};const version=plan.entry_revision??plan.execution_contract?.version??plan.version,domain=isRiskContract(plan)||plan.timeframe_contract?{entry_revision:version,timeframe:plan.timeframe,execution_version:plan.execution_contract?.version,execution_policy_hash:plan.execution_contract?.policy_hash,economic_policy_hash:plan.economic_policy?.hash,exit_policy_hash:plan.exit_policy?.hash}:null,key=domain?version+':'+plan.timeframe+':'+plan.pattern+':'+hash(domain).slice(0,16):version+':'+plan.pattern;
  return this.x.by_pattern_version[key]??={version,pattern:plan.pattern,...(domain?{timeframe:plan.timeframe,domain}:{}),signals:0,selected:0,filled:0,partial_fills:0,expired:0,cancelled:0,closed:0,costs:'0',entry_fees:'0',exit_fees:'0',funding:'0',net:'0',clean:0,uncertain:0};
 }
 record(e){
  const f=this.f,out={...e,at:e.at??this.now(),version:e.version??e.plan?.version??SECONDARY_VERSION,ledger:'FREQUENT_PAPER',realTrading:false};
  const k={SELECTED:'selected',FILLED:'filled',CLOSED:'closed',NOT_FILLED:'notFilled',SUPPRESSED:'suppressed'}[e.type];
  if(k)f.counts[k]=(f.counts[k]??0)+1;if(k&&k in this.x.counts)this.x.counts[k]++;
  if(e.type==='SELECTED'){const day=new Date(out.at).toISOString().slice(0,10);if(f.selectionDay!==day){f.selectionDay=day;f.daySelections=0;}f.daySelections++;}
  if(e.type==='CLOSED'){f.grossClosed=D(f.grossClosed??0).plus(e.pnl).plus(e.fees).toString();f.closedFees=D(f.closedFees??0).plus(e.fees).toString();}
  const stats=this.stats(e.plan??(e.pattern?{pattern:e.pattern,version:out.version}:null));
  if(e.type==='SECONDARY_ENTRY_REJECTED'){
   const key=e.rejection_stage==='CONTEXT'?'context_rejected':e.rejection_stage==='CAPITAL'?'capital_rejected':e.rejection_stage==='TECHNICAL'?'technical_rejected':'economic_rejected';
   this.x.counts[key]=(this.x.counts[key]??0)+1;if(stats)stats[key]=(stats[key]??0)+1;
  }
  if(stats){
   if(['SELECTED','FILLED','CLOSED'].includes(e.type))stats[{SELECTED:'selected',FILLED:'filled',CLOSED:'closed'}[e.type]]++;
   if(e.type==='PARTIAL_FILL'||e.type==='FILLED'&&e.execution_state==='EJECUCIÓN_PARCIAL')stats.partial_fills++;
   if(['NOT_FILLED','ORDER_REMAINDER_CANCELLED'].includes(e.type))stats[e.order_state==='ORDEN_VENCIDA'?'expired':'cancelled']++;
   if(['FILLED','PARTIAL_FILL'].includes(e.type)){stats.costs=D(stats.costs).plus(e.fee).toString();stats.entry_fees=D(stats.entry_fees??0).plus(e.fee).toString();}
   if(['PARTIAL_CLOSE','CLOSED'].includes(e.type)){
    stats.net=D(stats.net).plus(e.fill_pnl??e.pnl).toString();const fee=D(e.fill_exit_fee??0),funding=D(e.fill_funding??0);stats.costs=D(stats.costs).plus(fee).plus(funding).toString();stats.exit_fees=D(stats.exit_fees??0).plus(fee).toString();stats.funding=D(stats.funding??0).plus(funding).toString();
   }
   if(e.type==='CLOSED')stats[e.quality==='OBSERVED'?'clean':'uncertain']++;
  }
  if(k||['PARTIAL_FILL','ORDER_REMAINDER_CANCELLED','PARTIAL_CLOSE','PAPER_CAPITAL_TOPUP','FUNDING_RECONCILED','SECONDARY_ENTRY_REJECTED','TARGET_REACHED','TARGET_REACHED_NET_INSUFFICIENT','TRAILING_QUANTITY_SCALED','PROFIT_PROTECTION_ACTIVATED'].includes(e.type)){
   f.history.unshift({...out,plan:slimPlan(e.plan),quote:undefined,trade:undefined,direction:e.direction??e.plan?.direction,timeframe:e.timeframe??e.plan?.timeframe??5});f.history=f.history.slice(0,120);
  }
  const frame=this.x.timeframe_execution?.frames?.[e.plan?.timeframe];
  if(frame){frame.counts??={};if(['FILLED','CLOSED'].includes(e.type))frame.counts[e.type==='FILLED'?'filled':'closed']=(frame.counts[e.type==='FILLED'?'filled':'closed']??0)+1;if(['PARTIAL_CLOSE','CLOSED'].includes(e.type))frame.counts.net=D(frame.counts.net??0).plus(e.fill_pnl??e.pnl).toString();if(e.type==='FUNDING_RECONCILED')frame.counts.net=D(frame.counts.net??0).plus(e.net_adjustment??0).toString();}
  this.event(out);
  const experimental=newContract(e.plan)||e.experimental===true;
  if(e.type==='SELECTED'&&experimental)this.notice('SECONDARY_SELECTED',out,['secondary-selected',e.id]);
  if(e.type==='FILLED')this.notice(e.execution_state==='EJECUCIÓN_PARCIAL'?'SECONDARY_PARTIAL':'SECONDARY_OPEN',out,['secondary-open',e.id]);
  if(e.type==='PARTIAL_FILL')this.notice('SECONDARY_PARTIAL',out,['secondary-partial',e.id,e.fill_id]);
  if(['NOT_FILLED','ORDER_REMAINDER_CANCELLED'].includes(e.type)&&experimental)this.notice('SECONDARY_UNFILLED',out,['secondary-unfilled',e.id]);
  if(e.type==='PARTIAL_CLOSE')this.notice('SECONDARY_PARTIAL_CLOSE',out,['secondary-partial-close',e.id,e.fill_id]);
  if(e.type==='CLOSED')this.notice('SECONDARY_CLOSE',out,['secondary-close',e.id]);
  if(e.type==='PAPER_CAPITAL_TOPUP')this.notice('SECONDARY_TOPUP',out,['secondary-topup',e.id]);
  if(['TARGET_REACHED','PROFIT_PROTECTION_ACTIVATED'].includes(e.type))this.notice('SECONDARY_TRAILING',out,['secondary-trailing',e.id,e.exit_policy_version]);
  return out;
 }
 capital(){
  if(this.x.capital)return this.x.capital;
  const a=this.a,f=this.root.laboratory?.funding,legacy=f?.initial!==undefined&&f?.added!==undefined;
  // Entry fees are already debited from cash but are not yet realised in account.net.
  const margin=values(a.positions).reduce((s,p)=>s.plus(p.initial_margin).plus(p.entry_fee),D(0));
  const initial=legacy?D(f.initial).plus(f.added):D(a.cash).plus(margin).minus(a.net);
  return this.x.capital={version:'secondary-paper-capital-1.0.0',initial_contributed:initial.toString(),contribution_source:legacy?'LEGACY_FUNDING_LEDGER':'RECONCILED_BALANCE',baseline_equity:a.equity,baseline_cash:a.cash,baseline_net:a.net,topups:'0',total_contributed:initial.toString(),count:0,events:[],keys:[]};
 }
 topup(amount,order,reason,key,now){
  if(hasFiniteCapitalAllocation(this.root)&&reason!==CAPITAL_TOPUP_REASON)return null;
  amount=D(amount);if(!amount.gt(0))return;
  const c=this.capital(),id=hash(['PAPER_CAPITAL_TOPUP',order.id,key]);if(c.keys.includes(id))return;
  const before=this.a.cash;this.a.cash=D(before).plus(amount).toString();this.a.equity=D(this.a.equity).plus(amount).toString();
  c.topups=D(c.topups).plus(amount).toString();c.total_contributed=D(c.initial_contributed).plus(c.topups).toString();c.count++;c.keys.push(id);c.keys=c.keys.slice(-4000);
  const e={type:'PAPER_CAPITAL_TOPUP',id,idempotency_key:id,order_id:order.id,amount:amount.toString(),reason,at:now,portfolio:'SECONDARY_PAPER',balance_before:before,balance_after:this.a.cash,capital_contributed_total:c.total_contributed,experimental:true};
  c.events.push({...e});c.events=c.events.slice(-100);this.record(e);
 }
 mark(q,now){
  let equity=D(this.a.cash);
  for(const p of values(this.a.positions)){const v=secondaryEstimate(p,q,now);if(v){p.execution_quote=q;p.live_exit=v;equity=equity.plus(p.initial_margin).plus(v.gross).minus(v.exit_fee).minus(v.funding);}else equity=equity.plus(p.initial_margin);}
  this.a.equity=equity.toString();this.a.peak=maxD(this.a.peak??equity,equity).toString();
  if(D(this.a.peak).gt(0))this.a.maxDrawdown=maxD(this.a.maxDrawdown??0,D(1).minus(equity.div(this.a.peak))).toString();
  if(equity.gt(this.x.peak))this.x.peak=equity.toString();
  if(!isExploration(this.root)&&D(this.x.peak).gt(0)&&D(1).minus(equity.div(this.x.peak)).gte(P.drawdownFraction)){this.x.status='HALTED_DRAWDOWN';for(const o of values(this.a.pendingOrders))if(!newContract(o.plan))this.cancel(o.plan.id,'DRAWDOWN_HALT');}
  if(this.x.capital)this.x.capital.net_equity_after_contributions=equity.minus(this.x.capital.total_contributed).toString();
  syncPortfolio(this.a);
 }
 validate(plan,q,meta,now){
  if(!secondaryFresh(q,now))return 'FUTURES_DATA_NOT_FRESH';
  if(!isSecondary({plan})||plan.instrument!=='PAPER:KRAKEN_FUTURES:PF_XBTUSD'||!['LONG','SHORT'].includes(plan.direction))return 'EXECUTION_INSTRUMENT_INVALID';
  if(![meta?.qty_step,meta?.tick_size,plan.entry,plan.stop,plan.target,plan.holding_ms].every(v=>Number.isFinite(n(v))&&n(v)>0)||meta?.symbol&&meta.symbol!==P.symbol)return 'EXECUTION_NUMERIC_INVALID';
  if(![plan.decision_at,plan.confirmed_at,plan.expires_at].every(Number.isSafeInteger)||plan.decision_at>now||plan.confirmed_at>plan.decision_at||now>=plan.expires_at||now-plan.decision_at>30000)return 'SIGNAL_NOT_CURRENT';
  const sign=plan.direction==='SHORT'?-1:1;
  if(sign*(n(plan.entry)-n(plan.stop))<=0||sign*(n(plan.target)-n(plan.entry))<=0)return 'INVALID_STRUCTURAL_BARRIERS';
  if(![plan.economics?.loss,plan.economics?.gain,plan.economics?.fundingAllowance].every(v=>Number.isFinite(n(v)))||n(plan.economics.loss)<=0||n(plan.economics.fundingAllowance)<0)return 'ECONOMICS_INVALID';
  const c=plan.execution_contract;
  try{validateProfitContracts(plan);}catch{return 'ENTRY_PROFIT_CONTRACT_INVALID';}
  try{validateCapitalAllocationContract(plan,{root:this.root,current:true});}catch{return 'CAPITAL_ALLOCATION_CONTRACT_INVALID';}
  try{validateRiskContract(plan,{root:this.root,current:true});}catch{return 'RISK_BUDGET_CONTRACT_INVALID';}
  if(c){
   if(!newContract(plan)||!['TAKER_IOC','MAKER_LIMIT'].includes(c.mode)||c.realTrading!==false||c.symbol!==P.symbol||!isRiskContract(plan)&&c.leverage!==2)return 'EXECUTION_CONTRACT_INVALID';
   if(![c.participation,c.slippage,c.makerFee,c.takerFee,c.nominalUSD].every(v=>Number.isFinite(n(v)))||n(c.participation)<=0||n(c.participation)>1||n(c.nominalUSD)<=0||[c.slippage,c.makerFee,c.takerFee].some(v=>n(v)<0||n(v)>=1)||!Number.isSafeInteger(c.not_before)||c.not_before<plan.decision_at||c.expires_at!==plan.expires_at)return 'EXECUTION_CONTRACT_INVALID';
   if(c.mode==='TAKER_IOC'&&q.post_only)return 'INSTRUMENT_POST_ONLY';
  }
  return null;
 }
 preflight(plan,{quote,meta,now,qty}){
  const invalid=this.validate(plan,quote,meta,now);if(invalid)return {accepted:false,reason:invalid};
  const all=[...values(this.a.positions),...values(this.a.pendingOrders)];
  if(all.some(p=>p.plan.id===plan.id||plan.signal_key&&p.plan.signal_key===plan.signal_key)||this.a.portfolio.seen?.includes(plan.id)||plan.signal_key&&this.x.seen_signals?.includes(plan.signal_key))return {accepted:false,reason:'DUPLICATE_SIGNAL'};
  if(!D(qty).gt(0)||!D(qty).isFinite())return {accepted:false,reason:'SIZE_BELOW_MINIMUM'};
  const entry_economics=evaluateEntryEconomics(plan,{quote,qty,entryPrice:plan.entry,now,stage:'ALLOCATION_PREFLIGHT'});
  if(!entry_economics.accepted)return {accepted:false,reason:entry_economics.reason,entry_economics};
  const context_admission=evaluateEntryContext(plan,all);
  return {accepted:context_admission.accepted,reason:context_admission.accepted?'CAPITAL_CANDIDATE_VALID':context_admission.reason,entry_economics,context_admission};
 }
 choose(plan,q,meta,now){
  this.lastAdmission=null;
  const a=this.a,x=this.x,all=[...values(a.positions),...values(a.pendingOrders)],day=new Date(now).toISOString().slice(0,10),explore=isExploration(this.root),contract=plan.execution_contract;
  if(day!==x.day){x.day=day;x.day_start=a.equity;}
  const invalid=this.validate(plan,q,meta,now);if(invalid)return invalid;
  if(contract&&!explore)return 'EXPLORATION_PROFILE_INACTIVE';
  if(all.some(p=>p.plan.id===plan.id||plan.signal_key&&p.plan.signal_key===plan.signal_key)||a.portfolio.seen?.includes(plan.id)||plan.signal_key&&x.seen_signals?.includes(plan.signal_key))return 'DUPLICATE_SIGNAL';
  if(explore&&!newContract(plan))return 'EXPLORATION_CONTRACT_REQUIRED';
  if(getRiskBudgetPolicy(this.root)&&!isRiskContract(plan))return 'RISK_BUDGET_CONTRACT_REQUIRED';
  const profitPolicy=getProfitPolicy(this.root);
  if(profitPolicy&&(!plan.economic_policy||plan.economic_policy.policy_hash!==this.x.profit_policy.policy_hash))return 'ENTRY_PROFIT_POLICY_MISMATCH';
  if(!profitPolicy&&plan.economic_policy)return 'ENTRY_PROFIT_POLICY_INACTIVE';
  let qty,unitReserve;
  const leverage=contract?.leverage??P.leverage,entryFee=contract?.mode==='TAKER_IOC'?contract.takerFee:contract?.makerFee??P.makerFee;
  unitReserve=D(plan.entry).div(leverage).plus(D(plan.entry).mul(entryFee)).plus(plan.economics.fundingAllowance);
  if(explore&&isRiskContract(plan)){
   const admission=revalidateRiskSelection(this.root,plan,q,now);this.lastAdmission={risk_allocation:admission};
   if(!admission.accepted){this.record({type:'SECONDARY_ENTRY_REJECTED',id:plan.id,at:now,plan,reason:admission.reason,rejection_stage:'CAPITAL',risk_allocation:admission});return admission.reason;}
   qty=D(contract.risk_budget.receipt.qty);
  }else if(explore){
   const policy=getExplorationPolicy(this.root),allocation=getAllocationContract(plan);
   if(allocation){try{validateCapitalAllocationContract(plan,{root:this.root,current:true});}catch{return 'CAPITAL_ALLOCATION_CONTRACT_INVALID';}}
   else{
    if(getCapitalAllocationPolicy(this.root))return 'CAPITAL_ALLOCATION_CONTRACT_REQUIRED';
    if(contract.nominalUSD!==policy.nominalUSD||contract.policy_hash!==x.exploration.policy_hash)return 'EXPLORATION_CONTRACT_POLICY_MISMATCH';
   }
   qty=D(allocation?contract.nominalUSD:policy.nominalUSD).div(plan.entry).div(meta.qty_step).floor().mul(meta.qty_step);
  }else{
   if(x.status!=='ACTIVE_PAPER'||a.halted)return 'DRAWDOWN_HALT';
   if(now<x.cooldown_until)return 'LOSS_STREAK_COOLDOWN';
   if(all.some(p=>p.plan.pattern===plan.pattern))return 'PATTERN_ALREADY_OPEN';
   if(all.some(p=>p.plan.direction!==plan.direction))return 'OPPOSITE_BTC_EXPOSURE';
   if(all.length>=P.maxSlots||all.filter(p=>p.plan.direction===plan.direction).length>=P.maxDirectionSlots)return 'PORTFOLIO_CAPACITY';
   const reserved=all.reduce((sum,p)=>sum.plus(p.remaining_risk??p.plan.sizing.risk),D(0)),dailyUsed=maxD(D(x.day_start).minus(a.equity),0);
   const limits=[D(a.equity).mul(P.riskFraction),D(P.riskCapUSD),D(a.equity).mul(P.openRiskFraction).minus(reserved),D(x.day_start).mul(P.dailyLossFraction).minus(dailyUsed).minus(reserved)];
   const risk=limits.reduce((v,k)=>minD(k,v)),pending=values(a.pendingOrders).reduce((sum,p)=>sum.plus(p.remaining_reserved??p.plan.sizing.reserved),D(0)),free=D(a.cash).minus(pending).minus(a.fundingReserve??0).minus(D(a.equity).mul(P.cashReserveFraction));
   const gross=all.reduce((sum,p)=>sum.plus(p.plan.sizing.exposure),D(0)),grossFree=D(a.equity).mul(P.maxGrossExposure).minus(gross);
   if(risk.lte(0)||free.lte(0)||grossFree.lte(0))return 'SHARED_RISK_OR_CAPITAL';
   qty=[risk.div(plan.economics.loss),free.div(unitReserve),grossFree.div(plan.entry)].reduce((v,k)=>minD(k,v)).div(meta.qty_step).floor().mul(meta.qty_step);
  }
  if(qty.lt(meta.qty_step)||qty.lte(0)||!qty.isFinite())return 'SIZE_BELOW_MINIMUM';
  const exposure=qty.mul(plan.entry),margin=exposure.div(leverage),funding=qty.mul(plan.economics.fundingAllowance),risk=qty.mul(plan.economics.loss),equity=D(a.equity);
  plan={...plan,sizing:{qty:qty.toString(),qty_step:String(meta.qty_step),risk:risk.toString(),risk_pct:equity.gt(0)?risk.div(equity).mul(100).toString():null,exposure:exposure.toString(),reserved:qty.mul(unitReserve).toString(),initial_margin:margin.toString(),funding_reserved:funding.toString(),leverage,effective_leverage:equity.gt(0)?exposure.div(equity).toString():null,target_net:qty.mul(plan.economics.gain).toString(),net_rr:plan.economics.netRR==null?null:String(plan.economics.netRR),fee:contract?.takerFee??P.takerFee,entry_fee_rate:entryFee,slippage:contract?.slippage??P.slippage,financing:'PF_XBTUSD_HOURLY_SIGNED',fill_model:plan.fill_model,nominal_usd:contract?.nominalUSD??null}};
  if(isRiskContract(plan)){const r=contract.risk_budget.receipt;Object.assign(plan.sizing,{risk:r.risk,risk_pct:equity.gt(0)?D(r.risk).div(equity).mul(100).toString():null,execution_stress:qty.mul(r.unit_stress).toString(),risk_budget_version:r.version,margin_model:r.margin_model});}
  if(plan.economic_policy){
   plan.entry_economics=evaluateEntryEconomics(plan,{quote:q,qty:qty.toString(),entryPrice:plan.entry,now,stage:'SELECTION'});
   this.lastAdmission={...this.lastAdmission,entry_economics:plan.entry_economics};
   if(!plan.entry_economics.accepted){this.record({type:'SECONDARY_ENTRY_REJECTED',id:plan.id,at:now,plan,reason:plan.entry_economics.reason,rejection_stage:'ECONOMICS',entry_economics:plan.entry_economics});return plan.entry_economics.reason;}
   plan.context_admission=evaluateEntryContext(plan,all);this.lastAdmission.context_admission=plan.context_admission;
   if(!plan.context_admission.accepted){this.record({type:'SECONDARY_ENTRY_REJECTED',id:plan.id,at:now,plan,reason:plan.context_admission.reason,rejection_stage:'CONTEXT',context_admission:plan.context_admission});return plan.context_admission.reason;}
   // Monetary forecasts and their thresholds use the rounded effective quantity.
   Object.assign(plan.sizing,{target_net:plan.entry_economics.expected_net_target,risk:isRiskContract(plan)?contract.risk_budget.receipt.risk:plan.entry_economics.expected_loss_stop,expected_loss_stop:plan.entry_economics.expected_loss_stop,net_rr:plan.entry_economics.net_rr});
  }
  plan.hash=hash({...plan,hash:undefined});
  if(explore){
   this.capital();syncPortfolio(a);const free=D(capitalAllocationFreeCash(a)),deficit=D(plan.sizing.reserved).minus(free);
   if(hasFiniteCapitalAllocation(this.root)){
    if(deficit.gt(0)){this.record({type:'SECONDARY_ENTRY_REJECTED',id:plan.id,plan,at:now,reason:'PAPER_CAPITAL_INSUFFICIENT',rejection_stage:'CAPITAL',available_cash:free.toString(),required_reserve:plan.sizing.reserved});return 'PAPER_CAPITAL_INSUFFICIENT';}
   }else this.topup(deficit,plan,'OPERABLE_ORDER_RESERVATION','SELECT',now);
  }
  const placed=contract?.not_before??now+P.latencyMs;
  if(isRiskContract(plan))recordRiskSelection(this.root,plan,now);
  a.pendingOrders[plan.id]={plan,placed_at:placed,posted_at:null,requested_qty:qty.toString(),remaining_qty:qty.toString(),filled_qty:'0',remaining_reserved:plan.sizing.reserved,remaining_risk:plan.sizing.risk,observed_capacity:'0',state:'ORDEN_PENDIENTE'};
  a.portfolio.seen=[...(a.portfolio.seen??[]),plan.id].slice(-4000);if(plan.signal_key)x.seen_signals=[...(x.seen_signals??[]),plan.signal_key].slice(-4000);syncPortfolio(a);
  this.record({type:'SELECTED',id:plan.id,plan,at:now,placed_at:placed,requested_qty:qty.toString(),cumulative_qty:'0',remaining_qty:qty.toString(),execution_state:'ORDEN_SELECCIONADA',order_state:'ORDEN_PENDIENTE'});return 'ENTRY_PENDING';
 }
 cancel(id,reason,now=this.now()){
  const o=this.a.pendingOrders[id];if(!o)return;delete this.a.pendingOrders[id];syncPortfolio(this.a);
  const partial=D(o.filled_qty??0).gt(0),expired=['VENCIDA','ORDER_EXPIRED','RESTART_EXPIRED'].includes(reason);
  this.record({type:partial?'ORDER_REMAINDER_CANCELLED':'NOT_FILLED',id,at:now,reason,plan:o.plan,direction:o.plan.direction,timeframe:o.plan.timeframe??5,had_partial:partial,requested_qty:o.requested_qty??o.plan.sizing.qty,cumulative_qty:o.filled_qty??'0',remaining_qty:o.remaining_qty??o.plan.sizing.qty,entry_revalidation:o.last_entry_economics??null,order_state:expired?'ORDEN_VENCIDA':'ORDEN_CANCELADA',execution_state:partial?'POSICIÓN_ABIERTA':expired?'ORDEN_VENCIDA':'ORDEN_CANCELADA'});
 }
 cancelAll(reason){for(const id of Object.keys(this.a.pendingOrders))this.cancel(id,reason);}
 gap(reason,now=this.now()){
  const previous=this.x.market_issue;this.x.market_issue=reason;this.x.gap_started_at??=this.x.last_quote_at||now;
  for(const p of values(this.a.positions)){
   p.data_gaps??=[];if(!p.data_gaps.some(g=>g.from===this.x.gap_started_at&&g.to==null))p.data_gaps.push({from:this.x.gap_started_at,to:null,reason,status:'UNRESOLVED_PRICE_PATH'});
   p.data_gaps=p.data_gaps.slice(-100);p.quality='UNRESOLVED_MARKET_GAP';
   if(p.exit_requested==='DATA_GAP_CLOSE')delete p.exit_requested;
  }
  if(previous!==reason)this.event({type:'SECONDARY_DATA_GAP',at:now,reason,from:this.x.gap_started_at,ledger:'FREQUENT_PAPER',orders_preserved:true,positions_preserved:true});
 }
 recoverMarket(q,now){
  if(!this.x.gap_started_at)return;
  for(const p of values(this.a.positions))for(const g of p.data_gaps??[])if(g.to==null){g.to=q.event_at;g.recovery_quote_at=q.event_at;}
  this.event({type:'SECONDARY_DATA_RECOVERED',at:now,from:this.x.gap_started_at,quote_at:q.event_at,ledger:'FREQUENT_PAPER',evaluation_resumed:true,historical_path_reconstructed:false});
  this.x.last_recovery={at:now,quote_at:q.event_at,from:this.x.gap_started_at,quality:'LIVE_DATA_RESTORED_PAST_PATH_UNRESOLVED'};delete this.x.gap_started_at;
 }
 liquidity(){return this.x.liquidity??={quote_at:0,quote_used:{bid:'0',ask:'0'},trade_floor:0,trades:{}};}
 quoteAvailable(q,side,participation){
  const l=this.liquidity();if(q.event_at<l.quote_at)return D(0);
  if(q.event_at>l.quote_at){l.quote_at=q.event_at;l.quote_used={bid:'0',ask:'0'};}
  return maxD(D(q[side+'_qty']).mul(participation).minus(l.quote_used[side]),0);
 }
 useQuote(q,side,qty){const l=this.liquidity();if(l.quote_at!==q.event_at)throw Error('SECONDARY_LIQUIDITY_EPOCH_CHANGED');l.quote_used[side]=D(l.quote_used[side]).plus(qty).toString();}
 tradeEvidence(t,now){
  if(!t||!Number.isFinite(t.qty)||t.qty<=0||!Number.isFinite(t.price)||t.price<=0||!Number.isSafeInteger(t.event_at)||!Number.isSafeInteger(t.received_at)||now-t.received_at<0||now-t.received_at>5000||now-t.event_at>5000||t.event_at>now+1000||!['buy','sell'].includes(t.side))return null;
  if(t.symbol&&t.symbol!==P.symbol||t.source&&t.source!=='KRAKEN_FUTURES_WS_TRADE'||t.type&&!['fill','liquidation'].includes(t.type))return null;
  const l=this.liquidity();
  if(!l.last_prune_at||now-l.last_prune_at>=1000){for(const [id,r] of Object.entries(l.trades))if(r.event_at<now-10000){l.trade_floor=Math.max(l.trade_floor,r.event_at);delete l.trades[id];}l.trade_count=Object.keys(l.trades).length;l.last_prune_at=now;}
  if(t.event_at<=l.trade_floor)return null;
  const id=t.id??hash([P.symbol,t.event_at,t.side,t.price,t.qty]);
  const old=l.trades[id];if(old&&old.processed)return null;
  const e=l.trades[id]??={event_at:t.event_at,used:'0',processed:false};if(!old)l.trade_count=(l.trade_count??0)+1;
  if(l.trade_count>5000){const sorted=Object.entries(l.trades).sort((a,b)=>a[1].event_at-b[1].event_at);for(const [key,row] of sorted.slice(0,1000)){l.trade_floor=Math.max(l.trade_floor,row.event_at);delete l.trades[key];l.trade_count--;}if(t.event_at<=l.trade_floor)return null;}
  return {id,e};
 }
 affordableFillQuantity(o,quantity,price,quote,now){
  const proposed=D(quantity);if(!hasFiniteCapitalAllocation(this.root))return proposed;
  const plan=o.plan,free=D(capitalAllocationFreeCash(this.a,{excludeOrderId:plan.id})),unit=plan.execution_contract?D(capitalUnitReserve(plan,price)):D(price).div(P.leverage).plus(D(price).mul(P.makerFee)).plus(plan.economics.fundingAllowance);
  const affordable=free.div(unit).div(plan.sizing.qty_step).floor().mul(plan.sizing.qty_step),capitalQty=minD(proposed,affordable),qty=riskFillQuantity(this.root,o,capitalQty,price,{fundingRate:this.currentFundingRate,quote,now});
  if(qty.lt(proposed))o.capital_fill_limit={requested_qty:proposed.toString(),affordable_qty:qty.toString(),available_cash:free.toString(),reason:'OBSERVED_FILL_FINITE_CAPITAL'};
  if(plan.execution_contract?.mode!=='TAKER_IOC'){
   const remaining=D(o.remaining_qty??plan.sizing.qty),rest=D(o.remaining_reserved??plan.sizing.reserved).mul(remaining.minus(qty)).div(remaining);
   o.cancel_unfunded_remainder=Boolean(o.cancel_unfunded_remainder)||qty.mul(unit).plus(rest).gt(free);
  }
  return qty;
 }
 fillOrder(o,quantity,price,q,now,evidence){
  const plan=o.plan,c=plan.execution_contract,qty=D(quantity),feeRate=c?.mode==='TAKER_IOC'?c.takerFee:c?.makerFee??P.makerFee,leverage=c?.leverage??P.leverage,remaining=D(o.remaining_qty??plan.sizing.qty);
  if(!qty.gt(0)||qty.gt(remaining)||!D(price).gt(0))return false;
  const pyramidCheck=revalidatePyramidFill(this.root,plan,q,now);if(!pyramidCheck.accepted){this.record({type:'SECONDARY_ENTRY_REJECTED',id:plan.id,at:now,plan,reason:pyramidCheck.reason,rejection_stage:'CONTEXT'});this.cancel(plan.id,pyramidCheck.reason,now);return false;}
  if(isRiskContract(plan)&&riskFillQuantity(this.root,o,qty,price,{fundingRate:this.currentFundingRate,quote:q,now}).lt(qty)){this.cancel(plan.id,'POST_LATENCY_RISK_BUDGET_CHANGED',now);return false;}
  if(plan.economic_policy){
   const receipt=evaluateEntryEconomics(plan,{quote:q,qty:qty.toString(),entryPrice:price,fundingRate:this.currentFundingRate,now,stage:'PRE_EXECUTION'});o.last_entry_economics=receipt;
   if(!receipt.accepted){
    this.record({type:'SECONDARY_ENTRY_REJECTED',id:plan.id,at:now,plan,reason:receipt.reason,rejection_stage:'PRE_EXECUTION',entry_economics:receipt,evidence_id:evidence.id});
    this.cancel(plan.id,'PRE_EXECUTION_'+receipt.reason,now);return false;
   }
   if(this.a.positions[plan.id]?.profit_protection?.trailing_activated_at!=null){this.cancel(plan.id,'TRAILING_ACTIVE_CANCELLED_ENTRY_REMAINDER',now);return false;}
  }
  const cost=qty.mul(price),fee=cost.mul(feeRate),margin=cost.div(leverage),debit=margin.plus(fee);
  const taker=c?.mode==='TAKER_IOC',side=plan.direction==='SHORT'?'bid':'ask',rawPrice=taker?q[side]:String(price),spread=D(q.ask).minus(q.bid),slippageCost=taker?D(price).minus(rawPrice).abs().mul(qty):D(0),spreadCost=taker?spread.mul(qty).div(2):null;
  const others=values(this.a.pendingOrders).filter(x=>x!==o).reduce((s,p)=>s.plus(p.remaining_reserved??p.plan.sizing.reserved),D(0));
  if(hasFiniteCapitalAllocation(this.root)){
   const free=D(capitalAllocationFreeCash(this.a,{excludeOrderId:plan.id})),newFunding=qty.mul(isRiskContract(plan)?maxD(plan.economics.fundingAllowance,riskUnitLoss(plan,{entryPrice:price,fundingRate:this.currentFundingRate}).funding):plan.economics.fundingAllowance),rest=taker||o.cancel_unfunded_remainder?D(0):D(o.remaining_reserved??plan.sizing.reserved).mul(remaining.minus(qty)).div(remaining);
   if(debit.plus(newFunding).plus(rest).gt(free)){this.cancel(plan.id,'PAPER_CAPITAL_INSUFFICIENT_AT_FILL',now);return false;}
  }else if(newContract(plan))this.topup(debit.plus(others).plus(this.a.fundingReserve??0).minus(this.a.cash),plan,'OBSERVED_FILL_CAPITAL',evidence.id,now);
  if(debit.gt(this.a.cash)){this.cancel(plan.id,'CAPITAL_CHANGED',now);return false;}
  const before=this.a.positions[plan.id],first=!before,filled=D(o.filled_qty??0).plus(qty),left=remaining.minus(qty),fraction=left.div(plan.sizing.qty),fillId=hash([plan.id,evidence.id,filled.toString()]);
  this.a.cash=D(this.a.cash).minus(debit).toString();this.a.fees=D(this.a.fees).plus(fee).toString();
  let p=before;
  if(!p){
   p=this.a.positions[plan.id]={plan,qty:'0',initial_qty:'0',entry:String(price),entry_fee:'0',initial_margin:'0',total_entry:'0',entered_at:now,expires_at:now+plan.holding_ms,last_funding_at:now,accrued_funding:'0',funding_pending:[],quality:'OBSERVED',execution_quote:q,fills:[],closed_qty:'0',realized:{net:'0',gross:'0',fees:'0',funding:'0',entry_fee:'0',exit_fee:'0',exit_value:'0'},excursions:{max_favourable_price:'0',max_adverse_price:'0',max_favourable_net:'0',max_adverse_net:'0',observations:0}};
  }
  const oldQty=D(p.qty),newQty=oldQty.plus(qty);p.entry=D(p.entry).mul(oldQty).plus(cost).div(newQty).toString();p.qty=newQty.toString();p.initial_qty=D(p.initial_qty??oldQty).plus(qty).toString();p.entry_fee=D(p.entry_fee).plus(fee).toString();p.initial_margin=D(p.initial_margin).plus(margin).toString();p.total_entry=D(p.total_entry).plus(debit).toString();p.execution_quote=q;
  p.target_net=D(plan.sizing.target_net).mul(newQty).div(plan.sizing.qty).toString();
  if(isRiskContract(plan)){const unit=riskUnitLoss(plan,{entryPrice:price,fundingRate:this.currentFundingRate});p.funding_reserved=D(p.funding_reserved??0).plus(qty.mul(maxD(plan.economics.fundingAllowance,unit.funding))).toString();p.remaining_risk=D(p.remaining_risk??0).plus(qty.mul(unit.total)).toString();p.risk_execution={version:plan.execution_contract.risk_budget.policy.version,at:now,quantity:p.qty,risk:p.remaining_risk,stress_per_unit:unit.stress,funding_reserved:p.funding_reserved,margin_model:plan.execution_contract.risk_budget.policy.margin_model,budget_revalidation:o.risk_revalidation??null};}
  else{p.funding_reserved=D(plan.sizing.funding_reserved).mul(newQty).div(plan.sizing.qty).toString();p.remaining_risk=D(plan.sizing.risk).mul(newQty).div(plan.sizing.qty).toString();}
  if(plan.exit_policy){initializeProfitProtection(p,now);p.entry_revalidation=o.last_entry_economics;}
  p.execution_costs??={entry_slippage:'0',entry_spread_vs_mid:'0',entry_fees:'0'};p.execution_costs.entry_slippage=D(p.execution_costs.entry_slippage).plus(slippageCost).toString();p.execution_costs.entry_spread_vs_mid=D(p.execution_costs.entry_spread_vs_mid).plus(spreadCost??0).toString();p.execution_costs.entry_fees=D(p.execution_costs.entry_fees).plus(fee).toString();
  const executionCosts={raw_quote_price:rawPrice,observed_spread_usd_per_btc:spread.toString(),slippage_cost:slippageCost.toString(),spread_cost_vs_mid:spreadCost?.toString()??null,execution_side:taker?side:'MAKER_LIMIT',costs_embedded_in_prices:true};
  p.fills.push({id:fillId,at:now,event_at:evidence.at,qty:qty.toString(),price:String(price),fee:fee.toString(),evidence_id:evidence.id,model:plan.fill_model,...executionCosts});p.fills=p.fills.slice(-100);
  Object.assign(o,{filled_qty:filled.toString(),remaining_qty:left.toString(),remaining_reserved:D(plan.sizing.reserved).mul(fraction).toString(),remaining_risk:D(plan.sizing.risk).mul(fraction).toString(),state:left.gt(0)?'EJECUCIÓN_PARCIAL':'POSICIÓN_ABIERTA'});
  if(left.eq(0))delete this.a.pendingOrders[plan.id];syncPortfolio(this.a);
  this.record({type:first?'FILLED':'PARTIAL_FILL',id:plan.id,fill_id:fillId,at:now,price:String(price),qty:qty.toString(),fee:fee.toString(),plan,quote:q,evidence_id:evidence.id,evidence_at:evidence.at,fill_model:plan.fill_model,requested_qty:plan.sizing.qty,cumulative_qty:filled.toString(),remaining_qty:left.toString(),entry_revalidation:o.last_entry_economics??null,profit_protection:p.profit_protection?structuredClone(p.profit_protection):undefined,capital_limit:o.capital_fill_limit??null,execution_state:left.gt(0)?'EJECUCIÓN_PARCIAL':'POSICIÓN_ABIERTA',...executionCosts});
  return true;
 }
 fill(q,t,now){
  if(!values(this.a.pendingOrders).some(o=>o.posted_at&&o.plan.execution_contract?.mode!=='TAKER_IOC'))return;
  const evidence=this.tradeEvidence(t,now);if(!evidence)return;
  for(const o of values(this.a.pendingOrders)){
   const p=o.plan,c=p.execution_contract,short=p.direction==='SHORT',qty=D(o.remaining_qty??p.sizing.qty);
   if(c?.mode==='TAKER_IOC'||!o.posted_at||t.event_at<=o.posted_at||t.received_at<=o.posted_at||now>=p.expires_at)continue;
   if((short?t.price>=n(p.stop):t.price<=n(p.stop))||(short?t.price<=n(p.target):t.price>=n(p.target))){this.cancel(p.id,'BARRIER_BEFORE_ENTRY',now);continue;}
   if(t.side!==(short?'buy':'sell')||!(short?t.price>n(p.limit):t.price<n(p.limit)))continue;
   const participation=c?.participation??P.participation,available=maxD(D(t.qty).mul(participation).minus(evidence.e.used),0);
   if(!newContract(p)){
    if(available.lt(qty))continue;
    const funded=this.affordableFillQuantity(o,qty,p.entry,q,now);
    if(funded.gt(0)&&this.fillOrder(o,funded,p.entry,q,now,{id:evidence.id,at:t.event_at}))evidence.e.used=D(evidence.e.used).plus(funded).toString();
    if(funded.lte(0)||o.cancel_unfunded_remainder)this.cancel(p.id,'PAPER_CAPITAL_REMAINDER_CANCELLED',now);
   }else{
    const credit=minD(available,qty.minus(o.observed_capacity??0));
    if(credit.gt(0)){o.observed_capacity=D(o.observed_capacity??0).plus(credit).toString();evidence.e.used=D(evidence.e.used).plus(credit).toString();o.capacity_events=[...(o.capacity_events??[]),evidence.id].slice(-100);}
    const proposed=minD(D(o.observed_capacity).div(p.sizing.qty_step).floor().mul(p.sizing.qty_step),qty),fill=this.affordableFillQuantity(o,proposed,p.entry,q,now);
    if(fill.gt(0)&&this.fillOrder(o,fill,p.entry,q,now,{id:hash(o.capacity_events),at:t.event_at}))o.observed_capacity=D(o.observed_capacity).minus(fill).toString();
    if(proposed.gt(0)&&(fill.lte(0)||o.cancel_unfunded_remainder))this.cancel(p.id,'PAPER_CAPITAL_REMAINDER_CANCELLED',now);
   }
  }
  evidence.e.processed=true;
 }
 taker(o,q,now){
  const p=o.plan,c=p.execution_contract;if(c?.mode!=='TAKER_IOC'||now<o.placed_at||q.event_at<o.placed_at||q.received_at<o.placed_at)return;
  if(q.post_only){this.cancel(p.id,'INSTRUMENT_POST_ONLY',now);return;}
  const short=p.direction==='SHORT',side=short?'bid':'ask',sign=short?-1:1,price=D(q[side]).mul(D(1).plus(D(c.slippage).mul(sign)));
  if(sign*(price.minus(p.stop).toNumber())<=0||sign*(D(p.target).minus(price).toNumber())<=0){this.cancel(p.id,'BARRIER_PASSED_BEFORE_EXECUTION',now);return;}
  const capacity=this.quoteAvailable(q,side,c.participation),proposed=minD(o.remaining_qty??p.sizing.qty,capacity).div(p.sizing.qty_step).floor().mul(p.sizing.qty_step),qty=this.affordableFillQuantity(o,proposed,price,q,now);
  if(qty.gt(0)&&this.fillOrder(o,qty,price.toString(),q,now,{id:'quote:'+q.event_at+':'+side,at:q.event_at}))this.useQuote(q,side,qty);
  if(this.a.pendingOrders[p.id])this.cancel(p.id,qty.lt(proposed)?'PAPER_CAPITAL_REMAINDER_CANCELLED':qty.gt(0)?'IOC_REMAINDER_CANCELLED':'IOC_NO_OBSERVED_LIQUIDITY',now);
 }
 fund(p,rates,now){
  const sign=p.plan.direction==='LONG'?1:-1;let from=p.last_funding_at??p.entered_at;
  // Funding on an already realised partial exit is adjusted as soon as its
  // historical rate is known, without waiting for the remaining position.
  if(p.closed_funding_pending?.length){
   let adjustment=D(0);const remaining=[];for(const interval of p.closed_funding_pending){const rate=rates[interval.hour];if(!Number.isFinite(rate)){remaining.push(interval);continue;}adjustment=adjustment.plus(D(rate).mul(interval.qty).mul(sign).mul((interval.to-interval.from)/3600000));}
   if(remaining.length!==p.closed_funding_pending.length){
    p.closed_funding_pending=remaining;this.a.cash=D(this.a.cash).minus(adjustment).toString();this.a.equity=D(this.a.equity).minus(adjustment).toString();this.a.net=D(this.a.net).minus(adjustment).toString();this.a.fees=D(this.a.fees).plus(adjustment).toString();
    p.realized.net=D(p.realized.net).minus(adjustment).toString();p.realized.funding=D(p.realized.funding).plus(adjustment).toString();p.realized.fees=D(p.realized.fees).plus(adjustment).toString();
    const stats=this.stats(p.plan);if(stats){stats.net=D(stats.net).minus(adjustment).toString();stats.costs=D(stats.costs).plus(adjustment).toString();stats.funding=D(stats.funding??0).plus(adjustment).toString();}
    syncPortfolio(this.a);this.record({type:'FUNDING_RECONCILED',id:p.plan.id,at:now,plan:p.plan,amount:adjustment.toString(),net_adjustment:adjustment.negated().toString(),net_after:p.realized.net,position_open:true,funding_complete:!remaining.length,remaining_intervals:remaining.length,result_quality:'RECONSTRUCTED_FUNDING'});
   }
  }
  p.funding_pending??=[];
  const unresolved=[];for(const interval of p.funding_pending){const rate=rates[interval.hour];if(!Number.isFinite(rate)){unresolved.push(interval);continue;}const cost=D(rate).mul(interval.qty).mul(sign).mul((interval.to-interval.from)/3600000);p.accrued_funding=D(p.accrued_funding??0).plus(cost).toString();this.event({type:'FUNDING_INTERVAL_RECOVERED',id:p.plan.id,at:now,interval,rate,cost:cost.toString(),ledger:'FREQUENT_PAPER'});}
  p.funding_pending=unresolved;
  while(from<now){
   const hour=Math.floor(from/3600000)*3600000,end=Math.min(now,hour+3600000),rate=rates[hour];
   if(Number.isFinite(rate)){const cost=D(rate).mul(p.qty).mul(sign).mul((end-from)/3600000);p.accrued_funding=D(p.accrued_funding??0).plus(cost).toString();}
   else{
    const last=p.funding_pending.at(-1);if(last&&last.hour===hour&&last.to===from&&last.qty===p.qty)last.to=end;else p.funding_pending.push({hour,from,to:end,qty:p.qty});
    if(p.quality==='OBSERVED')p.quality='FUNDING_GAP';
   }
   from=end;
  }
  p.last_funding_at=now;
 }
 reconcileClosedFunding(rates,now){
  for(const [id,row] of Object.entries(this.x.closed_funding_pending??{})){
   let cost=D(0);const pending=[];for(const interval of row.intervals){const rate=rates[interval.hour];if(!Number.isFinite(rate)){pending.push(interval);continue;}cost=cost.plus(D(rate).mul(interval.qty).mul(row.direction==='LONG'?1:-1).mul((interval.to-interval.from)/3600000));}
   if(pending.length===row.intervals.length)continue;
   row.intervals=pending;row.reconciled_funding=D(row.reconciled_funding??0).plus(cost).toString();row.net=D(row.net).minus(cost).toString();
   this.a.cash=D(this.a.cash).minus(cost).toString();this.a.equity=D(this.a.equity).minus(cost).toString();this.a.net=D(this.a.net).minus(cost).toString();this.a.fees=D(this.a.fees).plus(cost).toString();this.f.closedFees=D(this.f.closedFees??0).plus(cost).toString();
   syncPortfolio(this.a);if(this.x.capital)this.x.capital.net_equity_after_contributions=D(this.a.equity).minus(this.x.capital.total_contributed).toString();
   const stats=this.stats(row.plan);if(stats){stats.net=D(stats.net).minus(cost).toString();stats.costs=D(stats.costs).plus(cost).toString();stats.funding=D(stats.funding??0).plus(cost).toString();}
   if(!pending.length){const win=D(row.net).gt(0);if(win!==row.counted_win){this.a.wins+=win?1:-1;this.a.losses+=win?-1:1;}delete this.x.closed_funding_pending[id];}
   this.record({type:'FUNDING_RECONCILED',id,at:now,plan:row.plan,amount:cost.toString(),net_adjustment:cost.negated().toString(),net_after:row.net,funding_complete:!pending.length,remaining_intervals:pending.length,result_quality:'RECONSTRUCTED_FUNDING'});
  }
 }
 observePosition(p,q,now){
  const v=secondaryEstimate(p,q,now);if(!v||q.event_at<(p.entered_at??0)||q.event_at<=p.last_excursion_quote)return v;
  const sign=p.plan.direction==='SHORT'?-1:1,move=D(v.quote_price).minus(p.entry).mul(sign);
  p.excursions??={max_favourable_price:'0',max_adverse_price:'0',max_favourable_net:'0',max_adverse_net:'0',observations:0};
  p.excursions.max_favourable_price=maxD(p.excursions.max_favourable_price,move).toString();p.excursions.max_adverse_price=minD(p.excursions.max_adverse_price,move).toString();p.excursions.max_favourable_net=maxD(p.excursions.max_favourable_net,v.net).toString();p.excursions.max_adverse_net=minD(p.excursions.max_adverse_net,v.net).toString();p.excursions.observations++;p.excursions.quality=p.quality;p.last_excursion_quote=q.event_at;return v;
 }
 close(p,q,now,reason){
  const a=this.a,v=secondaryEstimate(p,q,now);if(!v||q.event_at<p.entered_at||q.received_at<p.entered_at)return false;
  const durableProfitExit=Boolean(p.plan.exit_policy&&p.exit_intent);
  if(!durableProfitExit&&['NET_TARGET','MANUAL_PROFIT'].includes(reason)&&!v.funding_complete){p.execution_blocker='PROFIT_EXIT_FUNDING_UNRESOLVED';return false;}
  if(!durableProfitExit&&(reason==='NET_TARGET'&&D(v.net).lt(v.net_goal)||reason==='MANUAL_PROFIT'&&D(v.net).lte(0)))return false;
  const experimental=newContract(p.plan);
  if(experimental){
   if(!p.exit_intent){
    const latency=p.plan.execution_contract.exitLatencyMs??p.plan.execution_contract.latencyMs;
    p.exit_intent={reason,decided_at:now,evidence_at:q.event_at,evidence_received_at:q.received_at,trigger_price:q[v.side],not_before:now+latency,valid_until:reason.startsWith('MANUAL_')?p.close_request?.expires_at??null:null};
    if(p.plan.exit_policy){p.exit_intent.valid_until=null;markProfitExitPending(p,p.exit_intent);}
    if(a.pendingOrders[p.plan.id])this.cancel(p.plan.id,'POSITION_EXIT_CANCELLED_REMAINDER',now);
    this.event({type:'SECONDARY_EXIT_SELECTED',id:p.plan.id,at:now,ledger:'FREQUENT_PAPER',execution_contract:p.plan.execution_contract,exit_intent:p.exit_intent,realTrading:false});
   }
   const intent=p.exit_intent;
   if(now<intent.not_before||q.event_at<intent.not_before||q.received_at<intent.not_before||q.event_at<=intent.evidence_at){p.execution_blocker='EXIT_LATENCY_PENDING';return false;}
  }
  if(q.post_only){p.execution_blocker='INSTRUMENT_POST_ONLY_EXIT';return false;}delete p.execution_blocker;
  const participation=p.plan.execution_contract?.participation??P.participation,available=this.quoteAvailable(q,v.side,participation),requested=D(p.qty),step=p.plan.sizing.qty_step??'0.00000001';
  const qty=experimental?minD(requested,available).div(step).floor().mul(step):available.gte(requested)?requested:D(0);if(!qty.gt(0)){p.execution_blocker='EXIT_NO_OBSERVED_LIQUIDITY';return false;}
  const ratio=qty.div(requested),part={...p,qty:qty.toString(),entry_fee:D(p.entry_fee).mul(ratio).toString(),accrued_funding:D(p.accrued_funding??0).mul(ratio).toString(),target_net:D(v.net_goal).mul(ratio).toString()},pv=secondaryEstimate(part,q,now);if(!pv)return false;
  // Capture execution evidence before the quote can be replaced by a later mark.
  // These receipts describe this fragment; CLOSED may aggregate earlier fragments.
  const exitQuote=structuredClone(q),exitQuoteHash=hash(exitQuote),liquidityReceipt={model:'OBSERVED_BBO_SHARED_CAPACITY',symbol:P.symbol,quote_at:q.event_at,quote_received_at:q.received_at,side:v.side,observed_qty:String(q[v.side+'_qty']),participation:String(participation),capacity_qty:D(q[v.side+'_qty']).mul(participation).toString(),consumed_before:this.liquidity().quote_used[v.side],available_before:available.toString(),executed_qty:qty.toString()};
  const fundingReceipt={model:'PF_XBTUSD_HOURLY_SIGNED',allocated_amount:pv.funding,accrued_position_before:String(p.accrued_funding??0),last_accrual_at:p.last_funding_at??null,unresolved_intervals:(p.funding_pending??[]).map(interval=>({...interval,qty:D(interval.qty).mul(ratio).toString()})),scope:'EXECUTION_FRAGMENT'};
  this.useQuote(q,v.side,qty);liquidityReceipt.consumed_after=this.liquidity().quote_used[v.side];
  if(a.pendingOrders[p.plan.id])this.cancel(p.plan.id,'POSITION_EXIT_CANCELLED_REMAINDER',now);
  a.cash=D(a.cash).plus(D(p.initial_margin).mul(ratio)).plus(pv.gross).minus(pv.exit_fee).minus(pv.funding).toString();a.net=D(a.net).plus(pv.net).toString();a.fees=D(a.fees).plus(pv.exit_fee).plus(pv.funding).toString();
  p.realized??={net:'0',gross:'0',fees:'0',funding:'0',entry_fee:'0',exit_fee:'0',exit_value:'0'};
  const exitSpread=D(q.ask).minus(q.bid),exitSlippage=D(pv.price).minus(pv.quote_price).abs().mul(qty),exitSpreadCost=exitSpread.mul(qty).div(2);
  for(const [field,value] of Object.entries({net:pv.net,gross:pv.gross,fees:pv.costs,funding:pv.funding,entry_fee:part.entry_fee,exit_fee:pv.exit_fee,exit_value:D(pv.price).mul(qty),exit_slippage_cost:exitSlippage,exit_spread_cost_vs_mid:exitSpreadCost}))p.realized[field]=D(p.realized[field]??0).plus(value).toString();
  p.closed_qty=D(p.closed_qty??0).plus(qty).toString();p.initial_qty??=requested.toString();
  p.closed_funding_pending??=[];for(const interval of p.funding_pending??[]){p.closed_funding_pending.push({...interval,qty:D(interval.qty).mul(ratio).toString()});interval.qty=D(interval.qty).mul(D(1).minus(ratio)).toString();}
  const left=requested.minus(qty),fillId=hash(['EXIT',p.plan.id,q.event_at,p.closed_qty]),details={id:p.plan.id,fill_id:fillId,at:now,entered_at:p.entered_at,entry:p.entry,price:pv.price,qty:qty.toString(),pnl:pv.net,fees:pv.costs,gross:pv.gross,funding:pv.funding,fill_pnl:pv.net,fill_exit_fee:pv.exit_fee,fill_funding:pv.funding,raw_quote_price:pv.quote_price,observed_spread_usd_per_btc:exitSpread.toString(),fill_exit_slippage_cost:exitSlippage.toString(),fill_exit_spread_cost_vs_mid:exitSpreadCost.toString(),costs_embedded_in_prices:true,reason,quality:p.quality,direction:p.plan.direction,timeframe:p.plan.timeframe??5,leverage:p.plan.execution_contract?.leverage??P.leverage,pattern:p.plan.pattern,plan:p.plan,management_override:Boolean(p.management?.override||reason.startsWith('MANUAL_')),control_id:p.close_request?.id??null,remaining_qty:left.toString(),cumulative_qty:p.closed_qty,requested_qty:p.initial_qty,excursions:p.excursions,margin_surrogate:p.margin_surrogate??null,risk_execution:p.risk_execution??null,data_gaps:p.data_gaps??[],exit_intent:p.exit_intent??null,funding_complete:!p.closed_funding_pending.length};
  const executionReceipt={version:'secondary-paper-exit-evidence-1.0.0',scope:'EXECUTION_FRAGMENT',mode:'PAPER',realTrading:false,id:fillId,operation_id:p.plan.id,at:now,contract_version:p.plan.execution_contract?.version??SECONDARY_VERSION,decision_at:p.exit_intent?.decided_at??null,not_before:p.exit_intent?.not_before??null,quote_hash:exitQuoteHash,liquidity_hash:hash(liquidityReceipt),funding_hash:hash(fundingReceipt),quantity:qty.toString(),price:pv.price,remaining_qty:left.toString()};
  executionReceipt.hash=hash(executionReceipt);Object.assign(details,{exit_quote:exitQuote,exit_quote_hash:exitQuoteHash,liquidity_receipt:liquidityReceipt,funding_receipt:fundingReceipt,execution_receipt:executionReceipt});
  if(left.gt(0)){
   const remain=D(1).minus(ratio);for(const key of ['initial_margin','entry_fee','total_entry','accrued_funding','funding_reserved','remaining_risk','target_net'])if(p[key]!==undefined)p[key]=D(p[key]).mul(remain).toString();
   if(p.management?.net_goal!==undefined)p.management.net_goal=D(p.management.net_goal).mul(remain).toString();p.qty=left.toString();
   if(p.risk_execution)p.risk_execution={...p.risk_execution,at:now,quantity:p.qty,risk:p.remaining_risk,funding_reserved:p.funding_reserved};
   if(p.plan.exit_policy){const scaling=scaleProfitProtection(p,requested,left,now);if(scaling)this.record({...scaling,plan:p.plan});details.profit_protection=structuredClone(p.profit_protection);validateProfitProtection(p);}
   this.record({type:'PARTIAL_CLOSE',...details,execution_state:'EJECUCIÓN_PARCIAL'});syncPortfolio(a);return false;
  }
  a.closed++;const profit=D(p.realized.net).gt(0);a.wins+=profit?1:0;a.losses+=profit?0:1;
  if(p.quality==='OBSERVED')a.observedClosed=(a.observedClosed??0)+1;else a.ambiguousClosed=(a.ambiguousClosed??0)+1;
  this.x.loss_streak=profit?0:this.x.loss_streak+1;if(!isExploration(this.root)&&this.x.loss_streak>=P.lossStreak)this.x.cooldown_until=now+P.cooldownMs;
  if(p.closed_funding_pending.length){this.x.closed_funding_pending??={};this.x.closed_funding_pending[p.plan.id]={plan:slimPlan(p.plan),direction:p.plan.direction,closed_at:now,intervals:p.closed_funding_pending,net:p.realized.net,counted_win:profit,reconciled_funding:'0'};}
  if(p.plan.exit_policy){markProfitClosed(p,now);details.profit_protection=structuredClone(p.profit_protection);}
  delete a.positions[p.plan.id];syncPortfolio(a);
  this.record({type:'CLOSED',...details,price:D(p.realized.exit_value).div(p.closed_qty).toString(),qty:p.closed_qty,pnl:p.realized.net,fees:p.realized.fees,gross:p.realized.gross,funding:p.realized.funding,execution_state:'POSICIÓN_CERRADA',entry_fills:p.fills??[],entry_execution_costs:p.execution_costs??null,exit_slippage_cost:p.realized.exit_slippage_cost,exit_spread_cost_vs_mid:p.realized.exit_spread_cost_vs_mid,result_final:!p.closed_funding_pending.length});return true;
 }
 market(q,t,rates,now){
  this.currentFundingRate=rates?.[Math.floor(now/3600000)*3600000];
  // Expiry is a clock event and remains observable even during a market outage.
  for(const o of values(this.a.pendingOrders))if(now>=o.plan.expires_at)this.cancel(o.plan.id,'VENCIDA',now);
  this.reconcileClosedFunding(rates,now);
  if(!secondaryFresh(q,now)){if(this.x.last_quote_at&&now-this.x.last_quote_at>10000)this.gap('FUTURES_DATA_GAP',now);return;}
  if(q.event_at<this.x.last_quote_at)return;
  if(this.x.last_quote_at&&q.event_at-this.x.last_quote_at>10000)this.gap('FUTURES_DATA_GAP',now);
  this.recoverMarket(q,now);this.x.market_issue=null;
  // Accrue the previous quantity before adding any partial entry.
  for(const p of values(this.a.positions))this.fund(p,rates,now);
  for(const o of values(this.a.pendingOrders)){
   const p=o.plan,short=p.direction==='SHORT';if(now<o.placed_at||q.event_at<o.placed_at||q.received_at<o.placed_at)continue;
   if(p.execution_contract?.mode==='TAKER_IOC'){this.taker(o,q,now);continue;}
   if(short?n(q.ask)>=n(p.stop):n(q.bid)<=n(p.stop)){this.cancel(p.id,'BARRIER_BEFORE_ENTRY',now);continue;}
   if(!o.posted_at){
    if(short?n(p.limit)<=n(q.bid):n(p.limit)>=n(q.ask)){this.cancel(p.id,'POST_ONLY_WOULD_CROSS',now);continue;}
    o.posted_at=now;this.event({type:'MAKER_POSTED',id:p.id,at:now,version:p.version,ledger:'FREQUENT_PAPER',quote:q,execution_contract:p.execution_contract??null});
   }
  }
  this.fill(q,t,now);
  for(const p of values(this.a.positions)){
   if(p.plan.exit_policy){this.manageProfitPosition(p,q,rates,now);continue;}
   if(['NET_TARGET','MANUAL_PROFIT','DATA_GAP_CLOSE'].includes(p.exit_requested))delete p.exit_requested;
   if(p.exit_intent?.valid_until!=null&&now>=p.exit_intent.valid_until){delete p.exit_intent;if(p.exit_requested?.startsWith('MANUAL_'))delete p.exit_requested;}
   p.execution_quote=q;this.fund(p,rates,now);const v=this.observePosition(p,q,now),short=p.plan.direction==='SHORT',c=p.close_request;if(!v)continue;
   // A fill cannot immediately close against the same market event used to enter.
   const lastEntry=p.fills?.at(-1)?.event_at??p.entered_at;if(q.event_at<=lastEntry)continue;
   const observedStop=short?n(q.ask)>=n(p.plan.stop):n(q.bid)<=n(p.plan.stop),conditional=p.exit_intent?.reason;
   if(['NET_TARGET','MANUAL_PROFIT'].includes(conditional)&&(!v.funding_complete||observedStop||now>=p.expires_at||conditional==='NET_TARGET'&&D(v.net).lt(v.net_goal)||conditional==='MANUAL_PROFIT'&&D(v.net).lte(0))){
    const cancelled=p.exit_intent;delete p.exit_intent;delete p.execution_blocker;
    this.event({type:'SECONDARY_EXIT_INTENT_CANCELLED',id:p.plan.id,at:now,ledger:'FREQUENT_PAPER',reason:'CONDITION_CHANGED_OR_MANDATORY_EXIT',exit_intent:cancelled,realTrading:false});
   }
   let reason=p.exit_intent?.reason??p.exit_requested??(observedStop?'STOP':null);
   if(!reason&&c&&now>=c.not_before&&q.event_at>=c.not_before&&now<c.expires_at&&(c.mode==='ANY'||v.funding_complete&&D(v.net).gt(0)))reason=c.mode==='PROFIT'?'MANUAL_PROFIT':'MANUAL_CLOSE';
   if(!reason){
    const experimental=newContract(p.plan),targetHit=experimental?(short?n(q.ask)<=n(p.plan.target):n(q.bid)>=n(p.plan.target)):D(v.net).gte(v.net_goal);
    if(targetHit&&q.event_at>=(p.management?.not_before??p.entered_at)&&(experimental&&!p.management?.override||v.funding_complete))reason=experimental&&!p.management?.override?'STRUCTURAL_TARGET':'NET_TARGET';
    if(experimental&&p.management?.override&&v.funding_complete&&D(v.net).gte(v.net_goal))reason='NET_TARGET';
   }
   if(!reason&&now>=p.expires_at)reason='TIMEOUT';
   if(reason){if(!['NET_TARGET','MANUAL_PROFIT','STRUCTURAL_TARGET'].includes(reason))p.exit_requested=reason;this.close(p,q,now,reason);}
  }
  this.x.last_quote_at=Math.max(this.x.last_quote_at,q.event_at);this.mark(q,now);
 }
 manageProfitPosition(p,q,rates,now){
  // The immutable plan chooses this path. Turning admission OFF never changes
  // the management contract of positions already filled under this policy.
  p.execution_quote=q;this.fund(p,rates,now);const v=this.observePosition(p,q,now);if(!v)return;
  const lastEntry=p.fills?.at(-1)?.event_at??p.entered_at;if(q.event_at<=lastEntry)return;
  const margin=marginSurrogate(p,q,now);if(margin)p.margin_surrogate=margin;
  const short=p.plan.direction==='SHORT',stop=short?D(q.ask).gte(p.plan.stop):D(q.bid).lte(p.plan.stop),manual=p.close_request;
  if(stop&&p.exit_intent&&p.exit_intent.reason!=='STOP'&&p.exit_intent.reason!=='ISOLATED_MARGIN_STRESS'){
   const previous=structuredClone(p.exit_intent);p.exit_intent={...p.exit_intent,reason:'STOP',superseded_reason:previous.reason,stop_observed_at:q.event_at};markProfitExitPending(p,p.exit_intent);
   this.event({type:'SECONDARY_EXIT_PRIORITY_UPDATED',id:p.plan.id,at:now,ledger:'FREQUENT_PAPER',previous,exit_intent:structuredClone(p.exit_intent),realTrading:false});
  }
  let reason=p.exit_intent?.reason??(margin?.triggered?'ISOLATED_MARGIN_STRESS':stop?'STOP':null);
  if(!reason&&p.exit_requested&&!['NET_TARGET','STRUCTURAL_TARGET','MANUAL_PROFIT','DATA_GAP_CLOSE'].includes(p.exit_requested))reason=p.exit_requested;
  if(!reason&&manual&&now>=manual.not_before&&q.event_at>=manual.not_before&&now<manual.expires_at&&(manual.mode==='ANY'||v.funding_complete&&D(v.net).gt(0)))reason=manual.mode==='PROFIT'?'MANUAL_PROFIT':'MANUAL_CLOSE';
  if(!reason){
   const result=evaluateProfitProtection(p,q,v,now,{availableQty:this.quoteAvailable(q,v.side,p.plan.execution_contract.participation).toString()});
   for(const e of result.events)this.record({...e,plan:p.plan,direction:p.plan.direction,pattern:p.plan.pattern});
   if(result.activated&&this.a.pendingOrders[p.plan.id])this.cancel(p.plan.id,'TRAILING_ACTIVE_CANCELLED_ENTRY_REMAINDER',now);
   if(result.blocker)p.execution_blocker=result.blocker;else delete p.execution_blocker;reason=result.reason;
  }
  if(isEarlyProfitContract(p.plan.exit_policy)){try{const observed=captureSecondaryExitAdvisory({position:p,quote:q,valuation:v,now,availableQty:this.quoteAvailable(q,v.side,p.plan.execution_contract.participation).toString(),action:reason?'CLOSE':p.profit_protection?.trailing_activated_at!=null?'PROTECT':'HOLD',reason});if(observed)this.event(observed);}catch{p.exit_advisory_status='DEGRADED';}}
  if(reason){p.exit_requested=reason;this.close(p,q,now,reason);}
 }
}
export class OperationalSecondary extends MultiPatternPaper{
 initialize(){
  this.broker=new SecondaryBroker({root:this.engine.state,now:this.now,event:e=>this.engine.event(e),notice:(...a)=>this.engine.notice(...a)});this.state=this.broker.x;this.queue=[];this.tradeSeen=new Set();this.lastTradeSeq=null;this.processingQuote=null;
  // Keep persisted decisions, order contracts and liquidity consumption across restarts.
  // Old signals are never replayed; the wrapper evaluates only a new closed cutoff.
  this.state.last_cutoff=Math.max(this.state.last_cutoff??0,Math.floor(this.now()/300000)*300000);
  if(values(this.broker.a.positions).length||values(this.broker.a.pendingOrders).length)this.broker.gap('RESTART_GAP',this.now());
  for(const o of values(this.broker.a.pendingOrders))if(this.now()>=o.plan.expires_at)this.broker.cancel(o.plan.id,'RESTART_EXPIRED',this.now());
  return this;
 }
 connect(){
  if(this.stopped)return;const ws=this.socketFactory('wss://futures.kraken.com/ws/v1');this.ws=ws;
  ws.addEventListener('open',()=>{for(const feed of ['ticker','trade'])ws.send(JSON.stringify({event:'subscribe',feed,product_ids:[P.symbol]}));});
  const enqueue=e=>{if(this.queue.length>=2000){this.queue=[];this.overflow=true;}this.queue.push(e);};
  ws.addEventListener('message',event=>{try{
   const m=JSON.parse(event.data),now=this.now();if(m.product_id!==P.symbol)return;
   if(m.feed==='ticker'){
    const q={source:'KRAKEN_FUTURES_WS_TICKER',symbol:P.symbol,event_at:n(m.time),received_at:now,bid:String(m.bid),ask:String(m.ask),bid_qty:String(m.bid_size),ask_qty:String(m.ask_size),suspended:m.suspended===true,post_only:m.post_only===true};
    if(!secondaryFresh(q,now)||this.quote&&q.event_at<=this.quote.event_at)return;
    this.quote=q;const hour=Math.floor(q.event_at/3600000)*3600000;
    // The public perpetual ticker omits funding_rate when it is zero.
    // https://docs-legacy.kraken.com/api/docs/futures-api/websocket/ticker/
    if(m.funding_rate===undefined)this.rates[hour]=0;
    else if(m.funding_rate!==null&&Number.isFinite(n(m.funding_rate)))this.rates[hour]=n(m.funding_rate);
    this.predictedFunding=m.funding_rate_prediction!==undefined&&Number.isFinite(n(m.funding_rate_prediction))?n(m.funding_rate_prediction):null;
    enqueue({kind:'quote',q});
   }else if(m.feed==='trade'&&['fill','liquidation'].includes(m.type)&&typeof m.uid==='string'&&!this.tradeSeen.has(m.uid)){
    const t={id:m.uid,symbol:P.symbol,type:m.type,side:m.side,price:n(m.price),qty:n(m.qty),event_at:n(m.time),received_at:now,source:'KRAKEN_FUTURES_WS_TRADE'};
    if(!Number.isSafeInteger(t.event_at)||now-t.event_at>5000||t.event_at>now+1000||!['buy','sell'].includes(t.side)||![t.price,t.qty].every(x=>Number.isFinite(x)&&x>0))return;
    this.tradeSeen.add(m.uid);if(this.tradeSeen.size>5000)this.tradeSeen.delete(this.tradeSeen.values().next().value);enqueue({kind:'trade',t});
   }
  }catch{this.feedError='FUTURES_MESSAGE_INVALID';}});
  ws.addEventListener('error',()=>{this.feedError='FUTURES_WS_ERROR';});
  ws.addEventListener('close',()=>{this.disconnected=true;if(!this.stopped&&this.ws===ws)this.reconnect=setTimeout(()=>this.connect(),5000);});
 }
 async refresh(){
  await super.refresh();const now=this.now(),oldest=now-96*3600000,needed=new Set(),positions=values(this.broker?.a.positions);let firstUnaccruedHour=Infinity;
  const retain=intervals=>{for(const interval of intervals??[])if(Number.isSafeInteger(interval.hour))needed.add(String(interval.hour));};
  for(const p of positions){
   retain(p.funding_pending);retain(p.closed_funding_pending);
   // A restart can refresh historical rates before the first market tick has
   // materialised the position's unaccrued intervals. Keep that exposure too.
   const from=p.last_funding_at??p.entered_at;if(Number.isSafeInteger(from)&&from<now)firstUnaccruedHour=Math.min(firstUnaccruedHour,Math.floor(from/3600000)*3600000);
  }
  for(const row of values(this.state?.closed_funding_pending))retain(row.intervals);
  const currentHour=Math.floor(now/3600000)*3600000;
  for(const k of Object.keys(this.rates))if(n(k)<oldest&&!needed.has(k)&&!(n(k)>=firstUnaccruedHour&&n(k)<=currentHour))delete this.rates[k];
 }
 start(){this.stopped=false;void this.refresh();this.connect();this.timers.push(setInterval(()=>{void this.refresh();if(this.quote&&this.now()-this.quote.received_at>30000)this.ws?.close();},10000));}
 tick(){
  const now=this.now(),x=this.state,b=this.broker;
  if(this.overflow||this.disconnected){b.gap(this.overflow?'EVENT_QUEUE_GAP':'FUTURES_DISCONNECTED');this.overflow=false;this.disconnected=false;}
  for(const e of this.queue.splice(0)){if(e.kind==='quote')this.processingQuote=e.q;b.market(this.processingQuote,e.t??null,this.rates,now);}
  b.market(this.quote,null,this.rates,now);
  x.market={symbol:P.symbol,quote:this.quote,quote_at:this.quote?.event_at??null,last_refresh:this.lastRefresh??null,error:this.feedError??(!secondaryFresh(this.quote,now)?'FUTURES_DATA_NOT_FRESH':null),closed_at:Object.fromEntries([5,15].map(tf=>[tf,this.series[tf].at(-1)?.end??null]))};
  const cutoff=Math.floor(now/300000)*300000;if(cutoff<=x.last_cutoff||now-cutoff<2000)return;
  if(now-cutoff>30000){x.last_cutoff=cutoff;this.decision(cutoff,[{pattern:'ALL',reason:'EVALUATION_WINDOW_MISSED'}]);return;}
  if(!this.meta||now-this.meta.checked_at>3600000||this.feedError||!secondaryFresh(this.quote,now))return;
  const rate=this.rates[Math.floor(now/3600000)*3600000];
  if(!Number.isFinite(rate))return;
  const fundingRisk=Math.max(Math.abs(rate),Math.abs(this.predictedFunding??rate));
  const decisions=secondaryCandidates(this.series,this.quote,this.meta,cutoff,now,fundingRisk);if(decisions.some(d=>d.reason==='CONTEXT_NOT_SYNCHRONIZED'))return;
  x.last_cutoff=cutoff;
  for(const d of [...decisions].sort((a,b)=>(b.plan?.economics.netRR??-1)-(a.plan?.economics.netRR??-1))){if(d.plan){this.broker.f.counts.candidates++;d.reason=b.choose(d.plan,this.quote,this.meta,now);}}
  this.decision(cutoff,decisions);
 }
 decision(cutoff,decisions){
  const now=this.now();for(const d of decisions){
   if(d.plan){const stats=this.broker.stats(d.plan);if(stats)stats.signals++;}
   const out={at:now,cutoff,pattern:d.pattern,reason:d.reason,timeframe:5,context_timeframe:15,criteria:d.facts??{},version:SECONDARY_VERSION,entry_revision:d.plan?.entry_revision??d.facts?.entry_revision??null,signal_id:d.plan?.id??null,execution_mode:d.plan?.execution_contract?.mode??null};
   this.state.decisions[d.pattern]=out;this.state.counts.evaluations++;this.broker.f.counts.evaluations++;this.engine.event({type:'SECONDARY_PATTERN_EVALUATION',...out,ledger:'FREQUENT_PAPER'});
  }
  const selected=decisions.find(d=>d.reason==='ENTRY_PENDING')??decisions.find(d=>!d.reason.startsWith('WAIT_'))??decisions[0];this.broker.f.lastDecision={...this.state.decisions[selected.pattern],all_patterns:decisions.map(d=>({pattern:d.pattern,reason:d.reason}))};
 }
}
