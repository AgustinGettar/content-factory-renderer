import {D,hash} from './core.js';
import {findPosition} from './portfolio.js';
import {EXIT_VERSION,EXIT_PROTOCOL,exitEstimate} from './paper-exits.js';
import {PANEL_URL} from './notifier.js';
const terminal=r=>['CLOSED','APPLIED','REJECTED','EXPIRED'].includes(r.status);
export const controlAccount=(s,ledger)=>ledger==='FREQUENT_PAPER'?s.frequency?.account:ledger==='ENGINE'?s.research.versions[s.research.active]?.account:null;
export function acceptControl(s,c,now,event){
 if(!s.exitManagement||!s.controls)return;
 const receipts=s.controls.receipts,old=receipts.find(r=>r.id===c.id);if(old)return old;
 if(!/^[a-f0-9-]{36}$/.test(c.id??'')||!Number.isSafeInteger(c.created_at)||!Number.isSafeInteger(c.expires_at)||c.created_at>now+1000||c.expires_at-c.created_at>120000||c.expires_at<=c.created_at)return;
 const r={id:c.id,command_hash:hash(c),operation_id:c.operation_id,ledger:c.ledger,action:c.action,at:now,expires_at:c.expires_at,status:'REJECTED',reason:'INVALID_COMMAND'};
 const p=findPosition(controlAccount(s,c.ledger),c.operation_id);
 if(now>=c.expires_at){r.status='EXPIRED';r.reason='REQUEST_EXPIRED';}
 else if(!p)r.reason='POSITION_NOT_OPEN';
 else if(p.plan.hash!==c.plan_hash)r.reason='PLAN_CHANGED';
 else if(c.action==='SET_NET_GOAL'&&p.plan.execution_model==='lumi-margin-paper-1.0.0'&&/^\d{1,6}(\.\d{1,2})?$/.test(c.net_goal??'')&&D(c.net_goal).gte('.01')&&D(c.net_goal).lte(p.management?.net_goal??p.plan.sizing.target_net)){
  p.management={version:EXIT_VERSION,net_goal:c.net_goal,override:true,changed_at:now,not_before:now+EXIT_PROTOCOL.latencyMs,command_id:c.id};r.status='APPLIED';r.reason='NET_GOAL_UPDATED';r.net_goal=c.net_goal;
 }else if(c.action==='CLOSE'&&['PROFIT','ANY'].includes(c.mode)){
  if(p.close_request)r.reason='CLOSE_ALREADY_PENDING';
  else {p.close_request={id:c.id,mode:c.mode,requested_at:now,not_before:now+EXIT_PROTOCOL.latencyMs,expires_at:c.expires_at};r.status='WAITING_MARKET';r.reason='NEXT_FRESH_QUOTE';}
 }
 receipts.push(r);s.controls.receipts=receipts.filter(x=>!terminal(x)||x.expires_at>now-86400000).slice(-500);
 event({type:'PAPER_CONTROL',at:now,...r,realTrading:false});return r;
}
export function checkControls(s,feed,now,event){
 for(const r of s.controls?.receipts??[]){if(terminal(r))continue;const p=findPosition(controlAccount(s,r.ledger),r.operation_id),c=p?.close_request;
  let reason=null;if(now>=r.expires_at)reason='REQUEST_EXPIRED';
  else if(!p)reason='POSITION_NOT_OPEN';
  else if(c&&now>=c.not_before&&feed.quote?.event_at>=c.not_before&&c.mode==='PROFIT'&&D(exitEstimate(p,feed.quote,now)?.net??0).lte(0))reason='NO_NET_PROFIT';
  if(reason){if(c?.id===r.id)delete p.close_request;r.status=reason==='REQUEST_EXPIRED'?'EXPIRED':'REJECTED';r.reason=reason;r.at=now;event({type:'PAPER_CONTROL',...r,realTrading:false});}
 }
}
export function settleControl(s,e){
 if(e.type!=='CLOSED')return;for(const r of s.controls?.receipts??[])if(!terminal(r)&&r.operation_id===e.id&&r.ledger===e.ledger)Object.assign(r,{status:'CLOSED',at:e.at,reason:e.reason,pnl:e.pnl,price:e.price,fees:e.fees});
}
// HTTP only transfers requests. The engine applies them on its fenced writer;
// acknowledgements are read back from committed SQLite, never from RAM.
export class PaperControlClient{
 constructor({env,store,fetchImpl=fetch,now=()=>Date.now()}){Object.assign(this,{env,store,fetchImpl,now});this.inbox=[];this.busy=false;this.lastSuccess=0;this.error=null;}
 headers(){return {'OAI-Sites-Authorization':'Bearer '+this.env.LUMI_TRADING_SITE_ACCESS,'X-Trading-Ingest-Key':this.env.LUMI_TRADING_PUBLISH_KEY,'Content-Type':'application/json'};}
 async poll(){if(this.busy)return;this.busy=true;try{
  const request=async(method,body)=>{const r=await this.fetchImpl(PANEL_URL+'api/aws/controls',{method,headers:this.headers(),...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('CONTROL_TRANSPORT_UNAVAILABLE');return r.json();};
  const d=await request('GET');if(!Array.isArray(d.commands)||d.commands.length>20)throw Error('CONTROL_RESPONSE_INVALID');
  const saved=this.store.row().state.controls?.receipts??[],ack=[];
  for(const c of d.commands){const receipt=saved.find(r=>r.id===c.id);if(receipt)ack.push(receipt);else if(!this.inbox.some(x=>x.id===c.id)&&this.inbox.length<20)this.inbox.push(c);}
  if(ack.length)await request('PUT',{receipts:ack});this.lastSuccess=this.now();this.error=null;
 }catch{this.error='CONTROL_TRANSPORT_UNAVAILABLE';}finally{this.busy=false;}}
 drain(){return this.inbox.splice(0);}
}
