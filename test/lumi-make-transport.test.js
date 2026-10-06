import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryReviewStore,ReviewService,newSession,sha256,buildScreen} from '../lib/telegram-review-v1/core.js';
import {MakeTransport,signRequest,verifyRequest,claimRequest,acknowledgeCommand,scopedEnabled} from '../lib/telegram-review-v1/make-transport.js';
const secret='fixture-secret-'.repeat(5),now=1791288000000;
const request={timestamp:String(now/1000),requestId:'fixture-1',path:'/lumi/telegram-review/make/v1',body:Buffer.from('{"op":"show"}')};
test('HMAC accepts exact bytes and rejects missing, invalid, expired and substituted envelopes',()=>{
 const sig=signRequest(secret,request);assert.equal(verifyRequest(secret,request,sig,now),true);
 for(const change of [{body:Buffer.from('{}')},{requestId:'fixture-2'},{path:'/lumi/telegram-review/callback'}])assert.throws(()=>verifyRequest(secret,{...request,...change},sig,now));
 for(const invalid of [undefined,'x','0'.repeat(64)])assert.throws(()=>verifyRequest(secret,request,invalid,now));
 assert.throws(()=>verifyRequest(secret,request,sig,now+121000),/expired/);
 assert.throws(()=>verifyRequest(secret,request,sig,now-121000),/expired/);
});
const bytes=Buffer.from('immutable-test-master');
const master={artifact_id:'master',sha256:sha256(bytes),size:bytes.length,mime:'video/mp4',bucket:'private',path:'master.mp4',width:1080,height:1920,duration:41.125};
async function setup(){
 const store=new MemoryReviewStore();await store.create('1',newSession({user_id:'1',chat_id:'1',message_id:138,cover:master}));
 let loads=0;const svc=new ReviewService({store,telegram:new MakeTransport(),loadBytes:async()=>{loads++;return bytes;}});
 await svc.registerEpisode('1','1',{episode_id:'ep',title:'Lumi',review_mode:'SUPERVISED',shots:[],master,beats:9});
 const message=c=>({message_id:138,chat:{id:1},caption:c.body.media.caption,video:{file_id:'telegram-file',file_unique_id:'telegram-unique',file_size:bytes.length,width:1080,height:1920}});
 const ack=async c=>acknowledgeCommand(store,'1','1',c.idempotency_key,message(c));
 return {store,svc,ack,message,loads:()=>loads};
}
test('scope remains staging-only and default off; no bot token required',()=>{
 const env={LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_REVIEW_V1:'false'};
 assert.equal(scopedEnabled(env,'1','1'),true);assert.equal(scopedEnabled(env,'2','2'),false);assert.equal(scopedEnabled({...env,LUMI_RUNTIME_ENV:'production'},'1','1'),false);assert.equal(scopedEnabled({},'1','1'),false);
});
test('replay is rejected across instances and simultaneous claims cannot both execute',async()=>{
 const f=await setup();await claimRequest(f.store,'1',request,now);await assert.rejects(claimRequest(f.store,'1',request,now),/replayed/);
 const next={...request,requestId:'race'};const r=await Promise.allSettled([claimRequest(f.store,'1',next,now),claimRequest(f.store,'1',next,now)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
});
test('Make command waits for authentic acknowledgement and reuses file_id on same panel',async()=>{
 const f=await setup();const first=await f.svc.show('1','1',{kind:'master',episode_id:'ep'}),c=first.commands[0];
 assert.equal(c.message_id,138);assert.equal(c.upload_required,true);assert.equal(c.artifact_sha,master.sha256);
 assert.equal((await f.store.get('1')).state.media_capable,false);
 await assert.rejects(f.svc.show('1','1',{kind:'menu'}),/reconciliation/);
 await assert.rejects(acknowledgeCommand(f.store,'1','1',c.idempotency_key,{...f.message(c),message_id:139}),/identity/);
 await assert.rejects(acknowledgeCommand(f.store,'1','1',c.idempotency_key,{...f.message(c),video:{...f.message(c).video,file_size:1}}),/metadata/);
 await f.ack(c);assert.equal((await f.ack(c)).already_applied,true);
 for(const kind of ['download','menu','master']){const next=(await f.svc.show('1','1',{kind,episode_id:'ep'})).commands[0];assert.equal(next.message_id,138);assert.equal(next.upload_required,false);assert.equal(next.body.media.media,'telegram-file');await f.ack(next);}
 assert.equal(f.loads(),1);assert.equal((await f.store.get('1')).state.LUMI_CANONICAL_PANEL_V1.message_id,138);
});
test('master approval remains SHA bound and duplicate approve does not mutate twice',async()=>{
 const f=await setup();let c=(await f.svc.show('1','1',{kind:'master',episode_id:'ep'})).commands[0];await f.ack(c);
 const button=c.body.reply_markup.inline_keyboard.flat().find(x=>/aprobar/i.test(x.text));
 const cb={id:'callback-1',from:{id:1},message:f.message(c),data:button.callback_data};
 for(let i=0;i<2;i++){const result=await f.svc.callback({...cb,id:`callback-${i}`});await f.ack(result.commands[0]);}
 const state=(await f.store.get('1')).state;assert.equal(state.reviews.length,1);assert.equal(state.reviews[0].human_status,'MASTER_HUMAN_APPROVED');assert.equal(state.reviews[0].artifact_sha,master.sha256);
});
test('all progress stages render from fixtures without starting an episode',async()=>{
 const f=await setup();const s=(await f.store.get('1')).state;
 for(const stage of ['PLAN','SOURCES','VIDEO','AUDIO','ASSEMBLY','MASTER','READY','PAUSED']){
  const fixture=structuredClone(s);fixture.episodes.ep.current_stage=stage;
  const before=JSON.stringify(fixture);const view=buildScreen(fixture,{kind:'progress',episode_id:'ep'});
  assert.ok(view.caption.includes(stage));assert.equal(JSON.stringify(fixture),before);
 }
});
test('historical q31 review simulation renders isolated state and preserves human evidence',async()=>{
 const f=await setup();const s=(await f.store.get('1')).state;
 const historical={...master,artifact_id:'q31-PRO2',sha256:'ea5a54493bf1ccf037ac5acac2d81668c0d9f7c0239d81479dfa7968c7ee0307',bucket:'av2-generative-video-benchmarks',path:'lumi-series-v2/ep_lumi_flores_003/q31-PRO2/video/ea5a54493bf1ccf037ac5acac2d81668c0d9f7c0239d81479dfa7968c7ee0307/original.mp4'};
 s.episodes.ep.shots=[{shot_id:'q31',artifact:historical,technical_qa:'PASS',creative_qa:'HUMAN_APPROVED'}];
 const before=JSON.stringify(s);const view=buildScreen(s,{kind:'shot',episode_id:'ep',index:0});
 assert.equal(view.artifact.sha256,historical.sha256);assert.ok(view.reply_markup.inline_keyboard.flat().some(b=>b.text.includes('Aprobar')));assert.equal(JSON.stringify(s),before);
});
