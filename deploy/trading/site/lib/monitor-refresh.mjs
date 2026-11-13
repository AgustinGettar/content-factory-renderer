export const LIVE_REFRESH_MS=2000;
export const DETAIL_REFRESH_MS=15000;
const key=p=>typeof p?.hash==='string'&&typeof p?.id==='string'?p.id+':'+p.hash:null;
// A slower detail response may add immutable evidence, but never reopen a
// closed trade or replace fresh prices/account balances with an older sample.
export function mergeMonitor(current,incoming){
 if(!incoming||incoming.schema!==1||!Number.isSafeInteger(incoming.revision)||incoming.revision<0||!Number.isSafeInteger(incoming.generated_at)||incoming.generated_at<=0||!Number.isFinite(new Date(incoming.generated_at).getTime()))return current;
 if(current&&(incoming.started_at??null)!==(current.started_at??null))return current;
 const evidence=new Map();
 const collect=v=>{if(!v||typeof v!=='object')return;const k=key(v);if(k&&v.evidence)evidence.set(k,v.evidence);for(const [name,child] of Object.entries(v))if(name!=='evidence')collect(child);};
 collect(incoming);collect(current);
 const newer=!current||(incoming.revision>=current.revision&&incoming.generated_at>=current.generated_at),source=newer?incoming:current;
 const fill=v=>{if(!v||typeof v!=='object')return v;if(Array.isArray(v))return v.map(fill);const out=Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='evidence'?x:fill(x)])),k=key(v);if(k&&!out.evidence&&evidence.has(k))out.evidence=evidence.get(k);return out;};
 return fill(source);
}
