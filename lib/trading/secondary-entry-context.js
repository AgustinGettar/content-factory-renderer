// Causal entry rules only. Execution, capital, costs and exit controls stay in the existing broker.
import {D,hash} from './core.js';
import {SECONDARY_PROTOCOL as P,SECONDARY_VERSION,SECONDARY_MODEL,secondaryFresh} from './secondary-futures-math.js';
import {secondaryEconomics} from './secondary-futures-engine.js';
export const ENTRY_REVISION='secondary-entry-context-1.1.0';
export const ENTRY_RULES=Object.freeze({version:ENTRY_REVISION,closedFrames:[5,15],channelBars:8,volumeRatio:1.15,breakoutCloseLocation:0.75,minBreakoutBody:0.5,transitionBreakATR:0.1,strongContextEfficiency:0.35,allowSameCandleRecovery:true,minNetRR:1.5,executionProtocolUnchanged:true,realTrading:false});
const n=Number,mean=v=>v.reduce((a,b)=>a+b,0)/v.length;
const ema=(b,k)=>{let v=mean(b.slice(0,k).map(x=>n(x.close)));for(const x of b.slice(k))v+=(n(x.close)-v)*2/(k+1);return v;};
const atr=b=>mean(b.slice(-14).map((x,i)=>{const p=n(b[b.length-15+i].close);return Math.max(n(x.high)-n(x.low),Math.abs(n(x.high)-p),Math.abs(n(x.low)-p));}));
const round=(x,t,up=false)=>D(x).div(t)[up?'ceil':'floor']().mul(t).toNumber();
function valid(b,tf,cutoff){return b.length>=64&&b.at(-1).end===Math.floor(cutoff/(tf*60000))*tf*60000&&b.every((x,i)=>Number.isSafeInteger(x.start)&&x.end-x.start===tf*60000&&(!i||x.start===b[i-1].end)&&['open','high','low','close','volume'].every(k=>Number.isFinite(n(x[k])))&&n(x.volume)>=0&&n(x.low)>0&&n(x.low)<=Math.min(n(x.open),n(x.close))&&n(x.high)>=Math.max(n(x.open),n(x.close)));}
export function entryCandidates(series,q,meta,cutoff,now,rate){
 const reject=reason=>P.patterns.map(pattern=>({pattern,reason,facts:{entry_revision:ENTRY_REVISION}}));
 if(!secondaryFresh(q,now)||q.symbol!==P.symbol)return reject('FUTURES_DATA_NOT_FRESH');
 if(!Number.isFinite(rate))return reject('FUNDING_NOT_AVAILABLE');
 if(!meta||!Number.isFinite(meta.tick_size)||!(meta.tick_size>0))return reject('INSTRUMENT_METADATA_INVALID');
 const b=(series[5]??[]).filter(x=>x.end<=cutoff&&(!x.available_at||x.available_at<=now)).slice(-256),c=(series[15]??[]).filter(x=>x.end<=cutoff&&(!x.available_at||x.available_at<=now)).slice(-256);
 if(!valid(b,5,cutoff)||!valid(c,15,cutoff))return reject('CONTEXT_NOT_SYNCHRONIZED');
 const a=atr(b),ca=atr(c);if(!(a>0&&ca>0))return reject('VOLATILITY_INVALID');
 const f15=ema(c,20),s15=ema(c,50),slope15=f15-ema(c.slice(0,-3),20),up=f15>s15&&slope15>0&&f15-s15>=.35*ca,down=f15<s15&&slope15<0&&s15-f15>=.35*ca;
 const er=Math.abs(n(c.at(-1).close)-n(c.at(-21).close))/Math.max(1e-12,c.slice(-20).reduce((s,x,i)=>s+Math.abs(n(x.close)-n(c[c.length-21+i].close)),0));
 const strongUp=up&&er>=ENTRY_RULES.strongContextEfficiency&&n(c.at(-1).close)>s15,strongDown=down&&er>=ENTRY_RULES.strongContextEfficiency&&n(c.at(-1).close)<s15;
 const range=!up&&!down&&er<=.28&&Math.abs(f15-s15)<=.6*ca,p=b.slice(0,-1),last=b.at(-1),prev=b.at(-2),f5=ema(b,9),s5=ema(b,21),prior9=ema(p,9),slope5=f5-ema(b.slice(0,-3),9),microUp=f5>s5&&slope5>0&&n(last.close)>f5,microDown=f5<s5&&slope5<0&&n(last.close)<f5;
 const hi=Math.max(...p.slice(-8).map(x=>n(x.high))),lo=Math.min(...p.slice(-8).map(x=>n(x.low))),vavg=mean(p.slice(-20).map(x=>n(x.volume))),rvol=vavg>0?n(last.volume)/vavg:0,span=n(last.high)-n(last.low),body=span>0?(n(last.close)-n(last.open))/span:0;
 const center=mean(p.slice(-20).map(x=>n(x.close))),sd=Math.sqrt(mean(p.slice(-20).map(x=>(n(x.close)-center)**2))),prevWindow=p.slice(0,-1).slice(-20),prevCenter=mean(prevWindow.map(x=>n(x.close))),prevSD=Math.sqrt(mean(prevWindow.map(x=>(n(x.close)-prevCenter)**2)));
 const common={entry_revision:ENTRY_REVISION,atr5:a,atr15:ca,efficiency15:er,regime:up?'UP':down?'DOWN':range?'RANGE':'NEUTRAL',fast15:f15,slow15:s15,fast5:f5,slow5:s5,strong_up:strongUp,strong_down:strongDown,relative_volume:rvol,body_fraction:Math.abs(body)};
 return P.patterns.map(pattern=>{
  let direction=null,anchor=null,trigger=null,blocked='NO_CONFIRMATION';
  if(pattern==='BREAKOUT'){
   const longShape=n(last.close)>hi&&body>0&&span>0&&n(last.close)>=n(last.low)+.75*span&&rvol>=ENTRY_RULES.volumeRatio;
   const shortShape=n(last.close)<lo&&body<0&&span>0&&n(last.close)<=n(last.low)+.25*span&&rvol>=ENTRY_RULES.volumeRatio;
   const transitionLong=microUp&&!strongDown&&body>=ENTRY_RULES.minBreakoutBody&&n(last.close)>hi+.1*a;
   const transitionShort=microDown&&!strongUp&&body<=-ENTRY_RULES.minBreakoutBody&&n(last.close)<lo-.1*a;
   if(longShape&&(up||transitionLong)){direction='LONG';anchor=hi;trigger=up?'TREND_BREAKOUT':'RANGE_TRANSITION_BREAKOUT';}
   if(shortShape&&(down||transitionShort)){direction='SHORT';anchor=lo;trigger=down?'TREND_BREAKOUT':'RANGE_TRANSITION_BREAKOUT';}
   blocked=longShape||shortShape?'CONTEXT_NOT_CONFIRMED':n(last.close)>hi||n(last.close)<lo?'VOLUME_OR_CANDLE_CONFIRMATION':'CHANNEL_NOT_BROKEN';
  }else if(pattern==='PULLBACK'){
   const contextLong=up||(microUp&&!strongDown&&n(last.close)>f15&&slope15>=0),contextShort=down||(microDown&&!strongUp&&n(last.close)<f15&&slope15<=0);
   const priorLong=n(prev.low)<=prior9&&n(last.close)>n(prev.close),priorShort=n(prev.high)>=prior9&&n(last.close)<n(prev.close);
   const wickLong=n(last.low)<=prior9&&n(last.close)>prior9&&n(last.close)>n(prev.close),wickShort=n(last.high)>=prior9&&n(last.close)<prior9&&n(last.close)<n(prev.close);
   if(contextLong&&n(last.close)>f5&&body>0&&(priorLong||wickLong)){direction='LONG';anchor=f5;trigger=priorLong?'PRIOR_CANDLE_PULLBACK':'SAME_CANDLE_PULLBACK';}
   if(contextShort&&n(last.close)<f5&&body<0&&(priorShort||wickShort)){direction='SHORT';anchor=f5;trigger=priorShort?'PRIOR_CANDLE_PULLBACK':'SAME_CANDLE_PULLBACK';}
   blocked=!contextLong&&!contextShort?'CONTEXT_NOT_CONFIRMED':'PULLBACK_NOT_CONFIRMED';
  }else if(pattern==='RANGE_REENTRY'&&range&&sd>0){
   const lower=center-2*sd,upper=center+2*sd,priorLow=n(prev.close)<prevCenter-2*prevSD,priorHigh=n(prev.close)>prevCenter+2*prevSD;
   const wickLow=n(last.low)<lower&&n(last.close)>lower&&Math.min(n(last.open),n(last.close))-n(last.low)>=Math.abs(n(last.close)-n(last.open));
   const wickHigh=n(last.high)>upper&&n(last.close)<upper&&n(last.high)-Math.max(n(last.open),n(last.close))>=Math.abs(n(last.close)-n(last.open));
   if((priorLow||wickLow)&&n(last.close)>=lower&&n(last.close)<center&&body>0){direction='LONG';anchor=lower;trigger=priorLow?'PRIOR_CANDLE_REENTRY':'WICK_REENTRY';}
   if((priorHigh||wickHigh)&&n(last.close)<=upper&&n(last.close)>center&&body<0){direction='SHORT';anchor=upper;trigger=priorHigh?'PRIOR_CANDLE_REENTRY':'WICK_REENTRY';}
   blocked='BAND_REENTRY_NOT_CONFIRMED';
  }else if(pattern==='RANGE_REENTRY')blocked='NOT_A_RANGE';
  const facts={...common,blocked_by:direction?null:blocked,trigger};
  if(!direction)return {pattern,reason:'WAIT_'+pattern,facts};
  const short=direction==='SHORT',sign=short?-1:1,tick=meta.tick_size,entry=round(short?Math.max(n(q.ask),anchor):Math.min(n(q.bid),anchor),tick,short),local=b.slice(-3),stop=round(short?Math.max(...local.map(x=>n(x.high)))+.1*a:Math.min(...local.map(x=>n(x.low)))-.1*a,tick,short),distance=sign*(entry-stop),improvement=sign*((short?n(q.ask):n(q.bid))-entry);
  if(distance<.5*a||distance>2.5*a||improvement>1.5*a)return {pattern,reason:'STRUCTURAL_ENTRY_DISTANCE',facts:{...facts,entry,stop,stop_atr:distance/a,entry_distance_atr:improvement/a}};
  let target=pattern==='RANGE_REENTRY'?center:n(last.close)+sign*3*a;
  if(pattern==='PULLBACK'){const structure=short?Math.min(...p.slice(-20).map(x=>n(x.low))):Math.max(...p.slice(-20).map(x=>n(x.high)));if(sign*(structure-entry)>0)target=short?Math.max(target,structure):Math.min(target,structure);}
  target=round(target,tick,short);
  const move=sign*(target-entry)/entry,econ=secondaryEconomics(entry,stop,target,direction,rate),detail={...facts,...econ,entry,stop,target,requiredMovePct:move*100,entryImprovementUSD:improvement};
  if(!(entry>0&&stop>0&&target>0&&move>0&&move<=P.maxTargetMove))return {pattern,reason:'TARGET_OUTSIDE_SHORT_HORIZON',facts:detail};
  if(!(econ.gain>0&&econ.loss>0&&econ.netRR>=P.minNetRR))return {pattern,reason:'COST_OR_NET_RR',facts:detail};
  const titles={BREAKOUT:'Ruptura y retesteo',PULLBACK:'Retroceso en tendencia',RANGE_REENTRY:'Reentrada en rango'};
  const plan={id:hash([SECONDARY_VERSION,ENTRY_REVISION,pattern,cutoff]),version:SECONDARY_VERSION,entry_revision:ENTRY_REVISION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',family:'L',pattern,recipe:pattern,recipe_title:'PF_XBTUSD · '+titles[pattern],direction,timeframe:5,entry:String(entry),limit:String(entry),stop:String(stop),target:String(target),confirmed_at:cutoff,decision_at:now,expires_at:now+P.entryExpiryMs,holding_ms:P.holdingMs,order:'FUTURES_POST_ONLY_LIMIT',fill_model:'OBSERVED_TRADE_THROUGH_20X',criteria:['CLOSED_5M','CLOSED_15M_CONTEXT',trigger,'STRUCTURAL_LIMIT_ENTRY','NET_RR_1_5'],context:{symbol:P.symbol,stopTf:5,targetTf:5,holdingMs:P.holdingMs},economics:econ,experiment:true,study:{prediction:{status:'UNAVAILABLE',event:'NET_POSITIVE_AT_CLOSE'}}};
  plan.evidence={schema:1,at:now,default_tf:5,closed_bars:true,input_hash:hash({b,c}),panels:[{tf:5,candles:b.slice(-80),lines:[]},{tf:15,candles:c.slice(-80),lines:[]}],levels:[{name:'Nivel de entrada observado',value:anchor}],facts:Object.entries(detail).map(([label,value])=>({label,value})),rules:['Datos del contrato PF_XBTUSD; solo velas cerradas de 5 y 15 minutos.','La ruptura permite transición desde rango, con volumen y confirmación de 5 min; no contra un contexto fuerte.','Retrocesos y reentradas pueden confirmarse dentro de una misma vela; se conserva el stop estructural.','Orden límite pasiva: una operación posterior debe atravesar el límite con veinte veces la cantidad.','Costes y financiación incluidos; beneficio/riesgo mínimo 1,5 y riesgo compartido sin aumentar.','Stop, objetivo neto o salida por tiempo a 30 minutos. Hipótesis experimental, no rentabilidad validada.']};
  return {pattern,reason:'CANDIDATE',facts:detail,plan};
 });
}
export function installEntryRevision(root,now,event=()=>{}){
 const x=root.secondaryExecution;if(!x)throw Error('SECONDARY_EXECUTION_REQUIRED');
 const fingerprint=hash(ENTRY_RULES);
 if(x.entry_rules){if(x.entry_rules.hash!==fingerprint||hash(x.entry_rules.protocol)!==fingerprint)throw Error('SECONDARY_ENTRY_RULES_MISMATCH');return false;}
 x.entry_rules={version:ENTRY_REVISION,hash:fingerprint,protocol:structuredClone(ENTRY_RULES),activated_at:now};
 event({type:'SECONDARY_ENTRY_RULES_ENABLED',at:now,version:SECONDARY_VERSION,entry_revision:ENTRY_REVISION,protocol_hash:fingerprint,previous:'secondary-futures-1.0.0-original-entry-rules',capital_added:'0',risk_limits_changed:false,ledger:'FREQUENT_PAPER',realTrading:false});return true;
}
