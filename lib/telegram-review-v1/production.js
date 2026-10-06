import { reviewGate, validateArtifact, sha256 } from './core.js';
// An adapter must use the existing canonical Recovery Manager, provider journal,
// budget and authorization gates. Never bypass those gates from a Telegram button.
export class ProductionReviewController {
  constructor({store,adapters={}}){this.store=store;this.adapters=adapters;}
  async row(user,episodeId){const row=await this.store.get(user);if(!row?.state.episodes[episodeId])throw Error('review_episode_not_found');return row;}
  canResume(e){return !!this.adapters[e.pipeline]?.resume && !e.master && !e.cancelled && e.production_authorization && e.budget_approved===true && !e.provider_repair_required && !e.budget_change && reviewGate(e)==='READY_TO_CONTINUE';}
  async completed({user,episodeId,shotId,artifact,technicalQa,creativeQa,master=false}){
    validateArtifact(artifact);const row=await this.row(user,episodeId),e=row.state.episodes[episodeId];
    if(master)e.master=artifact;
    else {const shot=e.shots.find(x=>x.shot_id===shotId);if(!shot)throw Error('review_shot_not_found');Object.assign(shot,{artifact,technical_qa:technicalQa,creative_qa:creativeQa});}
    e.current_stage=master?'FINAL_HUMAN_REVIEW':reviewGate(e);row.state.recovery_state=reviewGate(e);
    e.resume_available=!!this.canResume(e);
    await this.store.cas(user,row.revision,row.state);
    if(!master&&e.review_mode==='AUTO_WITH_EXCEPTIONS'&&e.resume_available)return this.resume({user,episodeId});
    return {status:row.state.recovery_state,provider_calls:0};
  }
  async resume({user,episodeId}){
    let row=await this.row(user,episodeId),e=row.state.episodes[episodeId];
    if(['EMITTING','UNKNOWN','FAILED'].includes(row.state.delivery?.status))throw Error('telegram_delivery_recovery_required');
    if(!this.canResume(e))throw Error('canonical_resume_gate_closed');
    const key=sha256(JSON.stringify([user,episodeId,e.production_authorization,e.next_action,e.shots.map(x=>x.artifact?.sha256)]));
    row.state.production_commands||={};
    if(row.state.production_commands[key])return {status:row.state.production_commands[key].status,already_applied:true,provider_calls:0};
    row.state.production_commands[key]={status:'PENDING',episode_id:episodeId,created_at:new Date().toISOString()};
    // Atomic claim precedes dispatch. A lost response requires canonical journal
    // reconciliation; neither restarts nor double taps repeat the paid action.
    await this.store.cas(user,row.revision,row.state);
    let result;
    try{result=await this.adapters[e.pipeline].resume({episodeId,idempotencyKey:key,authorization:e.production_authorization,nextAction:e.next_action});}
    catch{throw Error('canonical_resume_reconciliation_required');}
    row=await this.row(user,episodeId);
    row.state.production_commands[key]={...row.state.production_commands[key],status:'APPLIED',result};
    await this.store.cas(user,row.revision,row.state);return result;
  }
  async cancel({user,episodeId}){
    const row=await this.row(user,episodeId),e=row.state.episodes[episodeId];
    e.cancelled=true;e.resume_available=false;row.state.recovery_state='CANCELLED';
    await this.store.cas(user,row.revision,row.state);
    // Canonical cancel is idempotent and never authorizes provider calls.
    if(this.adapters[e.pipeline]?.cancel)await this.adapters[e.pipeline].cancel({episodeId});
    return {status:'CANCELLED',provider_calls:0};
  }
}
