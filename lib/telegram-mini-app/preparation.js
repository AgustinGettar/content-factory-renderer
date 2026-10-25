import {randomUUID} from 'node:crypto';
import {assertMiniPrincipal,mutateMiniState} from './auth.js';
import {ep004ProductionRequest,prepareGenericV2Episode} from '../lumi-generic-v2-adapter.js';
import {EDITORIAL_POLICY,estimateNarration} from '../lumi-editorial-timeline-v2.js';
import {inputDigest} from '../lumi-v2-activation-context.js';
import {LUMI_PRODUCTION_PROFILE_V2 as profile,PROFILE_SHA} from '../lumi-production-profile-v2.js';

const text=(s,max)=>{if(typeof s!=='string'||!s.trim()||s.length>max)throw Error('PREPARATION_TEXT_REQUIRED');return s.trim();};
const clone=structuredClone;
export function compileStudioPreparation(input,episodeId){
  const title=text(input.title,120),idea=text(input.idea,1000),objective=text(input.objective,240),setting=text(input.setting,160);
  if(!Array.isArray(input.objects)||input.objects.length<1||input.objects.length>4||!Array.isArray(input.scenes)||input.scenes.length<5||input.scenes.length>10)throw Error('PREPARATION_SCENE_COUNT_INVALID');
  const inventory=input.objects.map((o,i)=>({id:'object_'+(i+1),count:1,color:text(o.color,80),shape:text(o.name,100)+'; '+text(o.shape,120),placement:text(o.placement,120),visibility:'FULLY_VISIBLE'}));
  const roles=input.scenes.map(s=>s.role);
  if(roles[0]!=='setup'||roles.at(-1)!=='close'||roles.filter(r=>r==='question').length!==1||roles.filter(r=>r==='answer').length!==1||roles.indexOf('answer')!==roles.indexOf('question')+1||roles.slice(1,roles.indexOf('question')).some(r=>r!=='discovery')||roles.indexOf('answer')!==roles.length-2)throw Error('PREPARATION_STORY_ORDER_REQUIRED');
  const base=ep004ProductionRequest({episode_id:'ep_lumi_granja_004_20261008_ee7ab4b3',sha256:'a'.repeat(64)}),plan=base.episodePlan;
  const sourceScenes=clone(plan.scenes),sourceShots=clone(base.shotPlans);
  Object.assign(plan.episode,{id:episodeId,title,story_premise:idea,category:'aprendizaje',learning:{objective_id:'obj_'+episodeId,objective,success_test:text(input.success_test,240)},
    world_ref:{id:'studio_world',version:'1.0'},voice_profile_ref:{id:'fernanda_elevenlabs',version:'3.0'},
    continuity_initial:{...plan.episode.continuity_initial,location:'studio_world',props_state:Object.fromEntries(inventory.map(o=>[o.id,'visible'])),secondary_characters:[],narrative_state:'start'},
    music_direction:{motif_ref:{id:'none',version:'1.0'},mood:'sin música nueva',rules:['Conservar voz y pausa sin efectos nuevos.']}});
  plan.entities=[...plan.entities.slice(0,2),...inventory.map(o=>({id:o.id,kind:'prop',asset_ref:{id:o.id+'_asset',version:'1.0'},tags:[]}))];
  plan.episode.story_beats=[];base.shotPlans=[];
  plan.scenes=input.scenes.map((s,i)=>{
    const role=s.role,index=({setup:0,discovery:1,question:4,answer:5,close:6})[role];
    if(index===undefined)throw Error('PREPARATION_ROLE_INVALID');
    const id='s'+String(i+1).padStart(2,'0'),shotId='take_'+(i+1),goal=text(s.goal,240),narration=text(s.narration,600),duration=Number(s.duration??5),pause=role==='question'?2.5:0;
    const entry=Number(s.entry_seconds??0),closure=Number(s.closure_seconds??0),estimate=estimateNarration(narration,{entry,closure,pause});
    if(!Number.isInteger(duration)||duration<3||duration>15||estimate.required_visual_seconds>duration)throw Object.assign(Error('PREPARATION_NARRATION_TIME_CONFLICT'),{shot_id:shotId,required_seconds:estimate.required_visual_seconds});
    const scene=clone(sourceScenes[index]),shot=clone(sourceShots[index]);
    const focus=Number.isInteger(s.object_index)&&inventory[s.object_index]&&['discovery','answer'].includes(role)?inventory[s.object_index].id:'viewer';
    const grammar=role==='close'?'FAREWELL':role==='question'?'ATTENTIVE_WAIT':focus==='viewer'?'GAZE_VIEWER':'GAZE_TARGET';
    plan.episode.story_beats.push({id:'beat_'+id,function:role,summary:goal});
    Object.assign(scene,{id,beat_ref:'beat_'+id,educational_goal:goal,duration_target_seconds:duration,effects:[],text:[],
      continuity:{preconditions:[{op:'equals',path:'narrative_state',value:i?'step_'+i:'start'}],operations:[{op:'set',path:'narrative_state',value:'step_'+(i+1)}]}});
    scene.stage.environment_ref={id:'studio_world',version:'1.0'};scene.stage.lighting_ref={id:'soft_day',version:'1.0'};
    scene.stage.placements=[...scene.stage.placements.slice(0,2),...inventory.map((o,j)=>({entity_id:o.id,layer:'midground',transform:{position_m:[j-(inventory.length-1)/2,0,2.5],rotation_deg:[0,0,0],scale:[1,1,1]},visible:true}))];
    scene.actions=[{...scene.actions[0],id:id+'_attention',duration_seconds:duration,gaze_target:focus==='viewer'?'camera':focus,action_id:role==='question'?'attentive_wait':focus==='viewer'?'gaze_viewer':'gaze_target'}];
    Object.assign(scene.camera,{subjects:['lumi',...inventory.map(o=>o.id)],duration_seconds:duration,framing:{safe_region:'learning_safe',intent:goal}});
    scene.audio={utterances:[{...scene.audio.utterances[0],id:id+'_voice',text:narration}],pauses:pause?[{...sourceScenes[4].audio.pauses[0],id:id+'_pause',after_utterance:id+'_voice',duration_seconds:pause}]:[],music_cues:[],sound_effects:[]};
    scene.assertions=[{id:id+'_lumi',type:'character_present',severity:'BLOCKER',entities:['lumi'],expected:true},{id:id+'_objects',type:'entity_visible',severity:'BLOCKER',entities:inventory.map(o=>o.id),expected:true}];
    Object.assign(shot,{shot_id:shotId,scene_ids:[id],duration,source_status:'NOT_CREATED',educational_goal:goal,focus,grammar,response_window_seconds:pause,editorial:{entry_seconds:entry,closure_seconds:closure,narration_estimate:estimate,setting}});
    Object.assign(shot.director_input,{episode_id:episodeId});
    Object.assign(shot.director_input.contract,{shot_id:shotId,DURATION:duration,SOURCE_ARTIFACT:{sha256:null,status:'NOT_CREATED'},REQUIRED_OBJECTS:clone(inventory)});
    Object.assign(shot.director_input.direction,{educational_goal:goal,focus,grammar,response_window_seconds:pause});
    base.shotPlans.push(shot);return scene;
  });
  const duration=base.shotPlans.reduce((n,s)=>n+s.duration,0);plan.episode.duration_target={min_seconds:duration,target_seconds:duration,max_seconds:duration};
  plan.episode.transitions=plan.scenes.slice(1).map((s,i)=>({id:'edge_'+i,from_scene:plan.scenes[i].id,to_scene:s.id,type:'cut',overlap_frames:0,motivated_by:'learning_progress'}));
  plan.scenes.forEach((s,i)=>{s.transition_in=i?'edge_'+(i-1):null;s.transition_out=i<plan.scenes.length-1?'edge_'+i:null;});
  base.editorialPolicy=EDITORIAL_POLICY;
  return prepareGenericV2Episode(base);
}

