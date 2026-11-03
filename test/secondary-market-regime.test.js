import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySecondaryMarketRegime as classify, SECONDARY_MARKET_REGIME_VERSION} from '../lib/trading/secondary-market-regime.js';
const TF=15, STEP=TF*60000, CUT=300*STEP;
function bars({count=220, base=80000, slope=0, swing=8, volume=100}={}) {
 return Array.from({length:count},(_,i)=>{const close=base+slope*i+Math.sin(i/4)*swing;
  const end=CUT-(count-1-i)*STEP;
  return {start:end-STEP,end,open:close-5,high:close+30,low:close-30,close,volume,available_at:CUT};});
}
const run=(data, extra={})=>classify(data,{timeframe:TF,cutoff:CUT,now:CUT+2000,...extra});
test('closed causal trends retain frame, versions and no trading authority',()=>{
 const r=run(bars({slope:45}));
 assert.equal(r.version,SECONDARY_MARKET_REGIME_VERSION);
 assert.equal(r.advisory_only,true);assert.equal(r.statistically_validated,false);
 assert.equal(r.regime,'UPTREND');assert.equal(r.direction,'UP');
 assert.equal(r.sample_bars,220);assert(r.features.ema200>0);
 const down=run(bars({slope:-45}));assert.equal(down.regime,'DOWNTREND');
});
test('an open or future-available candle cannot contaminate an existing classification',()=>{
 const original=bars({slope:45}), a=run(original);
 const future={...original.at(-1),start:CUT,end:CUT+STEP,open:9e6,high:9e6,low:9e6,close:9e6,available_at:CUT};
 assert.deepEqual(run([...original,future]),a);
 const late={...original.at(-1),close:9e6,high:9e6,available_at:CUT+5000};
 assert.equal(run([...original.slice(0,-1),late]).regime,'UNKNOWN');
});
test('stale, gapped and insufficient histories fail closed',()=>{
 assert.equal(run(bars({count:63})).reason,'CLOSED_HISTORY_NOT_SYNCHRONIZED');
 assert.equal(run(bars().slice(0,-1)).reason,'CLOSED_HISTORY_NOT_SYNCHRONIZED');
 const broken=bars();broken[140]={...broken[140],start:broken[140].start+1};
 assert.equal(run(broken).reason,'INVALID_CLOSED_HISTORY');
 assert.equal(run(bars(),{timeframe:1}).reason,'INVALID_CLOCK');
});
test('observed excessive spread flags illiquidity without inventing execution',()=>{
 const x=run(bars({slope:45}),{quote:{symbol:'PF_XBTUSD',event_at:CUT+1000,bid:'80000',ask:'80080'}});
 assert.equal(x.regime,'ILLIQUID');assert(x.features.observed_spread_bps>8);
 const stale=run(bars({slope:45}),{quote:{symbol:'PF_XBTUSD',event_at:CUT-10000,bid:'80000',ask:'80080'}});
 assert.equal(stale.features.observed_spread_bps,null);
});
test('zero volume produces no invented VWAP or volume ratio',()=>{
 const x=run(bars({volume:0}));assert.equal(x.features.vwap20,null);assert.equal(x.features.relative_volume20,null);
});
