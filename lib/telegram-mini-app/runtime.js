import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {MiniAppAuth,MINI_COOKIE,MINI_ORIGIN,MINI_PATH,miniAppEnabled,miniAppSecret,miniAuthConfigured,mutateMiniState,sessionCookie} from './auth.js';
import {authenticateMiniAppCommand,FIRST_IMAGE_EPISODE,inputDigest} from '../lumi-v2-activation-context.js';
import {persistStageDecision,validateArtifact} from '../telegram-review-v1/core.js';
import {Q41_ONE_TAP_POLICY,assertQ41Policy,sealQ41Consent,assertQ41Consent} from './q41-policy.js';

const hash=s=>createHash('sha256').update(s).digest('hex');
const iso=()=>new Date().toISOString();
const envMenuVerified=env=>env.LUMI_TELEGRAM_BOT_ID==='8843261381'&&Number.isFinite(Date.parse(env.LUMI_MINI_APP_MENU_VERIFIED_AT||''));
const fail=(code,status=409)=>{throw Object.assign(Error(code),{status});};
const terminal=new Set(['COMPLETE','BLOCKED']);
const actions={quote:'q41_video_quote',authorize:'q41_video_authorize',generate:'q41_video_generate',recover:'q41_stage_recover',continue:'q41_local_continue',review:'mini_review'};
const labels={PLANNING:'Historia',SOURCE_PLANNING:'Plan de escenas',IMAGE:'Imagen',SOURCE_QA:'Revisión de imagen',DIRECTOR:'Dirección',VIDEO:'Animación',TEMPORAL_QA:'Calidad del clip',SHOT_REVIEW:'Revisión humana',TTS:'Voz',TTS_STORAGE:'Audio',CAPTIONS:'Subtítulos',ASSEMBLY:'Montaje',MASTER:'Master',MASTER_REVIEW:'Revisión final'};
const publicOperation=o=>o?{id:o.id,kind:o.kind,status:o.status,phase:o.phase??null,started_at:o.started_at,finished_at:o.finished_at??null,error:o.error??null,resume_available:o.resume_available===true}:null;
const quoteFields=['quote_id','quote_sha','quote_version','status','budget_gate','quote_usd','proposed_reserve_usd','expires_at','remaining_before_usd','remaining_after_usd','existing_exposure_usd','hard_budget_usd','actual_cost_usd'];

