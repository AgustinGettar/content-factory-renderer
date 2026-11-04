import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeSecondaryPerformance as review} from '../lib/trading/secondary-performance-review.js';
const close=(id,pnl,{fees='.2',gross=null,reason='TIMEOUT',version='secondary-entry-useful-margin-2.0.0',tf=5,pattern='PULLBACK',manual=false,final=true}={})=>({type:'CLOSED',id,ledger:'FREQUENT_PAPER',realTrading:false,pnl,fees,gross,reason,
 plan:{entry_revision:version,timeframe:tf,pattern},entered_at:1000,at:2000,management_override:manual,result_final:final,funding_complete:final});
test('only final CLOSED totals are counted; partial fragments never double-count',()=>{
 const events=[{type:'PARTIAL_CLOSE',pnl:'25'},close('a','0.4',{fees:'.1',gross:'.5'}),close('b','-1.2',{fees:'.2',gross:'-1'})];
 const r=review(events);
 assert.equal(r.autonomous.count,2);assert.equal(r.autonomous.net_usd,-0.8);assert.equal(r.autonomous.fees_usd,0.3);
 assert.equal(r.autonomous.profit_factor,0.33333333);assert.equal(r.autonomous.gross_usd,-0.5);
 assert.equal(r.ignored_non_closes,1);assert.equal(r.authority,'RESEARCH_ONLY');
});
test('manual outcomes are separated from autonomous strategy evidence',()=>{
 const r=review([close('auto','-.5'),close('manual','2',{reason:'MANUAL_PROFIT'})]);
 assert.equal(r.autonomous.net_usd,-0.5);assert.equal(r.manual.net_usd,2);assert.equal(r.all_final.net_usd,1.5);
 assert.equal(r.groups.length,1);assert.equal(r.statistically_validated,false);
});
test('strategy, version, and timeframe are kept distinct',()=>{
 const r=review([close('a','.2'),close('b','-.1',{tf:60}),close('c','-.5',{pattern:'BREAKOUT'}),close('d','-.5',{version:'v1'})]);
 assert.equal(r.groups.length,4);assert.equal(r.autonomous.count,4);
});
test('unfinalized funding is not presented as realized and confidence is bounded',()=>{
 const r=review([close('pending','.9',{final:false}),close('a','-.5')]);
 assert.equal(r.unresolved_count,1);assert.deepEqual(r.unresolved_operation_ids,['pending']);
 assert.equal(r.autonomous.count,1);assert.equal(r.autonomous.win_rate,0);
 assert(r.autonomous.win_rate_wilson95[1]>0);
});
test('reject non-PAPER results, duplicate operation IDs and invalid accounting',()=>{
 assert.throws(()=>review([{...close('a','.2'),realTrading:true}]),/SCOPE_VIOLATION/);
 assert.throws(()=>review([close('a','.2'),close('a','.2')]),/DUPLICATE/);
 assert.throws(()=>review([close('a','NaN')]),/INVALID_ACCOUNTING/);
 assert.throws(()=>review([close('a','.2',{fees:'-.2'})]),/INVALID_ACCOUNTING/);
});
test('empty sample and no observed losses cannot manufacture profit factor or significance',()=>{
 assert.equal(review([]).autonomous.profit_factor,null);
 const r=review([close('a','.1')]);assert.equal(r.autonomous.profit_factor,null);
 assert(r.autonomous.win_rate_wilson95[0]<1);assert.equal(r.statistically_validated,false);
});
