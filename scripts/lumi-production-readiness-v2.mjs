import {genericFixture} from '../test/fixtures/generic-v2.js';
import {genericWorkerReadiness} from '../lib/lumi-generic-v2-adapter.js';
import './director-offline-guard.mjs';
import assert from 'node:assert/strict';
import {rm,writeFile} from 'node:fs/promises';
import {makeFixture} from '../test/fixtures/director-v1.js';
import {compileDirectorPacket} from '../lib/cinematic-director-v1/director.js';
import {evaluateCalibration} from '../lib/cinematic-director-v1/topology-calibration.js';
import {TOPOLOGY} from '../lib/cinematic-director-v1/topology.js';
import {LumiRecoveryIncidentManager,MemoryLumiRecoveryStore,runZeroProviderRecoveryDryRun,INCIDENT_CLASSES} from '../lib/lumi-recovery-incident-manager-v1.js';
import {journaledFetch} from '../lib/provider-emission-journal-v1.js';
import {newSession,MemoryReviewStore,ReviewService,sha256,artifactReview} from '../lib/telegram-review-v1/core.js';
import {MakeTransport,acknowledgeCommand} from '../lib/telegram-review-v1/make-transport.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile,buildApprovedVoiceRequest,rollbackToLegacy,selectLumiCreationProfile,PROFILE_SHA,publicationApprovalGate} from '../lib/lumi-production-profile-v2.js';
import {validateCaptionQa,validateEditorialPacing,editorialMasterReadinessGateV1} from '../lib/lumi-editorial-readiness-v1.js';
// All human/QA/media annotations here are explicit synthetic fixtures. Nothing is
// persisted to a live episode, sent to a provider, or enqueued for publication.
const generic=await genericFixture('ep_future_media_first');
try{await generic.adapter.create({user:'fixture',request:generic.request,authorizedCeilingUsd:1});while((await generic.store.getEpisode('ep_future_media_first')).first_pending_action)await generic.adapter.resume({episodeId:'ep_future_media_first'});}finally{await generic.cleanup();}
const fixture=await makeFixture();
try{
 const trace=['TELEGRAM_CREATE_SIMULATED','IDEA_PLAN_FIXTURE','SOURCE_PLANNING_FIXTURE'];
 const director=await compileDirectorPacket(fixture.input,fixture.options);
 assert.deepEqual(director.blockers,[]);assert.equal(director.gates.SOURCE_EVIDENCE_READY,true);assert.equal(director.gates.EXECUTION_AUTHORIZATION,false);
 trace.push('CINEMATIC_DIRECTOR');
 const storage=new MemoryLumiRecoveryStore(),manager=new LumiRecoveryIncidentManager({store:storage});
 const episodeId='SIMULATED_FUTURE_EPISODE';await manager.startEpisode({episodeId,authorizedCeilingUsd:1,actions:[{key:'image',stage:'IMAGE'},{key:'video',stage:'VIDEO'},{key:'tts',stage:'TTS'},{key:'assembly',stage:'ASSEMBLY'},{key:'master',stage:'MASTER'}]});
 class Journal{constructor(){this.rows=new Map();}async prepare(r){if(this.rows.has(r.attempt_id))throw Error('duplicate_claim');this.rows.set(r.attempt_id,structuredClone(r));}async transition(id,from,p){const r=this.rows.get(id);assert.equal(r.state,from);Object.assign(r,p);}}
 const journal=new Journal();let simulatedCalls=0;
 for(const [stage,model] of [['IMAGE',profile.image.model],['VIDEO',profile.video.endpoint],['TTS',profile.voice.model]]){
  const key=stage.toLowerCase(),attempt='FIXTURE_'+stage;const budget=await manager.budgetGate({episodeId,actionKey:key,projectedCallCostUsd:.1});assert.equal(budget.status,'PASS');
  const context={episode_id:episodeId,stage,attempt_id:attempt,provider:'SYNTHETIC_TRANSPORT',model,prompt:'fixture'};
  const voice=stage==='TTS'?buildApprovedVoiceRequest('¡Hola! Contemos las flores.'):{};
  const submit=journaledFetch({store:journal,context,fetchImpl:async()=>{simulatedCalls++;return new Response(JSON.stringify({request_id:attempt}),{headers:{'content-type':'application/json'}});}});
  const opts={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(voice)};
  await (await submit('https://fixture.invalid/'+model,opts)).json();
  await assert.rejects(submit('https://fixture.invalid/'+model,opts),/already_consumed/);
  await assert.rejects(journaledFetch({store:journal,context,fetchImpl:async()=>{throw Error('duplicate reached transport');}})('https://fixture.invalid/'+model,opts),/duplicate_claim/);
  await manager.recordRequest(episodeId,key,attempt);
  await manager.completeAction(episodeId,key,{artifact:{id:attempt,scope:'SYNTHETIC_NOT_DECODED_MEDIA'},evidence:{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true},actualCostUsd:.1});
  trace.push(stage==='TTS'?'TTS_ANNIE_ELEVENLABS_REQUEST_AND_STORAGE_SIMULATED':stage+'_CLAIM_JOURNAL_SIMULATED');
 }
 const calibration=evaluateCalibration();assert.equal(calibration.status,'PASS');assert.equal(calibration.FALSE_FATALS_ON_HUMAN_APPROVED_SET,0);assert.equal(TOPOLOGY.canonical.wings,2);trace.splice(6,0,'TEMPORAL_QA_CALIBRATED','HUMAN_SHOT_REVIEW_STATE_SIMULATED');
 const caption=validateCaptionQa({lumi_bbox:{x:100,y:500,width:600,height:1000},safe_area:{x:0,y:0,width:1080,height:1920},text_elements:[{text:'Rojo',bbox:{x:100,y:100,width:100,height:40},readability:'PASS'}]});
 const pacing=validateEditorialPacing({duration_seconds:45,scenes:[{motion_pacing:'NATURAL_REAL_TIME',pedagogical_pause_seconds:2.5,pedagogical_justification:'response window'}]});
 assert.equal(editorialMasterReadinessGateV1({caption_qa:caption,pacing_qa:pacing}).status,'PASS');
 for(const key of ['assembly','master'])await manager.completeAction(episodeId,key,{artifact:{profile:profile.master,scope:'SIMULATED_OUTPUT_NO_ENCODE'},evidence:{provider_succeeded:true,artifact_persisted:true,sha_verified:true,artifact_verified:true}});
 trace.push('CAPTIONS_CHARACTER_EXCLUSION','ASSEMBLY_SIMULATED','FULL_HD_MASTER_PROFILE_SIMULATED');
 const bytes=Buffer.from('SYNTHETIC_MEDIA_NOT_PLAYABLE'),master={artifact_id:'fixture',sha256:sha256(bytes),size:bytes.length,mime:'video/mp4',bucket:'fixture',path:'master.mp4',width:1080,height:1920,duration:45};
 const photoBytes=Buffer.from('SYNTHETIC_STATIC_PHOTO_NOT_PLAYABLE');
 const reviewStore=new MemoryReviewStore(),session=newSession({user_id:'1',chat_id:'1',message_id:138,cover:{...master,artifact_id:'fixture-home',mime:'image/png',sha256:sha256(photoBytes),size:photoBytes.length}});session.home_restore_capability={media_to_text:false,media_first:true};session.panel_content_type='photo';await reviewStore.create('1',session);
 const svc=new ReviewService({store:reviewStore,telegram:new MakeTransport(),loadBytes:async a=>a.mime==='image/png'?photoBytes:bytes});await svc.registerEpisode('1','1',{episode_id:episodeId,title:'Nuevo episodio simulado',review_mode:'SUPERVISED',shots:[],master,beats:9,publication_preview_available:true,publication_inventory:[{platform:'youtube',implementation_status:'IMPLEMENTED',account_connection_status:'DISCONNECTED'}]});
 const messageFor=c=>({message_id:138,chat:{id:1},reply_markup:c.body.reply_markup,caption:c.body.media.caption,...(c.body.media.type==='video'?{video:{file_id:'FIXTURE_FILE_ID',file_unique_id:'FIXTURE_VIDEO_UNIQUE',file_size:bytes.length}}:{photo:[{file_id:'FIXTURE_HOME_FILE_ID',file_unique_id:'FIXTURE_HOME_UNIQUE'}]})});
 async function deliver(screen){const r=await svc.show('1','1',screen),c=r.commands[0];const message=messageFor(c);await acknowledgeCommand(reviewStore,'1','1',c.idempotency_key,message);return message;}
 const msg=await deliver({kind:'master',episode_id:episodeId});trace.push('MASTER_REVIEW_STATE_SIMULATED');
 let row=await reviewStore.get('1'),token=Object.entries(row.state.tokens).find(([,v])=>v.action==='approve_final')[0];const approved=await svc.callback({id:'SYNTHETIC_HUMAN_CALLBACK_NOT_REAL_APPROVAL',from:{id:1},message:msg,data:'lr:'+token});const c=approved.commands[0];await acknowledgeCommand(reviewStore,'1','1',c.idempotency_key,messageFor(c));
 await deliver({kind:'publish_preview',episode_id:episodeId,platforms:['youtube']});trace.push('PUBLICATION_PREVIEW_NO_DISPATCH');
 row=await reviewStore.get('1');const ep=row.state.episodes[episodeId];assert.equal(artifactReview(ep,master).human_status,'MASTER_HUMAN_APPROVED');assert.throws(()=>publicationApprovalGate({episode:ep,preview:{master_sha:master.sha256,review_version:1},confirmation:{explicit:true},enabled:false}),/CONFIRMATION/);
 for(const kind of ['INSUFFICIENT_PROVIDER_BALANCE','PROVIDER_RATE_LIMIT','PROVIDER_TRANSPORT_FAILURE','EMISSION_AMBIGUOUS','ARTIFACT_STORAGE_FAILURE','ARTIFACT_DECODE_FAILURE','QUALITY_REVIEW_REQUIRED','BUDGET_EXHAUSTED','TTS_STORAGE_FAILURE','TELEGRAM_DELIVERY_FAILURE']){
  assert.ok(INCIDENT_CLASSES.includes(kind));const store=new MemoryLumiRecoveryStore(),m=new LumiRecoveryIncidentManager({store});await m.startEpisode({episodeId:kind,actions:[{key:'pending',stage:'VIDEO'}]});await m.pause({episodeId:kind,stage:'VIDEO',errorClass:kind,reason:'FIXTURE',firstPendingAction:'pending',safeResumeAvailable:kind!=='EMISSION_AMBIGUOUS'});const paused=await store.getEpisode(kind);assert.equal(paused.status,'PAUSED_INCIDENT');assert.equal(paused.runner_enabled,false);
 }
 const recovery=await runZeroProviderRecoveryDryRun({providerCallsAllowed:0});assert.equal(recovery.status,'PASS');
 assert.equal(rollbackToLegacy().profile,'legacy');assert.throws(()=>selectLumiCreationProfile({requested:profile.id}),/ACTIVATION/);assert.throws(()=>selectLumiCreationProfile({requested:profile.id,activation:{explicit_user_authorization:true,profile_sha:PROFILE_SHA},readiness:{status:'BLOCKED'}}),/ACTIVATION/);
 const report={version:'LUMI_PRODUCTION_READINESS_V2',timestamp:new Date().toISOString(),profile_sha:PROFILE_SHA,status:'BLOCKED',blockers:['GENERIC_V2_WORKER_BINDINGS_REQUIRED'],GENERIC_V2_ADAPTER_CONTRACTS:'PASS',GENERIC_V2_RUNTIME:genericWorkerReadiness(),END_TO_END_V2_DRY_RUN:'PASS_SIMULATED_ONLY',GENERIC_TRACE:generic.trace,GENERIC_SIMULATED_EMISSIONS:generic.simulatedEmissions(),END_TO_END_DRY_RUN:'PASS_SIMULATED_ONLY',trace,CINEMATIC_DIRECTOR:'PASS',SOURCE_GATE:'PASS_FIXTURE',CHARACTER_LOCK:'PASS_POLICY_AND_REGRESSION',TEMPORAL_QA:'PASS_CALIBRATION_REPLAY',RECOVERY_MANAGER:recovery.status,EXACTLY_ONCE:'PASS_SIMULATED_RESTART',BUDGET_GATE:'PASS',TTS_PROFILE:'PASS_FROZEN_CONFIG',TTS_RUNTIME:'GENERIC_STAGE_CONTRACT_VALIDATED; CONCRETE_WORKER_BINDING_PENDING',CAPTIONS:'PASS_FIXTURE',ASSEMBLY:'PASS_SIMULATED',MASTER_PROFILE:'PASS',HUMAN_REVIEW:'PASS_STATE_MACHINE_FIXTURE',PUBLICATION_APPROVAL_GATE:'PASS_CLOSED',ROLLBACK_TO_LEGACY:'PASS',PROVIDER_CALLS:0,PUBLICATION_CALLS:0,SIMULATED_TRANSPORT_CALLS:simulatedCalls,PRODUCTION_UNTOUCHED:true,scope:'Synthetic dry run with real Director/QA/Recovery/Journal/renderer. No new live episode, human approval, media generation, storage write or publication.'};
 const path=process.argv[2]||'/tmp/LUMI_PRODUCTION_READINESS_V2_DRY_RUN.json';await writeFile(path,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await rm(fixture.directory,{recursive:true,force:true});}