export class MiniAppService {
  constructor({store,adapter,production,loadBytes,env,oneTapPolicy=Q41_ONE_TAP_POLICY}){Object.assign(this,{store,adapter,production,loadBytes,env,oneTapPolicy});this.inflight=new Map();this.mediaCache=new Map();this.recoveryTimers=new Map();}
  async context(p){
    const status=await this.adapter.miniAppStatus(p),row=await this.store.get(p.user);
    return {...status,state:row.state};
  }
  catalog({checkpoint:cp,state}){
    const found=new Map();
    const add=(episode,a,role,label)=>{try{validateArtifact(a);}catch{return;}const id=hash(episode+':'+a.artifact_id+':'+a.sha256);found.set(id,{id,episode,a,role,label});};
    for(const [episode,e] of Object.entries(state.episodes||{})){
      for(const a of Object.values(e.artifacts||{}))add(episode,a,a.mime.startsWith('image/')?'source':'clip',a.mime.startsWith('image/')?'Imagen de la escena':'Clip de la escena');
      for(const s of e.shots||[])if(s.artifact)add(episode,s.artifact,'clip','Animación '+s.shot_id.replace('q4',''));
      if(e.master)add(episode,e.master,'master','Video final');
    }
    for(const a of Object.values(cp.metadata.artifacts||{}))add(cp.episode_id,a,a.mime.startsWith('image/')?'source':a.mime.startsWith('video/')?'clip':'audio',a.mime.startsWith('image/')?'Imagen aprobada · Escena 1':'Medio de producción');
    return found;
  }
  mediaTicket(p,id,expires){return createHmac('sha256',miniAppSecret(this.env)).update('lumi-mini-media:'+ [p.session,id,expires].join(':')).digest('hex');}
  async view(p){
    const ctx=await this.context(p),{checkpoint:cp,quote:q,budget:b,state}=ctx;
    const expires=Math.min(p.expires_at,Date.now()+300000);
    const media=[...this.catalog(ctx).values()].map(({id,episode,a,role,label})=>({id,episode,role,label,mime:a.mime,width:a.width,height:a.height,
      url:MINI_PATH+'/api/media/'+id+'?expires='+expires+'&ticket='+this.mediaTicket(p,id,expires),expires_at:expires}));
    const operation=state.mini_app?.operations?.[state.mini_app.active_operation];
    // A process may die after saving the canonical result and before its UI receipt.
    // Recover the receipt from durable evidence; never repeat the request.
    let op=operation;
    if(op?.kind==='first_animation'){
      // Status reads may recover an accepted job, but NEVER start or restart a submission.
      const a=cp.actions.find(a=>a.key==='video:q41');
      if(a?.artifact&&Object.values(cp.metadata.review_requests||{}).some(r=>r.action_key==='video:q41')){
        if(op.status!=='COMPLETE')await mutateMiniState(this.store,p.user,m=>Object.assign(m.operations[op.id],{status:'COMPLETE',phase:'REVIEW_READY',finished_at:iso()}));
        op={...op,status:'COMPLETE',phase:'REVIEW_READY'};
      }else if(ctx.q41_emission?.state==='ACKNOWLEDGED'&&ctx.q41_emission.request_id){
        if(op.phase!=='GENERATING'||op.status!=='RUNNING')await mutateMiniState(this.store,p.user,m=>Object.assign(m.operations[op.id],{status:'RUNNING',phase:'GENERATING',binding:{...op.binding,action:'q41_stage_recover'}}));
        op={...op,status:'RUNNING',phase:'GENERATING'};this.scheduleRecovery(p,op.id);
      }
      if(op.status==='RUNNING'&&!['GENERATING','REVIEW_READY'].includes(op.phase)&&Date.now()-Date.parse(op.started_at)>120000&&!this.inflight.has(p.user+':'+op.id))op={...op,status:'RECOVERY_REQUIRED',resume_available:false};
    }else if(op&&!terminal.has(op.status)){
      const quoteDone=op.kind==='quote'&&q?.quote_id&&q.quote_id!==op.binding.quote_id&&q.status!=='QUOTE_RESULT_UNKNOWN';
      const authorized=op.kind==='authorize'&&state.production_commands?.[op.binding.quote_id]?.human_authorization?.mini_app_operation_id===op.id;
      const dispatched=op.kind==='generate'&&state.production_commands?.['dispatch:'+op.binding.quote_id];
      if(quoteDone||authorized||dispatched){
        await mutateMiniState(this.store,p.user,m=>{const prior=m.operations[op.id];if(prior&&!terminal.has(prior.status))Object.assign(prior,{status:'COMPLETE',finished_at:iso()});});
        op={...op,status:'COMPLETE'};
      }else if(Date.now()-Date.parse(op.started_at)>120000&&!this.inflight.has(p.user+':'+op.id))op={...op,status:'RECOVERY_REQUIRED',resume_available:op.status==='QUEUED'||op.kind==='quote'};
    }
    const current=cp.actions.find(a=>a.key===cp.first_pending_action);
    const canQuote=cp.status==='RUNNING'&&current?.status==='PENDING'&&current?.dispatch_state==='NOT_DISPATCHED'&&['IMAGE','VIDEO','TTS'].includes(current?.stage);
    const quote= q?Object.fromEntries(quoteFields.filter(k=>k in q).map(k=>[k,q[k]])):null;
    const reviews=Object.values(cp.metadata.review_requests||{}).filter(r=>r.status==='PENDING').map(r=>({id:r.review_request_id,stage:r.stage_id,
      artifact_sha:r.artifact_sha,version:r.review_version,contract_sha:r.review_contract?inputDigest(r.review_contract):null,
      media_id:[...this.catalog(ctx).values()].find(x=>x.a.sha256===r.artifact_sha)?.id}));
    return {version:1,server_time:Date.now(),episode:{id:cp.episode_id,title:cp.metadata.generic_v2.plan.episode.title,status:cp.status,
      last_completed:cp.last_completed_action,next_action:cp.first_pending_action,director_complete:cp.actions.some(a=>a.key==='director:q41'&&a.status==='COMPLETE'),
      source_approved:Object.values(cp.metadata.review_requests||{}).some(r=>r.action_key==='image:q41'&&r.status==='APPROVED'),
      actions:cp.actions.map(a=>({key:a.key,label:labels[a.stage]||'Producción',shot:a.scene_id,status:a.status,current:a.key===cp.first_pending_action}))},
      episodes:Object.entries(state.episodes||{}).map(([id,e])=>({id,title:e.title||'Video de Lumi',has_master:!!e.master})),media,reviews,
      budget:{ceiling_usd:b.episode_ceiling_usd,exposure_usd:b.required_total_usd,remaining_usd:Number((b.episode_ceiling_usd-b.required_total_usd).toFixed(6)),
        actual_cost_usd:null,actual_cost_status:'NOT_VERIFIED',gate:b.status},quote,operation:publicOperation(op),
      first_animation:{...this.oneTapPolicy,available:canQuote&&cp.first_pending_action==='video:q41'&&!Object.values(state.mini_app?.operations||{}).some(o=>o.kind==='first_animation')},
      capabilities:{quote:canQuote,authorize:canQuote&&q?.status==='AWAITING_HUMAN_AUTHORIZATION'&&q.budget_gate==='PASS',
        generate:canQuote&&q?.status==='HUMAN_SPEND_AUTHORIZED'&&q.budget_gate==='PASS',
        recover:current?.status==='PENDING'&&['DISPATCHING','ACKNOWLEDGED'].includes(current?.dispatch_state)&&['IMAGE','VIDEO'].includes(current?.stage),
        continue:cp.status==='RUNNING'&&current?.status==='PENDING'&&current?.dispatch_state==='NOT_DISPATCHED'&&!['IMAGE','VIDEO','TTS'].includes(current?.stage)&&!reviews.length},
      settings:{environment:'staging',supervised:true,publication:false,autorun:cp.autorun,runners:cp.runner_enabled?'ON':'OFF',
        higgsfield:!!this.env.HF_API_KEY,elevenlabs:!!this.env.ELEVENLABS_API_KEY,telegram:true,video_model:'Kling 3.0 Pro',duration_seconds:4,audio:false,
        entrypoint:state.mini_app?.entrypoint?.status||(envMenuVerified(this.env)?'CONFIGURED':'PENDING')}};
  }
  async enqueue(p,kind,body){
    if(kind==='first_animation'){
      if(Object.keys(body).length!==1||body.confirm!==true)fail('MINI_BODY_INVALID',400);
      const ctx=await this.context(p),existing=Object.values(ctx.state.mini_app?.operations||{}).find(o=>o.kind==='first_animation');
      if(existing)return {operation:publicOperation(existing),dispatch:async()=>{}};
      const {cp}=await this.adapter.miniAppFirstAnimationContext(p);assertQ41Policy(cp,this.oneTapPolicy);
      if(cp.first_pending_action!=='video:q41')fail('Q41_ONE_TAP_SCOPE_REQUIRED');
      const id=hash(FIRST_IMAGE_EPISODE+':video:q41:ONE_TAP_V1'),consent=sealQ41Consent({cp,policy:this.oneTapPolicy,user:p.user,chat:p.chat,operationId:id},this.env);
      const op=await mutateMiniState(this.store,p.user,m=>{
        if(m.operations[id])return structuredClone(m.operations[id]);
        const active=m.operations[m.active_operation];if(active&&!terminal.has(active.status))fail('MINI_OPERATION_IN_PROGRESS');
        const next={id,kind,status:'QUEUED',phase:'VERIFYING_SOURCE',consent,session_id:p.session,started_at:iso(),
          binding:{action:'q41_video_authorize',proposal_id:FIRST_IMAGE_EPISODE,next_action:'video:q41',checkpoint_version:cp.metadata.runtime_revision}};
        m.operations[id]=next;m.active_operation=id;return structuredClone(next);
      });
      return {operation:publicOperation(op),dispatch:()=>this.run(p,op.id)};
    }
    if(kind==='resume'){
      if(Object.keys(body).length)fail('MINI_BODY_INVALID',400);
      await this.context(p);
      const op=await mutateMiniState(this.store,p.user,m=>{
        const prior=m.operations[m.active_operation];
        if(!prior||terminal.has(prior.status))fail('MINI_NO_PENDING_OPERATION');
        if(this.inflight.has(p.user+':'+prior.id))return structuredClone(prior);
        // A queued action has never entered the executor. An interrupted quote
        // may re-enter only its original lineage, whose canonical claim prevents
        // any repeated estimate. A started generation is NEVER replayed here.
        if(prior.kind==='first_animation'||prior.status!=='QUEUED'&&(prior.kind!=='quote'||Date.now()-Date.parse(prior.started_at)<120000))fail('MINI_RECONCILIATION_REQUIRED');
        Object.assign(prior,{status:'QUEUED',session_id:p.session});return structuredClone(prior);
      });
      return {operation:publicOperation(op),dispatch:()=>this.run(p,op.id)};
    }
    if(!actions[kind])fail('MINI_ACTION_INVALID',400);
    const allowed=['quote_id','quote_sha','confirm','request_id','decision','artifact_sha','review_version','full_playback','source_comparison','pose','wand_hand'];
    if(Object.keys(body).some(k=>!allowed.includes(k)))fail('MINI_BODY_INVALID',400);
    const ctx=await this.context(p),{checkpoint:cp,quote:q,state}=ctx;
    let binding={action:actions[kind],proposal_id:FIRST_IMAGE_EPISODE,next_action:cp.first_pending_action,checkpoint_version:cp.metadata.runtime_revision};
    if(['quote','authorize','generate'].includes(kind)){
      if((q?.quote_id??null)!==(body.quote_id??null)||(q?.quote_sha??null)!==(body.quote_sha??null))fail('MINI_QUOTE_CHANGED');
      Object.assign(binding,{quote_id:q?.quote_id??null,quote_sha:q?.quote_sha??null});
      if(kind!=='quote'&&(body.confirm!==true||!q||q.budget_gate!=='PASS'||Date.parse(q.expires_at)<=Date.now()))fail('MINI_CURRENT_QUOTE_REQUIRED');
      if(kind==='authorize'&&q.status!=='AWAITING_HUMAN_AUTHORIZATION'&&q.status!=='HUMAN_SPEND_AUTHORIZED')fail('MINI_CURRENT_QUOTE_REQUIRED');
      if(kind==='generate'&&q.status!=='HUMAN_SPEND_AUTHORIZED')fail('MINI_SPEND_APPROVAL_REQUIRED');
    }
    if(kind==='review'){
      const r=cp.metadata.review_requests?.[body.request_id];
      if(!r||r.status!=='PENDING'||r.artifact_sha!==body.artifact_sha||r.review_version!==body.review_version||!['APPROVED','REJECTED'].includes(body.decision))fail('MINI_REVIEW_STALE');
      binding={...binding,request_id:body.request_id,artifact_sha:r.artifact_sha,review_version:r.review_version,decision:body.decision,
        checklist_decision:r.review_contract?{contract_sha:inputDigest(r.review_contract),full_playback:body.full_playback===true,source_comparison:body.source_comparison===true,pose:body.pose,wand_hand:body.wand_hand}:null};
    }
    if(kind==='recover')Object.assign(binding,{quote_id:q?.quote_id??null,quote_sha:q?.quote_sha??null});
    const stable=hash(JSON.stringify({kind,binding}));
    const op=await mutateMiniState(this.store,p.user,m=>{
      const active=m.operations[m.active_operation];
      if(active&&!terminal.has(active.status))return structuredClone(active);
      const id=kind==='recover'?hash(stable+':'+Object.keys(m.operations).length):stable;
      if(m.operations[id])return structuredClone(m.operations[id]);
      const next={id,kind,status:'QUEUED',binding,session_id:p.session,started_at:iso()};m.operations[id]=next;m.active_operation=id;return structuredClone(next);
    });
    return {operation:publicOperation(op),dispatch:()=>this.run(p,op.id)};
  }
  async run(p,id){
    const key=p.user+':'+id;if(this.inflight.has(key))return this.inflight.get(key);
    const work=(async()=>{
      const admitted=await mutateMiniState(this.store,p.user,m=>{const o=m.operations[id];if(o?.status!=='QUEUED')return null;
        if(o.session_id!==p.session)fail('MINI_SESSION_REQUIRED',401);o.status='RUNNING';return structuredClone(o);});
      if(!admitted)return;
      try{
        if(admitted.kind==='first_animation'){await this.runFirstAnimation(p,id);return;}
        const command=authenticateMiniAppCommand({principal:p,operationId:id});
        let result;
        if(admitted.kind==='quote')result=await this.adapter.prepareEp004VideoQuote({user:p.user,chat:p.chat,renew:true,expectedQuoteId:admitted.binding.quote_id,miniAppPrincipal:p});
        if(admitted.kind==='authorize')result=await this.adapter.authorizeEp004VideoQuote({command});
        if(admitted.kind==='generate')result=await this.adapter.executeQuotedStage({command});
        if(admitted.kind==='recover')result=await this.adapter.recoverQuotedStage({command});
        if(admitted.kind==='continue')result=await this.adapter.continueLocalStage({command});
        if(admitted.kind==='review'){
          const b=admitted.binding;
          result=await persistStageDecision({store:this.store,production:this.production,user:p.user,chat:p.chat,episodeId:FIRST_IMAGE_EPISODE,
            requestId:b.request_id,decision:b.decision,artifactSha:b.artifact_sha,reviewVersion:b.review_version,
            evidence:{channel:'TELEGRAM_MINI_APP',mini_app_operation_id:id,checklist_decision:b.checklist_decision}});
        }
        await mutateMiniState(this.store,p.user,m=>Object.assign(m.operations[id],{status:'COMPLETE',finished_at:iso(),result_status:result?.status??null}));
      }catch(e){
        const error=/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:'MINI_ACTION_REQUIRES_RECOVERY';
        await mutateMiniState(this.store,p.user,m=>Object.assign(m.operations[id],{status:'BLOCKED',finished_at:iso(),error}));
      }
    })();this.inflight.set(key,work);try{await work;}finally{this.inflight.delete(key);}
  }
  async oneTapPhase(p,id,phase,patch={}){
    return mutateMiniState(this.store,p.user,m=>{const op=m.operations[id];if(op?.kind!=='first_animation'||op.status!=='RUNNING')fail('MINI_OPERATION_CHANGED');
      Object.assign(op,patch,{phase,phase_updated_at:iso()});return structuredClone(op);});
  }
  async runFirstAnimation(p,id){
    const command=authenticateMiniAppCommand({principal:p,operationId:id});
    // Renew only completed, unambiguous, expired quote versions. Bounded to
    // avoid a slow estimator causing an unbounded request loop.
    for(let renewal=0;renewal<3;renewal++){
      const ctx=await this.context(p),op=ctx.state.mini_app.operations[id];assertQ41Consent(op,this.env,ctx.checkpoint);
      await this.oneTapPhase(p,id,'QUOTING');
      const q=await this.adapter.prepareEp004VideoQuote({user:p.user,chat:p.chat,renew:true,expectedQuoteId:ctx.quote?.quote_id??null,miniAppPrincipal:p});
      const fresh=await this.context(p);
      if(q.status==='QUOTE_EXPIRED')continue;
      assertQ41Consent(op,this.env,fresh.checkpoint,q);
      if(!['AWAITING_HUMAN_AUTHORIZATION','HUMAN_SPEND_AUTHORIZED'].includes(q.status))fail('Q41_ONE_TAP_QUOTE_UNCONFIRMED');
      if(Date.parse(q.expires_at)<=Date.now())continue;
      const current=await this.oneTapPhase(p,id,'BUDGET_CHECK',{binding:{...op.binding,action:'q41_video_authorize',quote_id:q.quote_id,quote_sha:q.quote_sha},
        quote_binding:{quote_id:q.quote_id,quote_sha:q.quote_sha,quote_usd:q.quote_usd,quote_timestamp:q.quote_timestamp,quote_expiration:q.expires_at,payload_sha256:q.payload_sha256,operation_id:id}});
      // Same canonical authorization and Budget Gate as the supervised flow.
      try{await this.adapter.authorizeEp004VideoQuote({command});}
      catch(e){if(e.message==='Q41_VIDEO_CURRENT_QUOTE_REQUIRED'&&Date.parse(q.expires_at)<=Date.now())continue;throw e;}
      if(Date.parse(q.expires_at)<=Date.now())continue;
      await this.oneTapPhase(p,id,'DISPATCHING',{binding:{...current.binding,action:'q41_video_generate'}});
      let result;
      try{result=await this.adapter.executeQuotedStage({command});}
      catch(e){
        const current=await this.context(p),a=current.checkpoint.actions.find(a=>a.key==='video:q41');
        if(Date.parse(q.expires_at)<=Date.now()&&!current.state.production_commands?.['dispatch:'+q.quote_id]
          &&!current.q41_emission&&a?.dispatch_state==='NOT_DISPATCHED'&&!current.checkpoint.metadata.budget_reservations?.['video:q41'])continue;
        throw e;
      }
      if(!['IN_PROGRESS','WAITING_EXISTING_RESULT'].includes(result?.status))fail('Q41_ONE_TAP_DISPATCH_REQUIRES_RECOVERY');
      await this.oneTapPhase(p,id,'GENERATING',{binding:{...current.binding,action:'q41_stage_recover'}});
      this.scheduleRecovery(p,id);return;
    }
    fail('Q41_ONE_TAP_QUOTE_EXPIRED_NO_EMISSION');
  }
  scheduleRecovery(p,id){
    const key=p.user+':'+id;if(this.recoveryTimers.has(key)||p.expires_at<=Date.now())return;
    const timer=setTimeout(()=>{this.recoveryTimers.delete(key);this.recoverFirstAnimation(p,id).catch(()=>{});},15000);
    timer.unref?.();this.recoveryTimers.set(key,timer);
  }
  async recoverFirstAnimation(p,id){
    const key=p.user+':'+id;if(this.inflight.has(key))return;
    const work=(async()=>{
      const ctx=await this.context(p),op=ctx.state.mini_app?.operations?.[id];
      if(op?.kind!=='first_animation'||op.phase!=='GENERATING'||op.status!=='RUNNING')return;
      assertQ41Consent(op,this.env,ctx.checkpoint);
      const claimed=await mutateMiniState(this.store,p.user,m=>{const o=m.operations[id];if(o.recovery_lease_until>Date.now())return false;
        o.recovery_lease_until=Date.now()+120000;o.session_id=p.session;return true;});if(!claimed)return;
      try{
        const result=await this.adapter.recoverQuotedStage({command:authenticateMiniAppCommand({principal:p,operationId:id})});
        if(result.status==='WAITING_EXISTING_RESULT')this.scheduleRecovery(p,id);
        else await this.oneTapPhase(p,id,'REVIEW_READY',{status:'COMPLETE',finished_at:iso(),result_status:result.status});
      }catch(e){
        // Recovery never calls submit. Keep the original job available after a
        // transient poll/download error; no new quote or generation is admitted.
        await mutateMiniState(this.store,p.user,m=>{m.operations[id].recovery_error='EXISTING_JOB_RECOVERY_PENDING';});
        this.scheduleRecovery(p,id);
      }finally{await mutateMiniState(this.store,p.user,m=>{m.operations[id].recovery_lease_until=0;});}
    })();this.inflight.set(key,work);try{await work;}finally{this.inflight.delete(key);}
  }
  async media(p,id,expires,ticket){
    const n=Number(expires),expected=this.mediaTicket(p,id,n);
    if(!Number.isSafeInteger(n)||n<=Date.now()||n>p.expires_at||!/^\d+$/.test(String(expires))||!/^\w{64}$/.test(ticket||'')
      ||!timingSafeEqual(Buffer.from(expected),Buffer.from(ticket)))fail('MINI_MEDIA_EXPIRED',403);
    const item=this.catalog(await this.context(p)).get(id);if(!item)fail('MINI_MEDIA_NOT_FOUND',404);
    let cached=this.mediaCache.get(id);
    if(!cached||cached.expires<Date.now()){
      const bytes=await this.loadBytes(item.a);
      if(bytes.length!==item.a.size||hash(bytes)!==item.a.sha256)fail('MINI_ARTIFACT_INTEGRITY',409);
      cached={bytes,expires:Date.now()+300000};
      // Bounded original-byte cache; no public derivative or public storage object.
      if([...this.mediaCache.values()].reduce((n,x)=>n+x.bytes.length,0)+bytes.length>64000000)this.mediaCache.clear();
      if(bytes.length<=40000000)this.mediaCache.set(id,cached);
    }
    return {...item,bytes:cached.bytes};
  }
}

