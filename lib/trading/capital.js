import {D,POLICY,hash} from './core.js';

export const initialCapital=now=>({currency:'USD',initialCash:POLICY.initialCash,configured_at:now,policy_hash:hash(POLICY)});

// One explicit user-authorized change of an unused ledger. Never erase fills,
// pending entries, losses, fees, campaigns or observations to restart a result.
// Called after lease acquisition and committed atomically with its audit event.
export function reconcilePaperCapital(state,now){
  if(state.capital){
    if(state.capital.currency!=='USD'||state.capital.initialCash!==POLICY.initialCash)throw Error('TRADING_CAPITAL_POLICY_MISMATCH');
    return null;
  }
  const versions=Object.values(state.research?.versions||{}),old='10000';
  const accounts=[state.alert,...versions.map(v=>v.account)];
  const pristine=a=>a&&['cash','equity','peak','dayStart'].every(k=>D(a[k]).eq(old))
    &&['net','fees','maxDrawdown'].every(k=>D(a[k]).isZero())
    &&['closed','observedClosed','ambiguousClosed','wins','losses','lossStreak','maxLossStreak'].every(k=>a[k]===0)
    &&a.pending===null&&a.position===null&&a.halted===false;
  if(POLICY.initialCash!=='100'||versions.length!==1||!state.research.versions[state.research.active]
    ||state.research.campaigns.length||state.research.history.length||state.research.attempts!==0
    ||Object.keys(versions[0].days||{}).length||versions[0].fills
    ||['mature','criticalIncidents'].some(k=>state.counters[k]!==0)
    ||!accounts.every(pristine))throw Error('TRADING_CAPITAL_CHANGE_REQUIRES_UNUSED_LEDGER');
  const before={accounts:structuredClone(accounts),lastDayEquity:versions[0].lastDayEquity??null};
  for(const account of accounts)for(const key of ['cash','equity','peak','dayStart'])account[key]=POLICY.initialCash;
  if(versions[0].lastDayEquity!=null)versions[0].lastDayEquity=Number(POLICY.initialCash);
  state.capital=initialCapital(now);
  return {type:'PAPER_INITIAL_CAPITAL_CHANGED',at:now,from:old,to:POLICY.initialCash,currency:'USD',
    risk_fraction:POLICY.risk,initial_risk_budget:D(POLICY.initialCash).mul(POLICY.risk).toString(),
    reason:'USER_REQUEST_2026_10_29',before,policy_hash:hash(POLICY),realTrading:false};
}
