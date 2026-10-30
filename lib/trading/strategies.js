import {strategyEvidence} from './chart-evidence.js';
import {H1,H4,M15,VERSION,hash,available,indicators,checkSeries,ceilTick,floorTick,POLICY} from './core.js';
const last=a=>a.at(-1);
export const BASE_RULES=Object.freeze({adxTrend:25,rvol:1.2});
export function context(h4,h1,rules=BASE_RULES){const c=last(h4),old=h4.at(-4),b=last(h1);if(!c||!old||!b)return {};
  return {long:c.close>c.ema200&&c.ema50>c.ema200&&c.ema50>old.ema50&&c.adx>=rules.adxTrend,short:c.close<c.ema200&&c.ema50<c.ema200&&c.ema50<old.ema50&&c.adx>=rules.adxTrend,breakLong:c.close>c.ema200&&c.ema50>=old.ema50,breakShort:c.close<c.ema200&&c.ema50<=old.ema50,range:c.adx<20&&b.adx<20&&Math.abs(c.ema50-old.ema50)/c.atr<.25};}
export const contextValid=(s,ctx)=>s.family==='C'?ctx.range:s.family==='A'?(s.direction==='LONG'?ctx.long:ctx.short):(s.direction==='LONG'?ctx.breakLong:ctx.breakShort);
export function newStrategyState(){return {setups:{},cooldowns:{},breakLocks:{},lastH1:0,lastCutoff:0};}
export function evaluate(state,series,cutoff,now,meta,{version=VERSION,rules=BASE_RULES}={}){
  const log=[],plans=[];
  if(cutoff<=state.lastCutoff)return {plans,log,reason:'ALREADY_EVALUATED'};
  const raw={};for(const [tf,ms,min] of [['15',M15,200],['60',H1,250],['240',H4,POLICY.warmup240]]){raw[tf]=available(series[tf]||[],cutoff,now);const error=checkSeries(raw[tf],ms,min);if(error)return {plans,log,reason:error+'_'+tf};if(last(raw[tf]).end!==Math.floor(cutoff/ms)*ms)return {plans,log,reason:'UNSYNCHRONIZED_'+tf};}
  const h4=indicators(raw['240']),h1=indicators(raw['60']),m15=indicators(raw['15']),ctx=context(h4,h1,rules),j=last(m15),t=last(h1),p=h1.at(-2);
  state.lastCutoff=cutoff;
  for(const [key,s] of Object.entries(state.setups)){
    if(j.end<=s.at)continue;
    const long=s.direction==='LONG',bars=m15.filter(b=>b.end>s.at&&b.end<=j.end);s.low=Math.min(s.low,+j.low);s.high=Math.max(s.high,+j.high);
    let invalid=!contextValid(s,ctx)||j.end>s.expires;
    if(s.family==='B')invalid ||=long?j.close<s.bound-.25*s.atr:j.close>s.bound+.25*s.atr;
    if(s.family==='C')invalid ||=j.low<s.lower-.75*s.atr||j.high>s.upper+.75*s.atr;
    if(invalid){log.push({type:'SETUP_CANCELLED',setup:s.id,reason:'REGIME_BOUNDARY_OR_TIMEOUT'});delete state.setups[key];state.cooldowns[key]=j.end+4*M15;continue;}
    let confirms=false;
    if(s.family==='A')confirms=long?j.close>Math.max(m15.at(-2).high,m15.at(-3).high)&&j.close>j.open:j.close<Math.min(m15.at(-2).low,m15.at(-3).low)&&j.close<j.open;
    if(s.family==='A')confirms &&=j.high>j.low&&Math.abs(j.close-j.open)/(j.high-j.low)>=.5;
    if(s.family==='B')confirms=long?j.low>=s.bound-.2*s.atr&&j.low<=s.bound+.2*s.atr&&j.close>s.bound&&j.close>j.open:j.high>=s.bound-.2*s.atr&&j.high<=s.bound+.2*s.atr&&j.close<s.bound&&j.close<j.open;
    if(s.family==='C')confirms=long?j.low<s.lower&&j.close>s.lower&&j.close<s.mid&&j.close>j.open&&Math.min(j.open,j.close)-j.low>=Math.abs(j.close-j.open):j.high>s.upper&&j.close<s.upper&&j.close>s.mid&&j.close<j.open&&j.high-Math.max(j.open,j.close)>=Math.abs(j.close-j.open);
    if(!confirms)continue;
    const roundEntry=long?ceilTick:floorTick,roundStop=long?floorTick:ceilTick;
    const entry=roundEntry(long?+j.high+ +meta.tick_size:+j.low- +meta.tick_size,meta.tick_size);
    const low=s.family==='C'?+j.low:s.low,high=s.family==='C'?+j.high:s.high;
    const stop=roundStop(long?low-.25*s.atr:high+.25*s.atr,meta.tick_size),distance=Math.abs(+entry-stop),min=s.family==='A'?.75:.5,max=s.family==='C'?2:3;
    const limit=(long?floorTick:ceilTick)(+entry+(long?1:-1)*.1*j.atr,meta.tick_size);
    const target=(long?floorTick:ceilTick)(s.family==='C'?s.mid:+entry+(long?2:-2)*distance,meta.tick_size);
    const plan={version,instrument:POLICY.instrument,timeframe:15,family:s.family,direction:s.direction,setup_id:s.id,confirmed_at:j.end,decision_at:now,entry,limit,stop,target,atr1:s.atr,H:s.family==='A'?32:s.family==='B'?24:16,expires_at:j.end+2*M15,trigger_source:'LAST',order:'SIMULATED_STOP_LIMIT',setup:s,criteria:['CLOSED_BARS','REGIME','SETUP','CONFIRMATION'],factors:['EXPERIMENTAL','UNVALIDATED_EXECUTION_MODEL','TAKER_COSTS_BOTH_SIDES'],input_hash:hash(raw),context:ctx};
    plan.evidence=strategyEvidence(plan,{m15,h1,h4,ctx,rules});
    plan.id=hash([version,s.id,j.end]);plan.hash=hash(plan);
    log.push({type:'CANDIDATE',plan,inputs:raw});
    if(distance<min*s.atr||distance>max*s.atr||!(j.atr>0))log.push({type:'SUPPRESSED',id:plan.id,reason:'STOP_DISTANCE'});else plans.push(plan);
    delete state.setups[key];state.cooldowns[key]=j.end+4*M15;
  }
  // Only create configurations on their first available hourly close. Never
  // synthesize a configuration from an earlier hour after a reconnect.
  if(t.end===cutoff&&state.lastH1!==t.end){
    state.lastH1=t.end;
    for(const direction of ['LONG','SHORT'])for(const family of ['A','B','C']){
      const key=family+direction,long=direction==='LONG';if(state.setups[key]||(state.cooldowns[key]||0)>cutoff)continue;
      let valid=false,extra={},atr=t.atr;
      if(family==='A')valid=(long?ctx.long:ctx.short)&&t.low<=p.ema20+.25*p.atr&&t.high>=p.ema20-.25*p.atr&&(long?t.ema20>t.ema50&&t.close>t.ema20&&t.low>t.ema50-.5*t.atr:t.ema20<t.ema50&&t.close<t.ema20&&t.high<t.ema50+.5*t.atr);
      if(family==='B'){
        const lock=state.breakLocks[key];if(lock&&t.close>=lock.D&&t.close<=lock.U&&cutoff>=lock.at+4*M15)delete state.breakLocks[key];
        const prior=h1.slice(-21,-1),U=Math.max(...prior.map(b=>+b.high)),D=Math.min(...prior.map(b=>+b.low)),W=U-D;atr=p.atr;
        valid=!state.breakLocks[key]&&W>=2*atr&&W<=8*atr&&t.rvol>=rules.rvol&&(long?ctx.breakLong&&t.close>U+.1*atr&&p.close<=U:ctx.breakShort&&t.close<D-.1*atr&&p.close>=D);extra={bound:long?U:D,U,D};
        if(valid)state.breakLocks[key]={U,D,at:cutoff};
      }
      if(family==='C'){valid=ctx.range;extra={lower:t.lower,mid:t.mid,upper:t.upper};}
      if(!valid||!(atr>0))continue;
      const six=h1.slice(-6),s={id:hash([version,family,direction,t.end]),family,direction,at:t.end,expires:t.end+(family==='B'?8:4)*M15,atr,low:family==='A'?Math.min(...six.map(b=>+b.low)):Number.MAX_VALUE,high:family==='A'?Math.max(...six.map(b=>+b.high)):0,...extra};
      s.origin_facts=[{label:"Creación del patrón UTC",value:new Date(cutoff).toISOString()},{label:"EMA 20 previa 1 h",value:p.ema20},{label:"ATR previo 1 h",value:p.atr},{label:"Volumen relativo 1 h al crear patrón",value:t.rvol},{label:"Cierre 1 h del patrón",value:+t.close}];
      state.setups[key]=s;log.push({type:'SETUP',setup:s});
    }
  }
  return {plans:plans.sort((a,b)=>a.family.localeCompare(b.family)||a.direction.localeCompare(b.direction)),log,context:{...ctx,last15:{close:+j.close,low:+j.low,high:+j.high,at:j.end}},reason:plans.length?'CANDIDATES':'SIN_OPORTUNIDAD_VALIDA'};
}
