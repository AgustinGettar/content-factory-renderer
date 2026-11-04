import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {viewModel,fmtUSD,fmtDate,escapeHTML,reasonText} from '../deploy/trading/compact-panel/model.js';
const NOW=Date.parse('2026-11-04T00:30:00Z');
const sample=()=>({revision:100,feed:{sampled_at:NOW},
 secondary_finances:{mode:'PAPER',ledger:'FREQUENT_PAPER',valuation_quality:'CURRENT_ESTIMATE',realized_result_final:true,realized_net:'-39.4',unrealized_net:'0.4',net_result_final:true,total_net:'-39',costs_recorded:'26.4',available_cash:'900'},
 secondary_activity:{snapshot_at:NOW,process:{status:'RECENT_COMMIT_AND_LEASE'},market:{usable:true,issue:null},frames:{5:{last_completed_at:NOW-300000,last_result:'WAIT_PULLBACK',last_status:'COMPLETE',stale:false,
 scalping_shadow:{status:'WAIT',reason:'NO_CONFIRMED_5M_TREND',authority:'NONE'}}}},
 frequency:{financial_summary:null,market:{error:null},account:{equity:'991.9',cash:'900',fees:'26.4',
 positions:[{plan:{id:'x',instrument:'PF_XBTUSD',direction:'SHORT',timeframe:60,
 pattern:'PULLBACK',stop:'80000',target:'76000',execution_contract:{leverage:5}},entry:'78000',qty:'0.01',
 live_exit:{net:'0.4',quote_at:NOW-1000,funding_complete:true,result_final:true},
 profit_protection:{peak_net:'0.6',protected_net:'0.3',trailing_activated_at:NOW-2500}}],
 pending_orders:[]}},
 operations:[{ledger:'FREQUENT_PAPER',id:'x',status:'OPEN',at:NOW,plan:{direction:'SHORT',timeframe:60}},
 {ledger:'ENGINE',id:'y',status:'CLOSED',exit:{pnl:'1000'}}]});
test('shows only secondary PAPER, not primary or old spot',()=>{
 const a=viewModel(sample(),NOW+1000);assert.equal(a.openCount,1);assert.equal(a.positions[0].side,'SHORT');
 assert.equal(a.metrics.realized,'-39.4');assert.equal(a.metrics.total,'-39');assert.equal(a.recent.length,1);
 assert.equal(a.positions[0].protectedFloor,'0.3');assert.equal(a.frames[0].shadow.authority,'NONE');
});
test('no missing net values converted to zero or fabricated profits',()=>{
 const d=sample();d.secondary_finances.net_result_final=false;d.secondary_finances.unrealized_net=null;
 d.frequency.account.positions[0].live_exit.funding_complete=false;
 const m=viewModel(d,NOW+1000);assert.equal(m.metrics.unrealized,null);assert.equal(m.metrics.total,null);
 assert.equal(m.positions[0].net,null);assert.equal(fmtUSD(null),'—');
});
test('staleness and labels are time-based, not inferred from a fetched response',()=>{
 const m=viewModel(sample(),NOW+25000);assert.equal(m.ageMs,25000);assert.equal(m.status,'STALE_SNAPSHOT');
 assert.equal(fmtDate(null),'Sin registro');assert.equal(reasonText('TIMEOUT'),'Tiempo máximo');
});
test('untrusted text is escaped before insertion into HTML strings',()=>{
 assert.equal(escapeHTML('<img src=x onerror="alert(1)">'),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});
test('UI files only perform same-origin GET and keep complete controls accessible',()=>{
 const js=readFileSync('deploy/trading/compact-panel/app.js','utf8');
 const html=readFileSync('deploy/trading/compact-panel/index.html','utf8');
 assert.match(js,/fetch\(API,\{credentials:'same-origin'/);
 assert.match(js,/const API='\/api\/monitor\/live'/);
 assert.doesNotMatch(js,/method:\s*['"](?:POST|PUT|DELETE|PATCH)['"]/);
 assert.match(html,/href="\\/"/);assert.match(html,/id="full-view"/);
 assert.match(html,/viewport-fit=cover/);
});
