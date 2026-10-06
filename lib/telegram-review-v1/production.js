import {runRealExecutorDryGate} from '../lumi-v2-real-executor-dry-run.js';
import {selectLumiCreationProfile} from '../lumi-production-profile-v2.js';
import { reviewGate, validateArtifact, sha256 } from './core.js';
import {executeLumiTtsStage} from '../lumi-tts-stage-v2.js';
import {readFile} from 'node:fs/promises';
// An adapter must use the existing canonical Recovery Manager, provider journal,
// budget and authorization gates. Never bypass those gates from a Telegram button.
export class ProductionReviewController {
  constructor({store,adapters={},ttsRuntime=null}){this.store=store;this.adapters=adapters;this.ttsRuntime=ttsRuntime;}
  async row(user,episodeId){const row=await this.store.get(user);if(!row?.state.episodes[episodeId])throw Error('review_episode_not_found');return row;}
  async dryRun({user,message_id,crashMatrix=false,verifyTtsPreflight=false}){
    const row=await this.store.get(user);if(!row||Number(row.state.message_id)!==Number(message_id))throw Error('CANONICAL_DRY_OWNER_REQUIRED');
    const result=await runRealExecutorDryGate({message_id:row.state.message_id,crashMatrix});
    if(verifyTtsPreflight){
      const fixture=JSON.parse(await readFile(new URL('../../qa/LUMI_GENERIC_LISTEN_FIXTURE_V1.json',import.meta.url)));
      try{
        const r=await executeLumiTtsStage({episode_id:fixture.episode.id,stage_id:'TTS',narration_unit_id:'preflight',
          text:fixture.scenes[0].audio.utterances[0].text,voice_profile_id:'LUMI_VOICE_PROFILE_V2',dry_run:true,require_preflight:true,
          output_artifact_target:{bucket:'generated-audio',prefix:'lumi-readiness-probe'},
          budget_context:{currency:'CREDITS',ceiling_units:100,spent_units:0,remaining_reserve_units:0}},this.ttsRuntime??{});
        result.strict_tts_preflight={status:r.status,HIGGSFIELD_AUTH_TRANSPORT:r.HIGGSFIELD_AUTH_TRANSPORT,
          TTS_COST_PREFLIGHT:r.TTS_COST_PREFLIGHT,TTS_BUDGET_PREFLIGHT:r.TTS_BUDGET_PREFLIGHT,
          ESTIMATED_PROVIDER_CREDITS:r.ESTIMATED_PROVIDER_CREDITS,quote:r.quote,storage_gate:r.storage_gate.status,
          budget:r.budget,budget_scope:'FICTITIOUS_DIAGNOSTIC_ONLY_NOT_PRODUCTION_AUTHORIZATION',TTS_PROVIDER_JOBS_CREATED:0};
      }catch(error){result.strict_tts_preflight={status:'BLOCKED',HIGGSFIELD_AUTH_TRANSPORT:'UNVERIFIED',
        TTS_COST_PREFLIGHT:'NOT_COMPLETED',TTS_BUDGET_PREFLIGHT:'NOT_COMPLETED',TTS_PROVIDER_JOBS_CREATED:0,
        reason:error.code==='ENOENT'?'HIGGSFIELD_CLI_NOT_INSTALLED':'AUTHENTICATED_EXECUTOR_PREFLIGHT_FAILED'};}
    }
    return result;
  }
  async create({user,request,requested_profile,activation,readiness}){
    const row=await this.store.get(user);if(!row)throw Error('review_owner_required');
    const episodeId=request?.episodePlan?.episode?.id;
    const route=selectLumiCreationProfile({requested:requested_profile,activation,readiness,existingEpisode:!!row.state.episodes[episodeId]});
    if(route.profile==='legacy')return {status:'LEGACY_ROUTE_UNCHANGED',provider_calls:0};
    const adapter=this.adapters[route.profile];if(!adapter?.create)throw Error('GENERIC_WORKER_BINDINGS_REQUIRED');
    return adapter.create({user,request,authorizedCeilingUsd:activation?.authorized_ceiling_usd||0});
  }
  canResume(e){return !!this.adapters[e.pipeline]?.resume && !e.master && !e.cancelled && e.production_authorization && e.budget_approved===true && !e.provider_repair_required && !e.budget_change && reviewGate(e)==='READY_TO_CONTINUE';}
  async reviewed({user,episodeId,requestId}){
    const row=await this.row(user,episodeId),e=row.state.episodes[episodeId],adapter=this.adapters[e.pipeline];
    if(!adapter?.handleReview)throw Error('GENERIC_REVIEW_RECOVERY_BINDING_REQUIRED');
    const result=await adapter.handleReview({user,episodeId,requestId});
    // Reconciliation advances the checkpoint, but review itself does not grant a paid dispatch.
    return result;
  }
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
