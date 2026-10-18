import {installSupervisedActivation} from './lumi-supervised-activation.js';
import {createV2InputMaterializer,checkpointIdentity} from './lumi-v2-input-materializer.js';
import {PROFILE_SHA,LUMI_PRODUCTION_PROFILE_V2 as profile} from './lumi-production-profile-v2.js';
import {buildDirectedVideoPayload,buildSceneImagePayload} from './lumi-v2-executor-bindings.js';
import {estimateHiggsfieldUsd,supervisedRequestGate} from './higgsfield-usd-budget-v1.js';
import {submitSeriesProviderRequest} from './lumi-series-v2-execution.js';
import {sha256} from './telegram-review-v1/core.js';

// Reuse the materializer, provider contracts, quote gate and result orchestrator.
export function bindSupervisedRuntime(adapter,deps){
  const {manager,reviewStore,journal,artifactStorage,mediaTransport,env,fetchImpl,sealPayload,openPayload,receiptsFor}=deps;
  return installSupervisedActivation(adapter,{...deps,secret:env.LUMI_TELEGRAM_CALLBACK_SECRET,
    buildPayload:async(c,p)=>{
      const cp=c.checkpoint,action=c.action;
      if(!['IMAGE','VIDEO'].includes(action.stage))throw Error('REPLACEMENT_PROVIDER_BINDING_NOT_AVAILABLE');
      const model=action.stage==='IMAGE'?profile.image.model:profile.video.endpoint;
      if(model!==c.proposal.model||c.proposal.provider!=='higgsfield_api')throw Error('REPLACEMENT_PROVIDER_BINDING_CHANGED');
      const material=await createV2InputMaterializer({store:manager.store,storage:artifactStorage,reviewStore,journal,
        receipts:receiptsFor(p.user),library:adapter.assetLibrary,quoteOnly:'CURRENT_PAID_ACTION'})({episode_id:cp.episode_id,
        stage_id:action.stage,checkpoint_id:checkpointIdentity(cp),profile_version:profile.version,
        execution_context:{user:p.user,profile_sha:PROFILE_SHA,action_key:action.key}});
      const input=material.materialized_stage_input,shot=cp.metadata.generic_v2.shot_plans.find(s=>s.shot_id===action.scene_id);
      let expires=Infinity;
      const transport=async a=>{
        const signed=await mediaTransport(a),url=signed?.url&&new URL(signed.url),end=Date.parse(signed?.expires_at);
        if(!url||url.protocol!=='https:'||url.origin!==new URL(env.SUPABASE_URL).origin||url.username||url.password||url.hash
          ||url.pathname!=='/storage/v1/object/sign/'+a.bucket+'/'+a.path||!url.searchParams.get('token')
          ||signed.sha256!==a.sha256||!Number.isFinite(end)||end<=Date.now()+10000||end>Date.now()+300000)
          throw Error('REPLACEMENT_SIGNED_SOURCE_REQUIRED');
        expires=Math.min(expires,end);return url.href;
      };
      const source=await transport(action.stage==='IMAGE'?input.canonical_artifact:input.source.artifact);
      const refs=[];for(const ref of input.library_references||[])refs.push(await transport(ref));
      const payload=action.stage==='IMAGE'?buildSceneImagePayload(cp.metadata.generic_v2,shot,source,refs):
        buildDirectedVideoPayload({episodeId:cp.episode_id,shotId:shot.shot_id,source:input.source,packet:input.director_packet,sourceUrl:source});
      const body=JSON.stringify(payload);
      return {payload_sha256:sha256(body),private_payload:sealPayload(body,c.proposal.replacement_proposal_id),expires_at:new Date(expires).toISOString()};
    },openPayload,
    quotePayload:async(c,g,body)=>{
      if(sha256(body)!==g.payload_sha256||Date.parse(g.expires_at)<=Date.now())throw Error('REPLACEMENT_PAYLOAD_EXPIRED');
      const p=c.proposal;let used=false;
      const result=await estimateHiggsfieldUsd({apiKey:env.HF_API_KEY,model:p.model,input:JSON.parse(body),fetchImpl:(url,options)=>{
        if(used||url!=='https://api.higgsfield.ai/estimate/'+p.model||options.method!=='POST'||options.body!==body)throw Error('REPLACEMENT_ESTIMATE_ONLY');
        used=true;return fetchImpl(url,{...options,redirect:'error'});
      }});
      const gate=supervisedRequestGate({quote:{status:'QUOTE_VERIFIED',http_status:result.http_status,quote_usd:result.estimated_cost_usd,
        quote_timestamp:result.quoted_at,quote_expiration:result.quote_expiration,payload_sha256:result.payload_sha256},
        payloadSha:g.payload_sha256,payloadExpiresAt:g.expires_at,maxReservationUsd:p.maximum_new_reservation});
      return {status:'QUOTED',currency:'USD',quote_id:sha256(g.authorization_reference+':'+result.quoted_at),episode_id:p.episode_id,
        action_id:p.action_id,replacement_proposal_id:p.replacement_proposal_id,operation_id:p.planned_operation_id,attempt_id:p.planned_attempt_id,
        model:p.model,payload_sha256:result.payload_sha256,estimate_usd:gate.estimate_usd,reserve_usd:gate.reserve_usd,created_at:result.quoted_at,
        expires_at:new Date(Math.min(Date.parse(g.expires_at),Date.parse(result.quoted_at)+60000,result.quote_expiration?Date.parse(result.quote_expiration):Infinity)).toISOString()};
    },
    submitPayload:Object.assign(({proposal,payload,submit})=>submitSeriesProviderRequest({model:proposal.model,input:JSON.parse(payload),
      apiKey:env.HF_API_KEY,attemptId:proposal.planned_idempotency_key,submit}),{fetch:(url,options)=>fetchImpl(url,{...options,redirect:'error'})})
  });
}
