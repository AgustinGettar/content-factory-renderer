import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSecondaryExcursions as review} from '../lib/trading/secondary-excursion-review.js';
const event=(id,pnl,mfe,mae,{quality='OBSERVED',reason='TIMEOUT',manual=false,final=true}={})=>
 ({type:'CLOSED',id,ledger:'FREQUENT_PAPER',realTrading:false,pnl,reason,
 management_override:manual,result_final:final,funding_complete:final,
 plan:{entry_revision:'v2'},timeframe:5,
 excursions:{max_favourable_net:mfe,max_adverse_net:mae,observations:50,quality}});
test('clean observed net MFE positive followed by a loss is detectable, not labeled executable',()=>{
 const r=review([event('a','-1','0.4','-1.2'),event('b','0.2','0.5','-0.1')]);
 assert.equal(r.autonomous.closed,2);assert.equal(r.autonomous.clean_excursions,2);
 assert.equal(r.autonomous.had_positive_net_mfe_then_closed_negative,1);
 assert.equal(r.autonomous.positive_mfe_observed_total_usd,0.9);
 assert.equal(r.autonomous.net_realized_observed_total_usd,-0.8);
 assert.equal(r.authority,'RESEARCH_ONLY');
});
test('unresolved data gaps cannot be counted as proof of a missed gain',()=>{
 const r=review([event('gap','-1','3','-4',{quality:'UNRESOLVED_MARKET_GAP'}),
  event('fund','-1','2','-3',{quality:'FUNDING_GAP'})]);
 assert.equal(r.autonomous.clean_excursions,0);assert.equal(r.autonomous.degraded_or_missing,2);
});
test('manual and legacy scopes are never blended',()=>{
 const r=review([event('manual','2','2.5','-.1',{manual:true}),{...event('legacy','-5','5','-5'),realTrading:undefined}]);
 assert.equal(r.manual.closed,1);assert.equal(r.autonomous.closed,0);
 assert.equal(r.excluded_non_futures_events,1);
});
test('unfinalized funding is excluded and duplicated operation IDs are rejected',()=>{
 const r=review([event('unfinal','-2','5','-5',{final:false})]);assert.equal(r.unresolved_funding_count,1);
 assert.throws(()=>review([event('a','1','1','0'),event('a','1','1','0')]),/DUPLICATE/);
});
test('invalid signed PnL and impossible excursion signs are not included',()=>{
 assert.throws(()=>review([event('a','NaN','1','-1')]),/INVALID_PNL/);
 const r=review([event('a','1','-1','1')]);assert.equal(r.autonomous.degraded_or_missing,1);
});
test('empty samples have no invented extrema',()=>{
 const r=review([]);assert.equal(r.autonomous.maximum_favourable_net_usd,null);
 assert.equal(r.autonomous.net_realized_observed_total_usd,0);
});
