import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryReviewStore,newSession,ReviewService,sha256,renderTelegramPanel} from '../lib/telegram-review-v1/core.js';
import {MakeTransport,acknowledgeCommand} from '../lib/telegram-review-v1/make-transport.js';
import {HOME_ASSET} from '../lib/telegram-review-v1/home-asset.js';
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
