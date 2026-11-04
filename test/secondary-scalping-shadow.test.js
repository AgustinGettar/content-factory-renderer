import test from 'node:test';
import assert from 'node:assert/strict';
import {observeSecondaryScalpingShadow as observe,SECONDARY_SCALPING_SHADOW_PROTOCOL as P} from '../lib/trading/secondary-scalping-shadow.js';
const TF=300000,CUT=1200*TF,NOW=CUT+3000;
const bars=(count=100,dir='LONG')=>Array.from({length:count},(_,i)=>{
 const end=CUT-(count-i-1)*TF,base=dir==='LONG'?80000+i*4:82000-i*4;
 return {start:end-TF,end,open:base-5,close:base+5,high:base+55,low:base-55,volume:100,available_at:end};
});
function fixture(direction='LONG') {
 const series=bars(120,direction),long=direction==='LONG';
 series.at(-2).low=long?80000:81900;
 series.at(-2).high=long?80800:82400;
 series.at(-2).close=long?80300:81800;
 series.at(-1).open=long?80350:81750;
 series.at(-1).close=long?80400:81700;
 series.at(-1).low=long?80340:81650;
 series.at(-1).high=long?80430:81780;
 const center=long?80400:81700,quote={source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',
  event_at:CUT+2500,received_at:CUT+2501,bid:String(center-.5),ask:String(center+.5),bid_qty:'20',ask_qty:'20',suspended:false};
 const regime={regime:long?'UPTREND':'DOWNTREND',timeframe:5,cutoff:CUT,advisory_only:true,
  features:{atr14:400,ema9:long?80380:81720,ema21:long?80300:81800,relative_volume20:1.2}};
 const contextRegime={regime:long?'UPTREND':'DOWNTREND',timeframe:15,cutoff:CUT,advisory_only:true};
 return {series,quote,regime,contextRegime,fundingRate:0,cutoff:CUT,now:NOW};
}
test('long confirmation yields a hypothetical signal without any execution authority',()=>{
 const x=observe(fixture('LONG'));
 assert.equal(x.status,'CANDIDATE');assert.equal(x.direction,'LONG');
 assert.equal(x.market_order_allowed,false);assert.equal(x.submitted_orders,0);
 assert.equal(x.capital_reserved_usd,0);assert.equal(x.realTrading,false);
 assert(x.hypothetical_net_target_usd>=x.minimum_expected_net_usd);
 assert(x.hypothetical_net_rr>=P.minimum_net_rr);
 assert(!Object.hasOwn(x,'plan'));assert(!Object.hasOwn(x,'order'));
});
test('short trend is treated symmetrically, never spot direction',()=>{
 const x=observe(fixture('SHORT'));
 assert.equal(x.direction,'SHORT');assert.equal(x.status,'CANDIDATE');
 assert(x.hypothetical_target<x.hypothetical_entry);
});
test('no context, stale quote and unknown funding fail closed',()=>{
 const x=fixture();assert.equal(observe({...x,contextRegime:null}).reason,'MISSING_CONTEXT_REGIME');
 assert.equal(observe({...x,contextRegime:{...x.contextRegime,regime:'DOWNTREND'}}).reason,'CONTEXT_NOT_ALIGNED');
 assert.equal(observe({...x,quote:{...x.quote,event_at:CUT-20000}}).reason,'FUTURES_QUOTE_NOT_FRESH');
 assert.equal(observe({...x,fundingRate:null}).reason,'FUNDING_UNKNOWN');
});
test('a future/open bar cannot contaminate current signal',()=>{
 const x=fixture();const future={...x.series.at(-1),start:CUT,end:CUT+TF,high:10000000};
 assert.equal(observe({...x,series:[...x.series,future]}).reason,'CLOSED_HISTORY_NOT_SYNCHRONIZED');
 assert.equal(observe({...x,regime:{...x.regime,cutoff:CUT+TF}}).reason,'MISSING_CURRENT_REGIME');
});
test('missing confirmation, nontrend and wide spread produce auditable WAIT',()=>{
 const x=fixture();
 assert.equal(observe({...x,regime:{...x.regime,regime:'RANGE'}}).reason,'NO_CONFIRMED_5M_TREND');
 const bad=structuredClone(x);bad.series.at(-2).low=80395;bad.series.at(-1).close=80370;
 assert.equal(observe(bad).reason,'WAIT_PULLBACK_CONFIRMATION');
 const spread=structuredClone(x);spread.quote.bid='80300';spread.quote.ask='80400';
 assert.equal(observe(spread).reason,'SPREAD_TOO_WIDE');
});
test('an expensive short-range opportunity is rejected without suggesting leverage',()=>{
 const x=fixture(),poor={...x,regime:{...x.regime,features:{...x.regime.features,atr14:120}}};
 const o=observe(poor);
 assert(['INVALID_STOP_DISTANCE','NO_NET_ECONOMIC_ADVANTAGE'].includes(o.reason));
 assert.equal(o.execution_eligible,false);
 assert.equal(o.capital_reserved_usd,0);
});
test('no input is mutated by the observer',()=>{
 const x=fixture(),copy=structuredClone(x);observe(x);assert.deepEqual(x,copy);
});
