import test from 'node:test';
import assert from 'node:assert/strict';
import {PROTOCOL,VERSION,closedBars,economics,evaluatePatterns,newStudy,enter,processQuote,closePosition,MultiPatternPaper,installMultiPattern} from '../lib/trading/multi-pattern-paper.js';
const NOW=Date.parse('2026-11-01T06:00:02Z'),HOUR=Math.floor(NOW/3600000)*3600000;
const quote=(now=NOW,p=100)=>({at:now,received_at:now,bid:p,ask:p+0.01,bid_qty:100,ask_qty:100,suspended:false});
const plan={id:'fixture',pattern:'BREAKOUT',direction:'LONG',entry:100,stop:99,target:103,confirmed_at:NOW-2000,holding_ms:900000,loss:1.12,gain:2.8,netRR:2.5};
const setup=()=>{const s=newStudy(500,NOW);return {s,a:s.accounts.BREAKOUT};};
test('independent shadow mirrors do not touch any legacy ledger or create a funding contribution',()=>{
 const original={frequency:{account:{equity:'470.45965144',net:'-30.27920229',fees:'21.61950282'}},laboratory:{status:'RESEARCH_COMPLETE'}};
 const before=structuredClone(original),events=[],engine={state:original,event:e=>events.push(e)};
 const r=new MultiPatternPaper({engine,now:()=>NOW}).initialize();assert.equal(r.state.mode,'SHADOW_PAPER');assert.equal(r.state.source_balance,470.45965144);assert.equal(events.length,1);
 const ms=original.multiStrategy;delete original.multiStrategy;assert.deepEqual(original,before);original.multiStrategy=ms;
 ms.accounts.BREAKOUT.cash=469;new MultiPatternPaper({engine,now:()=>NOW+1}).initialize();assert.equal(ms.accounts.BREAKOUT.cash,469);assert.equal(events.length,1);
});
test('unknown and real execution activation are rejected',()=>{
 assert.equal(installMultiPattern({},{}),null);
 for(const env of [{LUMI_TRADING_MULTI_PATTERN:VERSION,LUMI_TRADING_MODE:'LIVE',LUMI_TRADING_STORAGE:'SQLITE',LUMI_RUNTIME_ENV:'staging'},{LUMI_TRADING_MULTI_PATTERN:'unknown'}])assert.throws(()=>installMultiPattern({},env),/PAPER_ONLY/);
});
test('unfamiliar protocol cannot silently resume or reset a trial',()=>{
 const s={frequency:{account:{equity:'500'}},multiStrategy:newStudy(500,NOW)};s.multiStrategy.protocol.takerFee=0;
 assert.throws(()=>new MultiPatternPaper({engine:{state:s,event(){}},now:()=>NOW}).initialize(),/PROTOCOL_MISMATCH/);
});
test('open and invalid candles are excluded or rejected',()=>{
 const candle=t=>({time:t,open:'100',high:'101',low:'99',close:'100',volume:'1'}),start=NOW-2000;
 const rows=closedBars({candles:[candle(start-300000),candle(start)]},5,NOW);assert.equal(rows.length,1);assert.equal(rows[0].end,start);
 assert.throws(()=>closedBars({candles:[{...candle(start-300000),high:'90'}]},5,NOW));
 assert.throws(()=>closedBars({candles:[candle(start-300000),candle(start-300000)]},5,NOW));
});
test('empty histories fail closed for all three distinct hypotheses',()=>{
 const r=evaluatePatterns({},quote(),NOW-2000);assert.deepEqual(r.map(x=>x.pattern),PROTOCOL.patterns);assert(r.every(x=>x.reason==='CONTEXT_NOT_SYNCHRONIZED'));
});
test('cost gate is net of two taker fees, slippage and funding, for both directions',()=>{
 for(const sign of [1,-1]){const d=sign===1?'LONG':'SHORT',e=economics(100,100-sign,100+sign*3,d,0.1);assert(e.loss>1);assert(e.gain<3);assert(e.fundingAllowance===0.025);assert.equal(e.netRR,e.gain/e.loss);}
 assert(economics(100,99,100.05,'LONG').gain<0);
});
test('entry is bounded by actual top-of-book participation and risk',()=>{
 const {s,a}=setup(),q=quote();q.ask_qty=0.2;assert(enter(a,plan,q,{qty_step:0.0001},NOW));assert(a.position.qty<=0.01+1e-12);assert(a.position.qty*plan.loss<=2.5);assert(a.cash<500);assert.equal(a.closed,0);
 const b=s.accounts.PULLBACK;assert(!enter(b,plan,{...q,ask_qty:0.0001},{qty_step:0.0001},NOW));
});
test('stop, target, timeout and restart cannot duplicate a settlement',()=>{
 for(const [price,delay,reason] of [[98,1000,'STOP'],[104,1000,'TARGET'],[101,900000,'TIMEOUT']]){
  const {s,a}=setup();enter(a,plan,quote(),{qty_step:0.0001},NOW);s.last_quote_at=NOW+delay-1000;
  processQuote(s,quote(NOW+delay,price),{}, {[HOUR]:0},NOW+delay);assert.equal(a.closed,1);assert.equal(a.history[0].reason,reason);assert.equal(a.position,null);const cash=a.cash;
  processQuote(s,quote(NOW+delay,price),{}, {[HOUR]:0},NOW+delay);assert.equal(a.closed,1);assert.equal(a.cash,cash);assert(Math.abs(a.cash-500-a.net)<1e-7);
 }
});
test('stale data never produce an entry or an invented stop execution',()=>{
 const {s,a}=setup();enter(a,plan,quote(),{qty_step:0.0001},NOW);s.last_quote_at=NOW;
 processQuote(s,quote(NOW,100),{}, {[HOUR]:0},NOW+11000);assert(a.position.gap);assert.equal(a.closed,0);
 processQuote(s,quote(NOW+12000,101),{}, {[HOUR]:0},NOW+12000);assert.equal(a.history[0].reason,'DATA_GAP_CLOSE');assert(a.history[0].price>100);assert.notEqual(a.history[0].price,plan.stop);assert.equal(a.clean_closed,0);
});
test('signed funding is accrued and unknown funding is never treated as free',()=>{
 for(const [direction,expected] of [['LONG',1],['SHORT',-1]]){
  const {s,a}=setup();enter(a,{...plan,direction,stop:direction==='LONG'?99:101,target:direction==='LONG'?103:97},quote(),{qty_step:0.0001},NOW);s.last_quote_at=NOW+1000;
  processQuote(s,quote(NOW+2000,100),{}, {[HOUR]:0.2},NOW+2000);assert.equal(Math.sign(a.position.funding),expected);
 }
 const {s,a}=setup();enter(a,plan,quote(),{qty_step:0.0001},NOW);processQuote(s,quote(NOW+1000,100),{}, {},NOW+1000);assert.equal(a.clean_closed,0);assert.equal(a.history[0].quality,'FUNDING_GAP');assert(a.history[0].funding>0);
});
test('daily loss, drawdown and loss streak controls remain independent of daily trade count',()=>{
 const {a}=setup();a.day=new Date(NOW).toISOString().slice(0,10);a.day_start=500;a.cash=a.equity=480;assert(!enter(a,plan,quote(),{qty_step:0.0001},NOW));
 const x=setup().a;x.halted=true;assert(!enter(x,plan,quote(),{qty_step:0.0001},NOW));
 const y=setup().a;y.cooldown_until=NOW+60000;assert(!enter(y,plan,quote(),{qty_step:0.0001},NOW));
 const z=setup().a;z.closed=1200;assert(enter(z,plan,quote(),{qty_step:0.0001},NOW));
});
test('network adapter allows only the exact public market read endpoints',async()=>{
 const r=new MultiPatternPaper({engine:{},fetchImpl:()=>{throw Error('NO_NETWORK');}});
 await assert.rejects(r.read('/derivatives/api/v3/sendorder'),/PUBLIC_RESEARCH_ENDPOINT_ONLY/);
 await assert.rejects(r.read('https://other.test/'),/PUBLIC_RESEARCH_ENDPOINT_ONLY/);
});
test('future candle changes cannot alter the current decision',()=>{
 const cutoff=NOW-2000,bar=(tf,i)=>({start:Math.floor(cutoff/(tf*60000))*tf*60000-(100-i)*tf*60000,end:Math.floor(cutoff/(tf*60000))*tf*60000-(99-i)*tf*60000,open:100+i*0.1,high:100+i*0.1+0.08,low:100+i*0.1-0.08,close:100+i*0.1+0.04,volume:10});
 const series=Object.fromEntries([5,15].map(tf=>[tf,Array.from({length:100},(_,i)=>bar(tf,i))]));
 const before=evaluatePatterns(series,{...quote(),bid:109.9,ask:109.91},cutoff);
 for(const tf of [5,15])series[tf].push({...bar(tf,100),close:999999,high:999999});
 assert.deepEqual(evaluatePatterns(series,{...quote(),bid:109.9,ask:109.91},cutoff),before);
});
