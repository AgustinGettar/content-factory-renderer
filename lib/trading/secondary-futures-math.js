// Pure futures-paper valuation; no network or exchange trading capability.
import {D} from './core.js';
export const SECONDARY_VERSION='secondary-futures-1.0.0';
export const SECONDARY_MODEL='lumi-linear-futures-paper-1.0.0';
export const SECONDARY_PROTOCOL=Object.freeze({version:SECONDARY_VERSION,symbol:'PF_XBTUSD',mode:'PAPER',entryMinutes:5,contextMinutes:15,holdingMs:1800000,entryExpiryMs:120000,latencyMs:1000,makerFee:'0.0002',takerFee:'0.0005',slippage:'0.0002',minNetRR:1.5,maxTargetMove:0.012,riskFraction:'0.005',riskCapUSD:'2',openRiskFraction:'0.01',dailyLossFraction:'0.03',drawdownFraction:'0.05',cashReserveFraction:'0.10',leverage:2,maxGrossExposure:2,maxSlots:10,maxDirectionSlots:2,participation:'0.05',lossStreak:3,cooldownMs:900000,patterns:['BREAKOUT','PULLBACK','RANGE_REENTRY'],feeSource:'https://www.kraken.com/pro/fees',feeVerifiedAt:'2026-11-01',realTrading:false});
export const isSecondary=p=>p?.plan?.execution_model===SECONDARY_MODEL;
const P=SECONDARY_PROTOCOL,n=x=>Number(x);
export function secondaryFresh(q,now){return !!q&&q.source==='KRAKEN_FUTURES_WS_TICKER'&&Number.isSafeInteger(q.event_at)&&now-q.event_at>=-1000&&now-q.event_at<=5000&&now-q.received_at>=0&&now-q.received_at<=5000&&[q.bid,q.ask,q.bid_qty,q.ask_qty].every(x=>Number.isFinite(n(x))&&n(x)>0)&&n(q.ask)>=n(q.bid)&&!q.suspended;}
export function secondaryEstimate(p,q,now){
 if(!isSecondary(p)||!secondaryFresh(q,now))return null;
 const short=p.plan.direction==='SHORT',sign=short?-1:1,side=short?'ask':'bid',raw=D(q[side]),price=raw.mul(D(1).plus(D(P.slippage).mul(-sign))),qty=D(p.qty),entry=D(p.entry),entryFee=D(p.entry_fee),funding=D(p.accrued_funding??0),exitFee=price.mul(qty).mul(P.takerFee),gross=price.minus(entry).mul(sign).mul(qty),costs=entryFee.plus(exitFee).plus(funding),net=gross.minus(costs),goal=p.management?.net_goal??p.plan.sizing.target_net;
 const quoteFor=goal=>{const cost=entryFee.plus(funding).plus(goal);return (short?entry.mul(qty).minus(cost).div(qty.mul(D(1).plus(P.takerFee))):entry.mul(qty).plus(cost).div(qty.mul(D(1).minus(P.takerFee)))).div(D(1).plus(D(P.slippage).mul(-sign))).toString();};
 return {at:now,quote_at:q.event_at,side,quote_price:raw.toString(),price:price.toString(),gross:gross.toString(),entry_cost:entryFee.toString(),exit_fee:exitFee.toString(),funding:funding.toString(),costs:costs.toString(),net:net.toString(),net_goal:goal,remaining:D(goal).minus(net).toString(),break_even_quote:quoteFor(0),target_quote:quoteFor(goal),liquidity_ok:D(q[side+'_qty']).mul(P.participation).gte(qty),model:'PF_XBTUSD_FUTURES_OBSERVED_BBO',management_override:Boolean(p.management?.override),fresh:true,market_issue:null};
}
