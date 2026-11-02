import test from 'node:test';
import assert from 'node:assert/strict';
import {projectSecondaryActivity,ACTIVITY_VIEW_VERSION} from '../lib/trading/secondary-monitor-activity.js';
const NOW=Date.parse('2026-11-02T00:27:24Z'),CUT=Date.parse('2026-11-02T00:25:00Z'),AT=CUT+7661;
const patterns=['BREAKOUT','PULLBACK','RANGE_REENTRY'];
function fixture(){
 const x={version:'secondary-futures-1.0.0',activated_at:NOW-7200000,status:'ACTIVE_PAPER',protocol:{entryMinutes:5,contextMinutes:15,symbol:'PF_XBTUSD',patterns},counts:{evaluations:60,selected:0,filled:0,closed:0},
  decisions:Object.fromEntries(patterns.map((pattern,i)=>[pattern,{at:AT,cutoff:CUT,pattern,timeframe:5,reason:'WAIT_'+pattern,criteria:{atr15:162.3,blocked_by:['CHANNEL_NOT_BROKEN','CONTEXT_NOT_CONFIRMED','BAND_REENTRY_NOT_CONFIRMED'][i]}}])),
  market:{last_refresh:NOW-1000,closed_at:{5:CUT,15:Date.parse('2026-11-02T00:15:00Z')}}};
 const s={secondaryExecution:x,frequency:{account:{cash:'470.4596514385377772',net:'-30.2792022853160724',closed:12},lastDecision:x.decisions.BREAKOUT}};
 const legacy={version:'old-rejected',status:'REJECTED',closed:5,net:-24.499,diagnostics:{1:{evaluations:1434}},decisions:{1:{at:NOW-86400000}},frames:{1:{closed:2,net:-8.47}}};
 const d={revision:88875,account:{cash:'100',net:'0'},frequency:{account:structuredClone(s.frequency.account),lastDecision:s.frequency.lastDecision},
  timeframes:{frames:[1,15,60,240],series:Object.fromEntries([1,15,60,240].map(tf=>[tf,{bars:720,last_closed_at:CUT}]))},
  laboratory:{active:x.version,trials:[legacy,{version:x.version,recipe:{tf:5,timeframes:[5,15]},decisions:x.decisions,closed:0,net:0}]},evaluations:[{at:NOW-1000,reason:'PRIMARY',timeframe:15}]};
 const inventory={5:{bars:256,last_closed_at:CUT},15:{bars:256,last_closed_at:x.market.closed_at[15]}};
 return {s,d,inventory};
}
test('screenshot regression: real pattern decisions populate numeric timeframe cards rather than zero and dash',()=>{
 const {s,d,inventory}=fixture();const active=d.laboratory.trials[1];assert.equal(active.decisions[5],undefined);assert.equal(active.diagnostics,undefined);
 const out=projectSecondaryActivity(d,s,NOW,inventory),t=out.laboratory.trials[1];
 assert.equal(t.decisions[5].at,AT);assert.equal(t.diagnostics[5].evaluations,60);assert.equal(out.frequency.lastDecision.at,AT);
 assert.equal(out.secondary_activity.last_evaluation_at,AT);assert.equal(out.secondary_activity.revision,88875);assert.equal(out.secondary_activity.status,'EVALUATING');
 assert.equal(out.secondary_activity.count_unit,'PATTERN_CHECKS_NOT_CANDLES');assert.equal(out.secondary_activity.selected,0);assert.equal(out.secondary_activity.filled,0);
 assert.match(t.decisions[5].reason_text,/canal/);
});
test('15m is a context use, never a fictitious independent entry evaluation',()=>{
 const {s,d,inventory}=fixture();const out=projectSecondaryActivity(d,s,NOW,inventory),t=out.laboratory.trials[1];
 assert.equal(t.decisions[15].at,AT);assert.equal(t.decisions[15].role,'CONTEXT');assert.equal(t.decisions[15].entry_enabled,false);
 assert.match(t.decisions[15].reason,/no abre operaciones/);assert.equal(t.diagnostics[15].evaluations,0);assert.equal(t.frames[15].net,null);
 assert.equal(out.timeframes.series[15].source,'KRAKEN_FUTURES');assert.equal(out.primary_timeframes.series[15].bars,720);
});
test('old chart periods and archived outcomes survive without claiming that the old engines are evaluating',()=>{
 const {s,d,inventory}=fixture(),legacy=structuredClone(d.laboratory.trials[0]);const out=projectSecondaryActivity(d,s,NOW,inventory);
 assert.deepEqual(out.timeframes.frames,[1,5,15,60,240]);assert.deepEqual(out.timeframes.entry_frames,[5]);
 for(const tf of [1,60,240]){const v=out.laboratory.trials[1].decisions[tf];assert.equal(v.at,null);assert.equal(v.entry_enabled,false);assert.match(v.reason,/configuración anterior/);assert.equal(out.timeframes.series[tf].bars,720);}
 assert.deepEqual(out.laboratory.trials[0],legacy);
});
test('projection never mutates the source state, primary balances, old trials or primary evaluation feed',()=>{
 const {s,d,inventory}=fixture(),state=structuredClone(s),primary=structuredClone(d.account),account=structuredClone(d.frequency.account),evals=structuredClone(d.evaluations);
 projectSecondaryActivity(d,s,NOW,inventory);assert.deepEqual(s,state);assert.deepEqual(d.account,primary);assert.deepEqual(d.frequency.account,account);assert.deepEqual(d.evaluations,evals);
});
test('stale decisions retain their original timestamp; no heartbeat can manufacture a recent evaluation',()=>{
 const {s,d,inventory}=fixture();const out=projectSecondaryActivity(d,s,NOW+600000,inventory);
 assert.equal(out.secondary_activity.status,'EVALUATION_STALE');assert.equal(out.secondary_activity.last_evaluation_at,AT);assert(out.secondary_activity.stale);
});
test('startup and missing context do not become fake zero-profit successes or clock-time evaluations',()=>{
 const {s,d}=fixture();s.secondaryExecution.decisions={};s.secondaryExecution.counts={};
 const out=projectSecondaryActivity(d,s,NOW);assert.equal(out.secondary_activity.last_evaluation_at,null);assert.equal(out.secondary_activity.pattern_evaluations,null);
 assert.equal(out.secondary_activity.status,'WAITING_FIRST_EVALUATION');assert.equal(out.laboratory.trials[1].decisions[15],undefined);
 assert.equal(out.timeframes.series[5].bars,null);
});
test('skipped window does not claim a newly read context, and a later market close is not used retrospectively',()=>{
 const {s,d,inventory}=fixture();s.secondaryExecution.decisions.ALL={at:NOW,cutoff:NOW-500,reason:'EVALUATION_WINDOW_MISSED'};s.secondaryExecution.market.closed_at[15]=NOW;
 const out=projectSecondaryActivity(d,s,NOW,inventory),ctx=out.laboratory.trials[1].decisions[15];
 assert.equal(ctx.at,AT);assert.equal(ctx.context_close_at,Date.parse('2026-11-02T00:15:00Z'));assert.equal(out.timeframes.series[15].bars,null);
});
test('idempotent projection does not erase primary metadata or duplicate history',()=>{
 const {s,d,inventory}=fixture();projectSecondaryActivity(d,s,NOW,inventory);const once=structuredClone(d);projectSecondaryActivity(d,s,NOW,inventory);assert.deepEqual(d,once);
});
test('non-operational worker retains the original projection unchanged',()=>{
 const {d}=fixture(),before=structuredClone(d);projectSecondaryActivity(d,{},NOW);assert.deepEqual(d,before);
});
