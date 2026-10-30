// PAPER only. One calculation for display, net-target triggers and settlement.
import {D,hash} from './core.js';
export const EXIT_VERSION='net-exit-1.0.0';
export const EXIT_PROTOCOL=Object.freeze({version:EXIT_VERSION,trigger:'EXECUTABLE_NET_USD',latencyMs:1000,participation:'0.1',realTrading:false});
export function exitFunding(p,price,now){
 const s=p.plan.sizing;if(!s.funding_interval||!s.funding_rate)return D(0);
 const n=Math.max(0,Math.floor((now-p.entered_at)/s.funding_interval));
 return D(p.qty).mul(p.plan.direction==='SHORT'?D(p.entry).gt(price)?p.entry:price:p.entry).mul(s.funding_rate).mul(n);
}
export function netGoal(p){return p.management?.net_goal??(p.plan.exit_management===EXIT_VERSION?p.plan.sizing.target_net:null);}
export function quoteForNet(p,goal,now){
 const s=p.plan.sizing,q=D(p.qty),e=D(p.entry),short=p.plan.direction==='SHORT',fee=D(s.fee),slip=D(s.slippage),cost=D(p.entry_fee).plus(exitFunding(p,e,now)).plus(goal);
 let price=short?e.mul(q).minus(cost).div(q.mul(D(1).plus(fee))):e.mul(q).plus(cost).div(q.mul(D(1).minus(fee)));
 // A short's funding basis is max(entry, exit). Needed for negative goal estimates.
 if(short&&price.gt(e)){const rate=D(s.funding_rate??0).mul(Math.max(0,Math.floor((now-p.entered_at)/(s.funding_interval||1))));price=e.mul(q).minus(p.entry_fee).minus(goal).div(q.mul(D(1).plus(fee).plus(rate)));}
 return price.div(short?D(1).plus(slip):D(1).minus(slip)).toString();
}
export function exitEstimate(p,q,now){
 if(!q||![q.bid,q.ask,p.qty,p.entry].every(x=>Number.isFinite(+x)&&+x>0)||+q.ask<+q.bid)return null;
 const s=p.plan.sizing,short=p.plan.direction==='SHORT',side=short?'ask':'bid',raw=D(q[side]),price=raw.mul(short?D(1).plus(s.slippage):D(1).minus(s.slippage));
 const gross=price.minus(p.entry).mul(short?-1:1).mul(p.qty),fee=price.mul(p.qty).mul(s.fee),funding=exitFunding(p,price,now),cost=D(p.entry_fee).plus(fee).plus(funding),net=gross.minus(cost),goal=netGoal(p);
 return {at:now,quote_at:q.event_at,side,quote_price:raw.toString(),price:price.toString(),gross:gross.toString(),entry_cost:p.entry_fee,exit_fee:fee.toString(),funding:funding.toString(),costs:cost.toString(),net:net.toString(),slippage_cost:price.minus(raw).abs().mul(p.qty).toString(),liquidity_ok:D(q[side+'_qty']??0).mul(EXIT_PROTOCOL.participation).gte(p.qty),net_goal:goal,remaining:goal===null?null:D(goal).minus(net).toString(),break_even_quote:quoteForNet(p,0,now),target_quote:goal===null?null:quoteForNet(p,goal,now),model:'BBO_WITH_SLIPPAGE_AND_FEES',management_override:Boolean(p.management?.override)};
}
export function managedExitReason(p,q,now){
 const v=exitEstimate(p,q,now);if(!v||q.event_at<p.entered_at||!v.liquidity_ok)return null;
 const c=p.close_request;
 if(c&&now>=c.not_before&&q.event_at>=c.not_before&&now<c.expires_at&&(c.mode==='ANY'||D(v.net).gt(0)))return c.mode==='PROFIT'?'MANUAL_PROFIT':'MANUAL_CLOSE';
 return v.net_goal!==null&&now>=(p.management?.not_before??0)&&q.event_at>=(p.management?.not_before??0)&&D(v.net).gte(v.net_goal)?'NET_TARGET':null;
}
export function exitMetadata(p,reason){return {exit_management:p.management?.version??p.plan.exit_management??null,management_override:Boolean(p.management?.override||reason?.startsWith('MANUAL_')),net_goal:netGoal(p),control_id:p.close_request?.id??null};}
export function initializeExits(s,now,requested=false){
 if(s.exitManagement){if(s.exitManagement.protocol_hash!==hash(EXIT_PROTOCOL))throw Error('EXIT_PROTOCOL_MISMATCH');return;}
 if(!requested)return;if(s.schema!==8)throw Error('EXITS_REQUIRE_SCHEMA_8');
 s.schema=9;s.exitManagement={version:EXIT_VERSION,protocol_hash:hash(EXIT_PROTOCOL),requested_at:now,status:'WAITING_FLAT'};s.controls={receipts:[]};
 // Adopt the user-authorized net goal on existing secondary trades, without
 // rewriting their entry, frozen plan, stop, cash or historical results.
 const a=s.frequency.account,ps=a.portfolio?Object.values(a.positions??{}):[a.position].filter(Boolean);
 for(const p of ps)if(D(p.plan.sizing.target_net??0).gt(0))p.management={version:EXIT_VERSION,net_goal:p.plan.sizing.target_net,override:true,adopted_at:now};
 return {type:'NET_EXITS_ENABLED',at:now,version:EXIT_VERSION,realTrading:false};
}