export function mountMiniApp(app,{db,store,adapter,production,loadBytes,validateOwner,env=process.env,fetchImpl=fetch,configureEntry=true}){
  if(!miniAppEnabled(env)||!db||!adapter)return null;
  const auth=new MiniAppAuth({store,validateOwner,env}),service=new MiniAppService({store,adapter,production,loadBytes,env});
  const api=MINI_PATH+'/api';
  const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||409).json({error:/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:'MINI_ACTION_UNAVAILABLE'});}};
  const principal=req=>auth.authenticate(sessionCookie(req),req.method==='POST'?String(req.headers['x-lumi-csrf']||''):null);
  app.use(MINI_PATH,(req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org"});
    if(req.method==='POST'&&(req.headers.origin!==MINI_ORIGIN||!String(req.headers['content-type']||'').startsWith('application/json')))return res.status(403).json({error:'MINI_ORIGIN_REQUIRED'});
    next();
  });
  for(const [suffix,file,type] of [['','index.html','text/html'],['/','index.html','text/html'],['/app.js','app.js','text/javascript'],['/style.css','style.css','text/css']])
    app.get(MINI_PATH+suffix,wrap(async(_req,res)=>res.type(type).send(await readFile(new URL('../../public/lumi-studio/'+file,import.meta.url)))));
  app.get(api+'/readiness',(_req,res)=>res.json({version:1,staging_sha:env.RENDER_GIT_COMMIT??null,auth_configured:miniAuthConfigured(env),auth_method:env.LUMI_TELEGRAM_BOT_TOKEN?'TELEGRAM_HMAC':'TELEGRAM_ED25519',menu_verified_at:envMenuVerified(env)?env.LUMI_MINI_APP_MENU_VERIFIED_AT:null,url:MINI_ORIGIN+MINI_PATH}));
  app.post(api+'/auth',wrap(async(req,res)=>{
    if(Object.keys(req.body||{}).some(k=>k!=='initData'))fail('MINI_BODY_INVALID',400);
    const s=await auth.login(req.body?.initData);
    res.set('Set-Cookie',`${MINI_COOKIE}=${s.cookie}; Path=${MINI_PATH}; Max-Age=1800; Secure; HttpOnly; SameSite=None; Partitioned`);
    res.json({csrf:s.csrf,expires_at:s.expires_at});
  }));
  app.get(api+'/session',wrap(async(req,res)=>{const p=await principal(req);res.json({csrf:auth.csrf(sessionCookie(req)),expires_at:p.expires_at});}));
  app.get(api+'/state',wrap(async(req,res)=>res.json(await service.view(await principal(req)))));
  app.post(api+'/actions/:kind',wrap(async(req,res)=>{
    const p=await principal(req),r=await service.enqueue(p,req.params.kind,req.body||{});
    res.status(202).json({operation:r.operation});
    setImmediate(()=>r.dispatch().catch(()=>console.error(JSON.stringify({event:'lumi_mini_operation_persistence_failed'}))));
  }));
  app.get(api+'/media/:id',wrap(async(req,res)=>{
    const p=await principal(req),{a,bytes}=await service.media(p,req.params.id,req.query.expires,req.query.ticket);
    res.type(a.mime).set('Accept-Ranges','bytes');
    if(req.query.download==='1')res.set('Content-Disposition',`attachment; filename="Lumi-${a.sha256.slice(0,12)}.${a.mime==='video/mp4'?'mp4':a.mime==='image/png'?'png':a.mime==='audio/mpeg'?'mp3':'jpg'}"`);
    if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m)return res.status(416).end();
      const start=Number(m[1]),end=m[2]?Number(m[2]):bytes.length-1;if(start>end||end>=bytes.length)return res.status(416).set('Content-Range','bytes */'+bytes.length).end();
      return res.status(206).set('Content-Range',`bytes ${start}-${end}/${bytes.length}`).send(bytes.subarray(start,end+1));}
    res.send(bytes);
  }));
  const configure=async()=>{
    if(!env.LUMI_TELEGRAM_BOT_TOKEN)return;
    const {data,error}=await db.from('cf_bot_admins').select('user_id,chat_id').eq('active',true);if(error)throw Error('MINI_ENTRY_OWNER_UNAVAILABLE');
    const call=async(method,body)=>{const r=await fetchImpl(`https://api.telegram.org/bot${env.LUMI_TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      const v=await r.json();if(!r.ok||!v.ok)throw Error('MINI_ENTRY_TELEGRAM_REJECTED');return v.result;};
    for(const owner of data||[]){
      const user=String(owner.user_id),chat=String(owner.chat_id),row=await store.get(user);
      if(user!==chat||row?.state.chat_id!==chat)continue;
      const wanted={type:'web_app',text:'Abrir Lumi Studio',web_app:{url:MINI_ORIGIN+MINI_PATH}};
      let menu=await call('getChatMenuButton',{chat_id:chat});
      if(menu?.type!==wanted.type||menu?.text!==wanted.text||menu?.web_app?.url!==wanted.web_app.url){await call('setChatMenuButton',{chat_id:chat,menu_button:wanted});menu=await call('getChatMenuButton',{chat_id:chat});}
      if(menu?.web_app?.url!==wanted.web_app.url)throw Error('MINI_ENTRY_VERIFY_FAILED');
      await mutateMiniState(store,user,m=>{m.entrypoint={status:'CONFIGURED',checked_at:iso(),url:wanted.web_app.url};});
      console.log(JSON.stringify({event:'lumi_mini_entrypoint_configured',provider_generation_calls:0}));
    }
  };
  if(configureEntry)configure().catch(()=>console.error(JSON.stringify({event:'lumi_mini_entrypoint_configuration_required'})));
  return {auth,service,configure};
}
