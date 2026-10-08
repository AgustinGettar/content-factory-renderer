import {randomUUID} from 'node:crypto';
import {genericFixture} from './generic-v2.js';
import {MemoryLumiRecoveryStore} from '../../lib/lumi-recovery-incident-manager-v1.js';
import {IsolatedV2Validation} from '../../lib/lumi-v2-isolated-validation.js';
import {DIAGNOSTIC_OP,DIAGNOSTIC_SCOPE,DIAGNOSTIC_TTS_SCOPE,diagnosticOperationId} from '../../lib/lumi-v2-activation-context.js';
import {signRequest} from '../../lib/telegram-review-v1/make-transport.js';
import {mountMakeTransportEndpoint} from '../../lib/telegram-review-v1/make-endpoint.js';

export const secret='ISOLATED_LOCAL_TEST_ONLY_HMAC_NOT_A_CREDENTIAL_0123456789';
export async function isolatedFixture({store=new MemoryLumiRecoveryStore(),request,base,inject,clock,leaseMs,validateOwner=async u=>u==='local-operator',envPatch={},scope=DIAGNOSTIC_SCOPE,ttsFetch}={}){
  const key='isolated-local-validation',operation_id=diagnosticOperationId('local-operator',key,scope);
  const input=request||scope===DIAGNOSTIC_TTS_SCOPE?null:await genericFixture('diag_ep_'+operation_id.slice(8,64));
  request||=input?.request;
  base||={op:DIAGNOSTIC_OP,user_id:'local-operator',chat_id:'local-operator',operation_id,idempotency_key:key,
    scope,audience:'staging',expires_at:new Date(Date.now()+10*60000).toISOString(),
    dry_run:true,provider_generation:false,publication:false,telegram_mutation:false};
  const env={LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'local-operator',
    LUMI_TELEGRAM_CALLBACK_SECRET:secret,RENDER_GIT_COMMIT:'d3783b19bd45c39b2806a84882cfaed74288bd4f',...envPatch};
  const events=[],isolatedValidation=new IsolatedV2Validation({store,env,clock,leaseMs,validateOwner,ttsFetch,
    inject:async e=>{events.push(e);await inject?.(e);}});
  const forbidden=[];
  const forbiddenCall=name=>()=>{forbidden.push(name);throw Error('PRODUCTION_ACCESS_FORBIDDEN:'+name);};
  const productionStore={get:forbiddenCall('review.get'),cas:forbiddenCall('review.cas')};
  const routes=new Map(),app={get:(p,h)=>routes.set(p,h),post:(p,h)=>routes.set(p,h)};
  mountMakeTransportEndpoint(app,{store:productionStore,env,validateOwner,isolatedValidation,
    production:{create:forbiddenCall('production.create')},loadBytes:forbiddenCall('production.artifact')});
  const envelope=(phase,patch={},nonce=randomUUID())=>{
    const body={...base,phase,...(phase==='CONTEXT'?{request}:{}),...(phase==='REVIEW'?{decision:'APPROVED'}:{}),...patch};
    const signed={timestamp:String(Math.floor(Date.now()/1000)),requestId:nonce,method:'POST',path:'/lumi/telegram-review/make/v1',body:Buffer.from(JSON.stringify(body))};
    return {body,signed,signature:signRequest(secret,signed)};
  };
  const send=async e=>{
    const res={code:200,status(n){this.code=n;return this;},json(value){this.value=value;return this;}};
    await routes.get(e.signed.path)({body:e.body,rawBody:e.signed.body,path:e.signed.path,headers:{'x-lumi-timestamp':e.signed.timestamp,
      'x-lumi-request-id':e.signed.requestId,'x-lumi-signature':e.signature}},res);return res;
  };
  const call=(phase,patch)=>send(envelope(phase,patch));
  // Test driver only: each continuation is a separate authenticated HTTP call.
  const runPhase=async phase=>{
    for(let i=0;i<3;i++){
      const response=await call(phase);
      if(![200,202].includes(response.code)||!response.value.continuation_required)return response;
    }
    throw Error('ISOLATED_TEST_CONTINUATION_LIMIT');
  };
  const read=async()=>(await store.getEpisode(base.operation_id))?.metadata.isolated_validation;
  return {store,request,base,env,isolatedValidation,events,forbidden,routes,envelope,send,call,runPhase,read,cleanup:async()=>input?.cleanup()};
}
