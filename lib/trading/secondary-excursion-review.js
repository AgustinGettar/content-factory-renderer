// Durable, read-only excursion evidence. An observed MFE is NOT an attainable fill.
// Strictly diagnostic: it must not influence the existing broker or signed exits.
export const SECONDARY_EXCURSION_REVIEW_VERSION='secondary-excursion-review-1.0.0';
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const round=n=>Number(n.toFixed(8));
const manual=e=>e.management_override===true||String(e.reason??'').startsWith('MANUAL_');
function aggregate(rows){
 const result={closed:rows.length,clean_excursions:0,degraded_or_missing:0,
  had_positive_net_mfe_then_closed_negative:0,closed_positive:0,
  positive_mfe_observed_total_usd:0,net_realized_observed_total_usd:0,
  maximum_favourable_net_usd:null,maximum_adverse_net_usd:null,
  observation_quality:{},close_reasons:{},
  data_warnings:['MFE_IS_EX_POST_OBSERVED_QUOTE_NOT_EXECUTABLE_PROFIT',
    'DO_NOT_OPTIMIZE_TRAILING_WITHOUT_REPLAY_AND_LIQUIDITY',
    'POSITIONS_MAY_HAVE_PARTIAL_CLOSES_OR_FUNDING_ADJUSTMENTS']};
 for(const e of rows){
  const reason=typeof e.reason==='string'?e.reason:'UNKNOWN';
  result.close_reasons[reason]=(result.close_reasons[reason]??0)+1;
  const q=typeof e.excursions?.quality==='string'?e.excursions.quality:'UNAVAILABLE';
  result.observation_quality[q]=(result.observation_quality[q]??0)+1;
  const net=Number(e.pnl),mfe=Number(e.excursions?.max_favourable_net),mae=Number(e.excursions?.max_adverse_net);
  if(q!=='OBSERVED'||!finite(e.excursions?.max_favourable_net)||!finite(e.excursions?.max_adverse_net)||
     !finite(e.pnl)||!finite(e.excursions?.observations)||Number(e.excursions.observations)<1||
     !Number.isFinite(mfe)||!Number.isFinite(mae)||mfe<0||mae>0){
   result.degraded_or_missing++;continue;
  }
  result.clean_excursions++;
  result.positive_mfe_observed_total_usd+=mfe;
  result.net_realized_observed_total_usd+=net;
  if(mfe>0&&net<0)result.had_positive_net_mfe_then_closed_negative++;
  if(net>0)result.closed_positive++;
  result.maximum_favourable_net_usd=result.maximum_favourable_net_usd===null?mfe:Math.max(result.maximum_favourable_net_usd,mfe);
  result.maximum_adverse_net_usd=result.maximum_adverse_net_usd===null?mae:Math.min(result.maximum_adverse_net_usd,mae);
 }
 for(const k of ['positive_mfe_observed_total_usd','net_realized_observed_total_usd'])
  result[k]=round(result[k]);
 return result;
}
export function reviewSecondaryExcursions(events) {
 if(!Array.isArray(events))throw Error('EXCURSION_EVENTS_REQUIRED');
 const eligible=[],manuallyClosed=[],unresolved=[];let excluded=0;
 const seen=new Set();
 for(const e of events){
  if(e?.type!=='CLOSED'||e.ledger!=='FREQUENT_PAPER'||e.realTrading!==false){excluded++;continue;}
  if(typeof e.id!=='string'||seen.has(e.id))throw Error('EXCURSION_DUPLICATE_OR_INVALID_ID');
  seen.add(e.id);
  if(!finite(e.pnl))throw Error('EXCURSION_INVALID_PNL');
  if(e.result_final===false||e.funding_complete===false){unresolved.push(e.id);continue;}
  (manual(e)?manuallyClosed:eligible).push(e);
 }
 const grouped={};
 for(const e of eligible){const key=String(e.plan?.entry_revision??'LEGACY')+'|'+String(e.timeframe??e.plan?.timeframe??'UNKNOWN');
  (grouped[key]??=[]).push(e);}
 return {version:SECONDARY_EXCURSION_REVIEW_VERSION,authority:'RESEARCH_ONLY',mode:'PAPER',realTrading:false,
  statistically_validated:false,closed_futures:eligible.length+manuallyClosed.length,
  excluded_non_futures_events:excluded,unresolved_funding_count:unresolved.length,
  autonomous:aggregate(eligible),manual:aggregate(manuallyClosed),
  by_entry_revision_and_timeframe:Object.fromEntries(Object.entries(grouped).map(([key,rows])=>[key,aggregate(rows)]))};
}