// Only preparation. No authority, reservations, provider calls or runner start.
export function bindStudioPreparation(adapter,{manager,reviewStore,validateOwner}){
  const owner=async p=>{assertMiniPrincipal(p);const row=await reviewStore.get(p.user);if(!await validateOwner(p.user,p.chat)||row?.state.chat_id!==p.chat)throw Error('MINI_OWNER_REQUIRED');return row;};
  adapter.studioPreparation=async(p,body=null)=>{
    await owner(p);
    if(!body)return (await reviewStore.get(p.user)).state.mini_app?.preparation??null;
    const id=body.draft_id??randomUUID();if(!/^[a-f0-9-]{36}$/.test(id))throw Error('PREPARATION_ID_INVALID');
    if(!body.input||JSON.stringify(body.input).length>30000||!Array.isArray(body.input.objects)||!Array.isArray(body.input.scenes)
      ||body.input.objects.length>4||body.input.scenes.length>10||[...body.input.objects,...body.input.scenes].some(x=>!x||typeof x!=='object'))throw Error('PREPARATION_INPUT_INVALID');
    const episodeId='ep_studio_'+inputDigest({user:p.user,draft:id}).slice(0,24);let prepared,validation;
    try{prepared=compileStudioPreparation(body.input,episodeId);validation={status:'READY',duration_seconds:prepared.shot_plans.reduce((n,s)=>n+s.duration,0)};}
    catch(e){validation={status:'NEEDS_EDIT',error:/^[A-Z_]+$/.test(e.message)?e.message:'PREPARATION_CONTRACT_INVALID',shot_id:e.shot_id??null,required_seconds:e.required_seconds??null};}
    const proposed=Number(body.proposed_limit_usd);if(!Number.isFinite(proposed)||proposed<=0||proposed>100)throw Error('PREPARATION_LIMIT_REQUIRED');
    return mutateMiniState(reviewStore,p.user,m=>{
      const old=m.preparation;
      if(old?.freezing&&!old.prepared&&old.draft_id!==id)throw Error('PREPARATION_FREEZE_PENDING');
      if(old?.draft_id===id&&inputDigest(old.input)===inputDigest(body.input)&&old.proposed_limit_usd===proposed)return clone(old);
      if(old?.draft_id===id&&(old.prepared||old.freezing))throw Error('PREPARATION_ALREADY_FROZEN');
      if(old&&body.expected_version!==old.version)throw Error('PREPARATION_VERSION_CONFLICT');
      const value={draft_id:id,episode_id:episodeId,version:(old?.version??0)+1,input:clone(body.input),proposed_limit_usd:proposed,
        plan_sha:prepared?.binding_sha??null,validation,prepared:false,updated_at:new Date().toISOString(),method:'EDITABLE_GUIDED_PLAN_NO_AI',provider_calls:0};
      m.preparation=value;return clone(value);
    });
  };
  adapter.freezeStudioPreparation=async(p,body)=>{
    const row=await owner(p),d=row.state.mini_app?.preparation;
    if(!d||d.draft_id!==body.draft_id||d.version!==body.version)throw Error('PREPARATION_VERSION_CONFLICT');
    const prepared=compileStudioPreparation(d.input,d.episode_id);
    await mutateMiniState(reviewStore,p.user,m=>{if(m.preparation?.draft_id!==d.draft_id||m.preparation.version!==d.version)throw Error('PREPARATION_VERSION_CONFLICT');m.preparation.freezing=true;});
    const cp=await manager.startEpisode({episodeId:d.episode_id,actions:prepared.actions,authorizedCeilingUsd:0,
      metadata:{user:p.user,runtime_revision:1,dry_run:false,generic_v2:prepared,provider_generation_authorized:false,publication_enabled:false,
        studio_preparation:{draft_id:d.draft_id,version:d.version,proposed_limit_usd:d.proposed_limit_usd,method:d.method},episode_ledger:{currency:'USD',entries:{},provider_units:[]}}});
    if(cp.metadata.user!==p.user||cp.metadata.generic_v2.binding_sha!==prepared.binding_sha)throw Error('PREPARATION_VERSION_CONFLICT');
    await mutateMiniState(reviewStore,p.user,(m,s)=>{
      if(m.preparation?.draft_id!==d.draft_id||m.preparation.version!==d.version)throw Error('PREPARATION_VERSION_CONFLICT');
      s.episodes[d.episode_id]??={episode_id:d.episode_id,title:prepared.plan.episode.title,pipeline:profile.id,profile_sha:PROFILE_SHA,binding_sha:prepared.binding_sha,
        shots:prepared.shot_plans.map(s=>({shot_id:s.shot_id})),artifacts:{},review_requests:{},reviews:{},review_mode:'UNSELECTED',budget_approved:false};
      m.preparation.prepared=true;m.active_episode_id=d.episode_id;
    });
    return {status:'PREPARED_REQUIRES_PLAN_APPROVAL',episode_id:d.episode_id,provider_calls:0,new_reservations:0};
  };
  adapter.acceptStudioCeiling=async(p,grant)=>{
    await owner(p);const v=grant.value,cp=await manager.store.getEpisode(v.episode_id),saved=(await reviewStore.get(p.user)).state.v2_authorizations?.[v.authorization_id];
    if(!saved||inputDigest(saved)!==inputDigest(grant)||cp.metadata.user!==p.user||!cp.metadata.studio_preparation||v.maximum_episode_exposure!==cp.metadata.studio_preparation.proposed_limit_usd)throw Error('PREPARATION_CONSENT_REQUIRED');
    if(Number(cp.authorized_ceiling_usd)===v.maximum_episode_exposure)return;
    if(Number(cp.authorized_ceiling_usd)!==0||cp.actions.some(a=>a.dispatch_state!=='NOT_DISPATCHED'))throw Error('PREPARATION_ALREADY_STARTED');
    await manager.checkpoint(cp.episode_id,s=>{
      s.authorized_ceiling_usd=v.maximum_episode_exposure;s.metadata.studio_preparation.authorization_id=v.authorization_id;
      // Preserve the reviewed upper bounds and their provenance for the same
      // whole-plan gate used by the worker. These are not fresh provider quotes.
      s.metadata.accepted_plan_cost_evidence={authorization_id:v.authorization_id,plan_binding_sha:s.metadata.generic_v2.binding_sha,
        unknown_allocations:clone(v.unknown_costs),assumptions:clone(v.estimate_assumptions),no_new_services:true};
      for(const key of v.action_set)s.metadata.episode_ledger.entries[key]={estimated_cost:{currency:'USD',usd:v.per_action_limits[key]},
        basis:'HUMAN_ACCEPTED_PLAN_MAXIMUM_NOT_PROVIDER_QUOTE',authorization_id:v.authorization_id};
    });
  };
}

export function proposedPlanCheckpoint(cp){return cp?.metadata?.studio_preparation&&Number(cp.authorized_ceiling_usd)===0?{...cp,authorized_ceiling_usd:cp.metadata.studio_preparation.proposed_limit_usd}:cp;}
