import {readFileSync} from 'node:fs';
import {sha256,artifactReview} from './telegram-review-v1/core.js';
const deepFreeze=x=>{for(const v of Object.values(x||{}))if(v&&typeof v==='object')deepFreeze(v);return Object.freeze(x);};
export const LUMI_PRODUCTION_PROFILE_V2=deepFreeze(JSON.parse(readFileSync(new URL('../qa/LUMI_PRODUCTION_PROFILE_V2.json',import.meta.url))));
export const LUMI_VOICE_PROFILE_V2=deepFreeze(JSON.parse(readFileSync(new URL('../qa/LUMI_VOICE_PROFILE_V2.json',import.meta.url))));
export const LUMI_VOICE_PROFILE_V3=deepFreeze(JSON.parse(readFileSync(new URL('../qa/LUMI_VOICE_PROFILE_V3.json',import.meta.url))));
export function resolveLumiVoiceProfile(version='LUMI_VOICE_PROFILE_V3'){
 const p=version===LUMI_VOICE_PROFILE_V2.version?LUMI_VOICE_PROFILE_V2:version===LUMI_VOICE_PROFILE_V3.version?LUMI_VOICE_PROFILE_V3:null;
 if(!p?.HUMAN_APPROVED)throw Error('FROZEN_APPROVED_VOICE_REQUIRED');
 if(p.version==='LUMI_VOICE_PROFILE_V3'&&(!p.frozen||p.human_status!=='APPROVED'||!p.voice_id||p.source_voice_id!=='NyQ87MpRGbszyh7rZLXM'||p.model_id!=='eleven_multilingual_v2'))throw Error('FROZEN_APPROVED_VOICE_REQUIRED');
 return p;
}
export function buildFutureVoiceRequest(text){const p=resolveLumiVoiceProfile();if(typeof text!=='string'||!text.trim())throw Error('SPANISH_CONTENT_REQUIRED');return {provider:p.provider,transport:p.transport,model_id:p.model_id,voice_id:p.voice_id,voice_profile_id:p.version,text};}
export const PROFILE_SHA=sha256(JSON.stringify(LUMI_PRODUCTION_PROFILE_V2));
// Prepared router: no default environment mutation and no existing episode rerouting.
export function selectLumiCreationProfile({requested='legacy',activation=null,readiness=null,existingEpisode=false}={}){
 if(requested==='legacy')return {profile:'legacy',migration_required:false};
 if(requested!==LUMI_PRODUCTION_PROFILE_V2.id)throw Error('UNKNOWN_PRODUCTION_PROFILE');
 if(existingEpisode)throw Error('EXISTING_EPISODE_ROUTING_IMMUTABLE');
 if(activation?.explicit_user_authorization!==true||readiness?.status!=='PASS'||activation.profile_sha!==PROFILE_SHA)throw Error('CONTROLLED_ACTIVATION_REQUIRED');
 return {profile:LUMI_PRODUCTION_PROFILE_V2.id,profile_sha:PROFILE_SHA,pipeline:'v1_1_2',migration_required:false};
}
export function rollbackToLegacy(){return selectLumiCreationProfile({requested:'legacy'});}
export function buildApprovedVoiceRequest(text){
 if(typeof text!=='string'||!text.trim())throw Error('SPANISH_CONTENT_REQUIRED');
 return {model:'text2speech_v2',variant:'elevenlabs',voice_id:LUMI_VOICE_PROFILE_V2.voice_id,voice_type:'preset',text};
}
export function publicationApprovalGate({episode,preview,confirmation,enabled=false}){
 const r=artifactReview(episode,episode.master);
 if(r?.status!=='APPROVED'||r.human_status!=='MASTER_HUMAN_APPROVED')throw Error('MASTER_HUMAN_APPROVAL_REQUIRED');
 if(preview?.master_sha!==episode.master.sha256||preview?.review_version!==r.review_version)throw Error('PUBLICATION_PREVIEW_STALE');
 if(!enabled||confirmation?.explicit!==true||confirmation.preview_sha!==sha256(JSON.stringify(preview)))throw Error('EXPLICIT_PUBLICATION_CONFIRMATION_REQUIRED');
 if(!preview.platforms?.length||preview.platforms.some(p=>!preview.connections?.[p]))throw Error('PUBLICATION_CONNECTION_REQUIRED');
 return {status:'AUTHORIZED_FOR_EXISTING_PUBLISHER',provider_calls:0};
}
