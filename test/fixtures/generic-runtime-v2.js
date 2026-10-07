// Isolated persisted input records only. All routing, authorization,
// materialization, executors and reconciliation come from production modules.
import {genericFixture} from './generic-v2.js';
import {MemoryLumiRecoveryStore,LumiRecoveryIncidentManager} from '../../lib/lumi-recovery-incident-manager-v1.js';
import {MemoryReviewStore,newSession,sha256,ReviewService,renderTelegramPanel} from '../../lib/telegram-review-v1/core.js';
import {HOME_ASSET} from '../../lib/telegram-review-v1/home-asset.js';
import {createGenericV2Runtime} from '../../lib/lumi-v2-telegram-runtime.js';
import {createV2InputMaterializer,checkpointIdentity} from '../../lib/lumi-v2-input-materializer.js';
import {authenticateV2Command,inputDigest} from '../../lib/lumi-v2-activation-context.js';
import {PROFILE_SHA,LUMI_PRODUCTION_PROFILE_V2 as profile} from '../../lib/lumi-production-profile-v2.js';
import {signRequest} from '../../lib/telegram-review-v1/make-transport.js';
import {ProductionReviewController} from '../../lib/telegram-review-v1/production.js';
export const fixtureSecret='LOCAL_TEST_HMAC_ONLY_NOT_A_CREDENTIAL_1234567890';
export async function runtimeFixture({request,store=new MemoryLumiRecoveryStore(),reviewStore=new MemoryReviewStore(),objects=new Map(),journalRows=new Map(),inject,validateOwner=async(user,chat)=>user==='1'&&chat==='1'}={}){
  const f=request?null:await genericFixture('ep_runtime_integration_input');request||=f.request;
  const episodeId=request.episodePlan.episode.id,manager=new LumiRecoveryIncidentManager({store});
  if(!await reviewStore.get('1')){
    const s=newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET});
    s.v2_authorizations={controlled:{status:'AUTHORIZED',version:1,user_id:'1',chat_id:'1',message_id:138,
      operation_id:'create-input-fixture',episode_id:episodeId,profile_id:profile.id,profile_version:profile.version,
      profile_sha:PROFILE_SHA,request_sha:inputDigest(request),scopes:['CREATE','RESUME'],readiness_status:'PASS',
      expires_at:'2099-01-01T00:00:00Z',dry_run:true,authorized_ceiling_usd:1}};
    await reviewStore.create('1',s);
  }
  let providerCalls=0,uploads=0;
  const storage={download:async(bucket,path)=>objects.get(bucket+'/'+path)||null,
    upload:async()=>{uploads++;throw Error('NO_NEW_ARTIFACTS_IN_INPUT_TEST');}};
  const journal={get:async id=>structuredClone(journalRows.get(id)||null)};
  const adapter=createGenericV2Runtime({manager,reviewStore,artifactStorage:storage,journal,validateOwner,inject,
    fetchImpl:async()=>{providerCalls++;throw Error('PROVIDER_MUST_NOT_BE_CALLED');},env:{LUMI_RUNTIME_ENV:'staging'}});
  const production=new ProductionReviewController({store:reviewStore,adapters:{[profile.id]:adapter}});
  const body={op:'create_v2',user_id:'1',chat_id:'1',message_id:138,operation_id:'create-input-fixture',authorization_id:'controlled',requested_profile:profile.id,request};
  const signed={timestamp:String(Math.floor(Date.now()/1000)),requestId:'fixture-nonce',path:'/lumi/telegram-review/make/v1',body:Buffer.from(JSON.stringify(body))};
  const signature=signRequest(fixtureSecret,signed),command=authenticateV2Command({secret:fixtureSecret,signed,signature});
  const create=()=>production.create({user:'1',chat:'1',request,requested_profile:profile.id,authenticatedCommand:command});
  const materialize=async(stage)=>{
    const state=await store.getEpisode(episodeId),action=state.actions.find(a=>a.key===state.first_pending_action);
    return createV2InputMaterializer({store,storage,reviewStore,journal})({episode_id:episodeId,stage_id:stage||action.stage,
      checkpoint_id:checkpointIdentity(state),profile_version:2,execution_context:{user:'1',profile_sha:PROFILE_SHA,action_key:action.key}});
  };
  const service=new ReviewService({store:reviewStore,validateOwner,production,telegram:{call:async()=>({})}});
  service.show=async()=>({status:'ISOLATED_PANEL_TRANSPORT'});
  return {request,episodeId,store,reviewStore,manager,objects,journalRows,adapter,production,body,signed,signature,command,create,materialize,service,
    counters:()=>({providerCalls,uploads}),cleanup:async()=>f?.cleanup()};
}
export async function seedPersistedVideos(f,{nextStage='SHOT_REVIEW'}={}){
  const state=await f.store.getEpisode(f.episodeId),p=state.metadata.generic_v2,last=p.shot_plans.at(-1),row=await f.reviewStore.get('1'),e=row.state.episodes[f.episodeId];
  const bytes=Buffer.from('SYNTHETIC PERSISTED INPUT BYTES; NOT REAL GENERATED VIDEO');
  await f.manager.checkpoint(f.episodeId,d=>{
    d.metadata.artifacts||={};d.metadata.stage_results||={};d.metadata.stage_qa||={};d.metadata.review_requests||={};
    d.metadata.tts_budget_context={quota_reserve_characters:1000};
    const next=d.actions.find(a=>a.stage===nextStage&&(nextStage!=='SHOT_REVIEW'||a.scene_id===last.shot_id));
    for(const a of d.actions)if(a.index<next.index){a.status='COMPLETE';a.evidence={provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true};}
    for(const shot of p.shot_plans){
      const id='video_'+shot.shot_id,a={artifact_id:id,episode_id:f.episodeId,stage_id:'VIDEO',provider_job_id:'job_'+id,
        sha256:sha256(bytes),bucket:'test-isolated',path:id+'.mp4',size:bytes.length,mime:'video/mp4'};
      f.objects.set(a.bucket+'/'+a.path,bytes);d.metadata.artifacts[id]=a;e.artifacts[id]=a;
      const key='video:'+shot.shot_id,claim='claim_'+id,result={status:'SUCCEEDED',episode_id:f.episodeId,stage_id:'VIDEO',artifacts:[a],
        provider_job_ids:[a.provider_job_id],claims:[claim],qa:{ok:true,status:'PASS',sha256:a.sha256},human_review_requirement:false};
      d.metadata.stage_results[key]={receipt_id:claim,hash_version:'CANONICAL_JSON_V1',sha256:inputDigest(result),result};
      d.metadata.stage_qa[key]=result.qa;
      f.journalRows.set(claim,{attempt_id:claim,episode_id:f.episodeId,stage:'VIDEO',provider_request_id:a.provider_job_id,state:'ACKNOWLEDGED'});
      if(shot!==last||nextStage==='TTS'){
        const r={review_request_id:'review_'+id,episode_id:f.episodeId,stage_id:'SHOT_REVIEW',action_key:'shot_review:'+shot.shot_id,
          artifact_id:id,artifact_sha:a.sha256,review_version:1,status:'APPROVED',allowed_actions:['APPROVE','REJECT'],continuation_applied:true,
          human_decision:{user:'1',chat_id:'1',message_id:138,callback_query_id:'fixture_prior_'+id,artifact_sha:a.sha256,review_version:1,status:'APPROVED'}};
        d.metadata.review_requests[r.review_request_id]=r;e.review_requests[r.review_request_id]=r;
      }
    }
  });
  await f.reviewStore.cas('1',row.revision,row.state);
}
export async function reviewCallback(f,decision='approve_stage'){
  const row=await f.reviewStore.get('1'),e=row.state.episodes[f.episodeId];
  const r=Object.values(e.review_requests).find(r=>r.status==='PENDING')||Object.values(e.review_requests).at(-1);
  const view=renderTelegramPanel(row.state,{kind:'review',episode_id:f.episodeId,request_id:r.review_request_id});
  row.state.tokens={...row.state.tokens,...view.tokens};await f.reviewStore.cas('1',row.revision,row.state);
  const token=Object.entries(view.tokens).find(([,t])=>t.action===decision)?.[0];
  return {id:'fixture_callback_'+decision,from:{id:'1'},message:{message_id:138,chat:{id:'1'}},data:'lr:'+token};
}
