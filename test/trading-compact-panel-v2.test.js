import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {viewModel,fmtUSD,reasonText,regimeText,escapeHTML} from '../deploy/trading/compact-panel/model.js';
const T=1793755800000;
const sample=()=>({
 revision:147693,generated_at:T,updated_at:new Date(T).toISOString(),
 secondary_finances:{ledger:'FREQUENT_PAPER',mode:'PAPER',equity:'992',available_cash:'970',
  realized_net:'-7.50',unrealized_net:'0.41',realized_result_final:true,
  net_result_final:true,total_net:'-7.09',costs_recorded:'4.99',valuation_quality:'CURRENT_ESTIMATE',
  realized_net_includes_uncertain_history:false},
 secondary_activity:{snapshot_at:T,process:{status:'RECENT_COMMIT_AND_LEASE'},
  market:{usable:true,issue:null},orders:{pending:1,open_positions:1},frames:{
   5:{timeframe:5,last_completed_at:T-300000,last_evaluation_at:T-300000,reason:'WAIT_PULLBACK',
    reason_text:'Esperando el próximo patrón',market_regime:{regime:'HIGH_VOLATILITY'},stale:false,
    scalping_shadow:{status:'WAIT',reason:'NO_CONFIRMED_5M_TREND',authority:'NONE'}},
   15:{timeframe:15,last_completed_at:T-900000,reason:'ENTRY_PENDING',
     market_regime:{regime:'DOWNTREND'},stale:false},
   60:{timeframe:60,last_completed_at:T-3600000,market_regime:{regime:'RANGE'},stale:true},
   240:{timeframe:240,last_completed_at:T-14400000,stale:true}}
  },
 frequency:{account:{equity:'992',cash:'970',positions:[{plan:{id:'pos1',instrument:'PF_XBTUSD',timeframe:5,
  direction:'SHORT',pattern:'PULLBACK',entry:'85000',stop:'85900',target:'83900',execution_contract:{leverage:5}},
  entry:'85000',live_exit:{net:'0.41',funding_complete:true,result_final:true,fresh:true,quote_at:T,liquidity_ok:true},
  max_favourable:'0.62',profit_protection:{protected_net:'0.28'}}],pending_orders:[{plan:{id:'order1'}}]}},
 operations:[
  {id:'pos1',ledger:'FREQUENT_PAPER',status:'OPEN',at:T,plan:{timeframe:5,direction:'SHORT'},live_position:{live_exit:{net:'0.41'}}},
  {id:'close1',ledger:'FREQUENT_PAPER',status:'CLOSED',at:T-10000,plan:{timeframe:15,direction:'LONG'},exit:{at:T-10000,pnl:'0.80',reason:'NET_TARGET'}},
  {id:'primary1',ledger:'ENGINE',status:'CLOSED',at:T-1000,plan:{timeframe:60,direction:'LONG'},exit:{pnl:'100000'}}
 ]
});
test('PAPER-only principal exclusion, realized vs unrealized correctly separated',()=>{
 const m=viewModel(sample(),T+2000);
 assert.equal(m.status,'LIVE_PAPER');assert.equal(m.mode,'PAPER');assert.equal(m.readOnly,true);
 assert.equal(m.openCount,1);assert.equal(m.pendingCount,1);
 assert.equal(m.metrics.realized,'-7.50');assert.equal(m.metrics.unrealized,'0.41');
 assert.equal(m.metrics.total,'-7.09');assert.equal(m.recent.length,2);
 assert.equal(fmtUSD('0.005',{signed:true}),'+US$ 0,0050');
 assert.equal(m.recent[0].status,'OPEN');assert.equal(m.recent[0].recordedCloseNet,null);
 assert.equal(m.recent[1].recordedCloseNet,'0.80');
 assert.equal(m.positions[0].protectedFloor,'0.28');
});
test('scalping WAIT is explicitly research only and uses real 5m/15m regimes',()=>{
 const m=viewModel(sample(),T+1000);
 assert.equal(m.shadow.status,'WAIT');assert.equal(m.shadowResearchOnly,true);
 assert.equal(m.frames[0].regime,'Volatilidad alta');
 assert.equal(m.frames[1].regime,'Tendencia bajista');
 assert.equal(m.frames[0].reason,'Esperando el próximo patrón');
 assert.equal(m.frames[2].stale,true);
});
test('cannot silently substitute the primary/spot projection',()=>{
 const d=sample();delete d.secondary_finances;
 assert.throws(()=>viewModel(d,T),/SECONDARY_PAPER_SNAPSHOT_REQUIRED/);
 const primary=sample();primary.secondary_finances.ledger='ENGINE';
 assert.throws(()=>viewModel(primary,T),/SECONDARY_PAPER_SNAPSHOT_REQUIRED/);
});
test('missing and unfinished financing is not displayed as zero or net profit',()=>{
 const d=sample();d.secondary_finances.unrealized_net=null;
 d.secondary_finances.net_result_final=false;d.secondary_finances.total_net=null;
 d.secondary_finances.realized_result_final=false;d.secondary_finances.realized_net_includes_uncertain_history=true;
 d.frequency.account.positions[0].live_exit.funding_complete=false;
 const m=viewModel(d,T+1000);
 assert.equal(m.metrics.unrealized,null);assert.equal(m.metrics.total,null);
 assert.equal(m.metrics.realizedFinal,false);assert.equal(m.metrics.uncertainHistory,true);
 assert.equal(m.positions[0].net,null);assert.equal(fmtUSD(null),'—');
});
test('no fabricated freshness when process lease or market source is stale',()=>{
 const d=sample();assert.equal(viewModel(d,T+40000).status,'STALE_SNAPSHOT');
 d.secondary_activity.process.status='STALE_OR_UNVERIFIED';
 assert.equal(viewModel(d,T+1000).status,'WORKER_UNVERIFIED');
 d.secondary_activity.process.status='RECENT_COMMIT_AND_LEASE';d.secondary_activity.market.usable=false;
 assert.equal(viewModel(d,T+1000).status,'MARKET_ISSUE');
});
test('stale and empty timeframes label absent readings and preserve each independent role',()=>{
 const d=sample();d.secondary_activity.frames={};const m=viewModel(d,T);
 assert.deepEqual(m.frames.map(f=>f.tf),['5m','15m','1h','4h']);
 assert(m.frames.every(f=>f.stale));
 assert.equal(m.frames[0].reason,'Sin evaluación registrada');
});
test('user-facing strings are escaped before insertion',()=>{
 assert.equal(escapeHTML('<img src=x onerror="alert(1)">'),
  '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
 assert.equal(reasonText('NO_CONFIRMED_5M_TREND'),'No hay tendencia confirmada en 5m');
 assert.equal(regimeText('UPTREND'),'Tendencia alcista');
});
test('front-end uses only same-origin GET; no real or paper execution routes',()=>{
 const app=readFileSync(new URL('../deploy/trading/compact-panel/app.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('../deploy/trading/compact-panel/index.html',import.meta.url),'utf8');
 assert.match(app,/const API='\/api\/monitor\/live'/);
 assert.match(app,/credentials:'same-origin'/);
 assert.doesNotMatch(app,/(method:\s*['"](?:POST|PUT|DELETE|PATCH)['"]|\/api\/aws\/control)/);
 assert.match(html,/id="full-view"/);
 assert.match(html,/href="\/"/);
});

test('activity dates order correctly when timestamps mix ISO and milliseconds',()=>{
 const d=sample(); d.operations[1].exit.at=new Date(T-10000).toISOString();
 d.operations.push({id:'close2',ledger:'FREQUENT_PAPER',status:'CLOSED',
  at:T-1000,exit:{at:new Date(T-1000).toISOString(),pnl:'0.50',result_final:true},
  plan:{timeframe:5,direction:'SHORT'}});
 const m=viewModel(d,T+1000);
 assert.deepEqual(m.recent.map(x=>x.id),['pos1','close2','close1']);
});
test('positions without confirmed futures instrument are excluded',()=>{
 const d=sample();d.frequency.account.positions.push({plan:{id:'legacy'} });
 const m=viewModel(d,T+1000);
 assert.equal(m.positions.length,1);assert.equal(m.openCount,1);
});

test('canonical live PAPER instrument keeps open cards and actual sizing',()=>{
 const d=sample(),p=d.frequency.account.positions[0];
 p.plan.instrument='PAPER:KRAKEN_FUTURES:PF_XBTUSD';p.plan.sizing={leverage:10};
 const m=viewModel(d,T+1000);
 assert.equal(m.positions.length,1);assert.equal(m.positions[0].net,'0.41');
 assert.equal(m.positions[0].leverage,10);
 p.plan.instrument='PAPER:KRAKEN_FUTURES:PF_ETHUSD';
 assert.equal(viewModel(d,T+1000).positions.length,0);
});
test('expired, illiquid and funding-incomplete quotes never appear as current net',()=>{
 for(const change of [p=>p.live_exit.fresh=false,p=>p.live_exit.quote_at=T-6000,
  p=>p.live_exit.liquidity_ok=false,p=>p.funding_uncertain=true,p=>p.funding_pending=[{}],
  p=>p.funding_gaps=[{}],p=>p.closed_funding_pending=[{}]]){
  const d=sample();change(d.frequency.account.positions[0]);
  assert.equal(viewModel(d,T+1000).positions[0].net,null);
 }
});
test('latest blocked evaluation is not hidden behind an earlier completed candle',()=>{
 const d=sample();d.secondary_activity.frames[5].last_evaluation_at=T;
 assert.equal(viewModel(d,T+1000).frames[0].lastAt,T);
});

test('quant frame uses an applicable check and never borrows a different raw rejection as readable text',()=>{
 const d=sample();d.secondary_activity={frames:{'1':{last_evaluation_at:T,stale:false,reason_text:'REGIME_NOT_ELIGIBLE',last_evaluation:{reason:'REGIME_NOT_ELIGIBLE',reason_text:'REGIME_NOT_ELIGIBLE',pattern_decisions:[{pattern:'SCALP_CONTINUATION',reason:'REGIME_NOT_ELIGIBLE'},{pattern:'SCALP_REVERSION',reason:'PATTERN_NOT_CONFIRMED'}]}}}};
 const m=viewModel(d,T);assert.equal(m.frames.find(f=>f.key==='1').reason,'Todavía no hay confirmación del patrón');
 assert.equal(reasonText('REGIME_NOT_ELIGIBLE','REGIME_NOT_ELIGIBLE'),'Esta estrategia no corresponde al régimen actual');
});

test('empty projected quant contracts never label legacy trades as new-engine activity',()=>{
 const d=sample();d.secondary_quant={active:true};
 for(const o of d.operations)o.plan.quant_contract={};
 d.frequency.account.positions[0].plan.quant_contract={};
 d.frequency.account.pending_orders[0].plan.quant_contract={};
 d.operations.push({id:'quant1',ledger:'FREQUENT_PAPER',status:'CLOSED',at:T,exit:{pnl:'.4'},plan:{quant_contract:{version:'secondary-quant-1.0.0'}}});
 const before=structuredClone(d),m=viewModel(d,T);
 assert.deepEqual(m.recent.map(o=>o.id),['quant1']);
 assert.equal(m.legacyCount,2);assert.equal(m.pendingPlans.length,0);
 assert.equal(m.positions[0].origin,'Contrato anterior');assert.deepEqual(d,before);
});
