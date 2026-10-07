import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryReviewStore,newSession,ReviewService,sha256,renderTelegramPanel} from '../lib/telegram-review-v1/core.js';
import {MakeTransport,acknowledgeCommand} from '../lib/telegram-review-v1/make-transport.js';
import {HOME_ASSET} from '../lib/telegram-review-v1/home-asset.js';
test('existing Spanish A/B previews remain audio in panel 138; HOME retains comparison and choice only records human decision',async()=>{
 const s=newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET});s.deliveries[HOME_ASSET.sha256]={telegram_file_id:'home'};
 s.episodes.ep={episode_id:'ep',review_mode:'SUPERVISED',shots:[],artifacts:{},review_requests:{},master:{sha256:'c'.repeat(64)}};
 const e=s.episodes.ep;const candidates=['A','B'].map(letter=>{
  const a={artifact_id:letter,sha256:(letter==='A'?'a':'b').repeat(64),size:100,mime:'audio/mpeg',bucket:'existing',path:letter+'.mp3',duration:3};e.artifacts[letter]=a;s.deliveries[a.sha256]={telegram_file_id:'file'+letter};
  e.review_requests[letter]={review_request_id:letter,artifact_id:letter,artifact_sha:a.sha256,stage_id:'TTS',review_version:1,transport_only:true,status:'TRANSPORT_ONLY',preview_voice:{letter,voice_id:letter,name:letter==='A'?'Lucia — Warm Conversational':'Fernanda — Warm & Natural'}};
  return {letter,VOICE_ID:letter,review_request_id:letter,artifact:a};
 });s.voice_preview_review={episode_id:'ep',candidates,profile_status:'VOICE_SELECTION_PENDING'};
 for(const letter of ['A','B']){const p=renderTelegramPanel(s,{kind:'audio',episode_id:'ep',request_id:letter});assert.equal(p.state_id,'AUDIO_REVIEW');assert.equal(p.media_type,'audio');assert.match(p.caption,/Español verificado/);assert.deepEqual(Object.values(p.tokens).map(t=>t.action),['audio','audio','choose_preview','menu']);}
 const home=renderTelegramPanel(s,{kind:'menu'});assert.equal(home.media_type,'photo');assert.ok(Object.values(home.tokens).find(t=>t.action==='audio'&&t.request_id==='A'));
 const p=renderTelegramPanel(s,{kind:'audio',episode_id:'ep',request_id:'B'});s.tokens=p.tokens;const token=Object.entries(p.tokens).find(([,t])=>t.action==='choose_preview')[0];
 const store=new MemoryReviewStore();await store.create('1',s);let productionCalls=0;
 const svc=new ReviewService({store,telegram:new MakeTransport(),loadBytes:async()=>{throw Error('cached');},production:{reviewed:()=>{productionCalls++;}}});
 await svc.callback({id:'actual-human-fixture',from:{id:1},message:{message_id:138,chat:{id:1}},data:'lr:'+token});
 const final=(await store.get('1')).state;assert.equal(final.voice_preview_review.human_selection.letter,'B');assert.equal(final.voice_preview_review.profile_status,'VOICE_SELECTION_PENDING');assert.equal(productionCalls,0);assert.equal(final.reviews.length,0);assert.equal(final.episodes.ep.master.sha256,'c'.repeat(64));
});
test('AUDIO → HOME → AUDIO uses panel 138, SHA file cache and exact ACK metadata',async()=>{
 const bytes=Buffer.from('EXPLICIT_TRANSPORT_FIXTURE'),a={artifact_id:'narration',sha256:sha256(bytes),size:bytes.length,mime:'audio/mpeg',bucket:'fixtures',path:'narration.mp3',duration:2,sample_rate:44100,channels:1};
 const s=newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET});s.deliveries[HOME_ASSET.sha256]={telegram_file_id:'home',telegram_file_unique_id:'home-unique'};
 s.episodes.ep={episode_id:'ep',title:'Escucha',review_mode:'SUPERVISED',shots:[],artifacts:{narration:a},review_requests:{r:{review_request_id:'r',episode_id:'ep',stage_id:'TTS',artifact_id:'narration',artifact_sha:a.sha256,review_version:3,status:'PENDING',allowed_actions:['APPROVE','REJECT']}}};
 const store=new MemoryReviewStore();await store.create('1',s);let uploads=0;
 let urls=0;const svc=new ReviewService({store,telegram:new MakeTransport(),loadBytes:async()=>{uploads++;return bytes;},
   mediaTransportUrl:async artifact=>{urls++;return {sha256:artifact.sha256,url:'https://fixture.invalid/temporary-audio-transport'};}});
 for(const kind of ['audio','menu','audio','audio_details','menu']){
   const screen=kind==='menu'?{kind}:{kind,episode_id:'ep',request_id:'r'},r=await svc.show('1','1',screen),c=r.commands[0];
   assert.equal(c.method,'editMessageMedia');assert.equal(c.message_id,138);
   assert.equal(c.upload_required,false);
   const audio=kind!=='menu';assert.equal(c.body.media.type,audio?'audio':'photo');
   const m={message_id:138,chat:{id:'1'},caption:c.body.media.caption,reply_markup:c.body.reply_markup,
     ...(audio?{audio:{file_id:'audio-file',file_unique_id:'audio-unique',file_size:bytes.length}}:{photo:[{file_id:'home',file_unique_id:'home-unique'}]})};
   if(audio)await assert.rejects(acknowledgeCommand(store,'1','1',c.idempotency_key,{...m,audio:{...m.audio,file_size:1}}),/metadata/);
   await acknowledgeCommand(store,'1','1',c.idempotency_key,m);
 }
 assert.equal(uploads,1);assert.equal(urls,1);const final=(await store.get('1')).state;assert.equal(final.TELEGRAM_AUDIO_FILE_ID,'audio-file');assert.equal(final.AUDIO_SHA,a.sha256);
 assert.equal(final.TELEGRAM_HOME_FILE_ID,'home');assert.equal(final.panel_content_type,'photo');assert.equal(final.reviews.length,0);
 const panel=renderTelegramPanel(final,{kind:'audio',episode_id:'ep',request_id:'r'});assert.equal(panel.state_id,'AUDIO_REVIEW');
 const approve=Object.values(panel.tokens).find(t=>t.action==='approve_stage');assert.equal(approve.artifact_sha,a.sha256);assert.equal(approve.generic_review_version,3);
 final.episodes.ep.artifacts.narration.sha256='a'.repeat(64);assert.throws(()=>renderTelegramPanel(final,{kind:'audio',episode_id:'ep',request_id:'r'}),/stale/);
});
test('historical transport-only audio cannot create approval and returns to HOME',()=>{
 const a={artifact_id:'stem',sha256:'a'.repeat(64),mime:'audio/mpeg',size:100,bucket:'existing',path:'stem.mp3',duration:3,sample_rate:44100,channels:1};
 const s=newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET});
 s.episodes.ep={episode_id:'ep',title:'Existing',review_mode:'SUPERVISED',shots:[],artifacts:{stem:a},review_requests:{r:{review_request_id:'r',artifact_id:'stem',artifact_sha:a.sha256,review_version:1,stage_id:'TTS',status:'TRANSPORT_ONLY',transport_only:true,allowed_actions:[]}}};
 const p=renderTelegramPanel(s,{kind:'audio',episode_id:'ep',request_id:'r'}),actions=Object.values(p.tokens).map(t=>t.action);
 assert.deepEqual(actions,['audio','audio_details','menu']);assert.ok(p.caption.includes('Revisión de audio'));assert.equal(p.state_id,'AUDIO_REVIEW');
 assert.equal(renderTelegramPanel(s,{kind:'menu'}).media_type,'photo');assert.equal(s.reviews.length,0);
});
