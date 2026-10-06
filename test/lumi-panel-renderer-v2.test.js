import test from 'node:test';
import assert from 'node:assert/strict';
import {newSession,MemoryReviewStore,ReviewService,sha256,renderTelegramPanel,artifactReview} from '../lib/telegram-review-v1/core.js';
import {MakeTransport,acknowledgeCommand} from '../lib/telegram-review-v1/make-transport.js';
const bytes=Buffer.from('SYNTHETIC_FIXTURE_VIDEO'),master={artifact_id:'fixture',sha256:sha256(bytes),mime:'video/mp4',size:bytes.length,bucket:'fixture',path:'master.mp4',width:1080,height:1920,duration:4};
async function setup({supported=true}={}){
 const store=new MemoryReviewStore(),session=newSession({user_id:'1',chat_id:'1',message_id:138,cover:master,legacy_menu:[[{text:'Ideas',callback_data:'ideas'}]]});
 session.home_restore_capability={media_to_text:supported,scope:'SYNTHETIC_ONLY_NOT_LIVE_CERTIFICATION'};session.panel_content_type='text';
 await store.create('1',session);let uploads=0;
 const svc=new ReviewService({store,telegram:new MakeTransport(),loadBytes:async()=>{uploads++;return bytes;}});
 await svc.registerEpisode('1','1',{episode_id:'ep',title:'Fixture',review_mode:'SUPERVISED',beats:9,master,shots:[{shot_id:'q',artifact:master,technical_qa:'PASS',creative_qa:'PASS'}]});
 const message=c=>c.method==='editMessageText'?{chat:{id:1},message_id:138,text:c.body.text,reply_markup:c.body.reply_markup}:{chat:{id:1},message_id:138,caption:c.body.media.caption,reply_markup:c.body.reply_markup,video:{file_id:'EXISTING_FILE',file_unique_id:'UNIQUE',file_size:bytes.length}};
 const ack=c=>acknowledgeCommand(store,'1','1',c.idempotency_key,message(c));
 const show=async screen=>{const r=await svc.show('1','1',screen),c=r.commands[0];await ack(c);return c;};
 const cb=async(c,action)=>{const s=(await store.get('1')).state,[token]=Object.entries(s.tokens).reverse().find(([,v])=>v.action===action);const r=await svc.callback({id:'real-fixture-'+action,from:{id:1},message:message(c),data:'lr:'+token});if(r.commands)await ack(r.commands[0]);return r;};
 return {store,svc,ack,show,cb,message,uploads:()=>uploads};
}
test('HOME/master/HOME/shot/HOME/approved/HOME/master keep 138, exact types, keyboard and file_id',async()=>{
 const f=await setup();let c=await f.show({kind:'menu'});assert.equal(c.method,'editMessageText');
 c=await f.show({kind:'master',episode_id:'ep'});assert.equal(c.method,'editMessageMedia');
 await f.show({kind:'menu'});c=await f.show({kind:'shot',episode_id:'ep'});await f.show({kind:'menu'});
 c=await f.show({kind:'master',episode_id:'ep'});await f.cb(c,'approve_final');
 c=await f.show({kind:'master_approved',episode_id:'ep'});assert.match(c.body.media.caption,/APROBADO/);
 await f.show({kind:'menu'});c=await f.show({kind:'master',episode_id:'ep'});
 assert.equal(c.body.media.media,'EXISTING_FILE');assert.equal(c.upload_required,false);assert.equal(f.uploads(),1);
 const s=(await f.store.get('1')).state;assert.equal(s.message_id,138);assert.equal(s.deliveries[master.sha256].telegram_file_id,'EXISTING_FILE');assert.equal(s.reviews.length,1);
 assert.equal(s.reviews[0].callback_provenance.message_id,138);assert.equal(s.episodes.ep.MASTER_HUMAN_APPROVED,true);
});
test('BACK restores prior content, type, caption, keyboard and binding',async()=>{
 const f=await setup();await f.show({kind:'menu'});const masterCommand=await f.show({kind:'master',episode_id:'ep'});
 const details=(await f.cb(masterCommand,'details')).commands[0];assert.equal(details.method,'editMessageText');
 const back=(await f.cb(details,'back')).commands[0];assert.equal(back.method,'editMessageMedia');assert.equal(back.body.media.media,'EXISTING_FILE');assert.equal(back.body.media.caption,masterCommand.body.media.caption);
 assert.deepEqual(back.body.reply_markup.inline_keyboard.map(r=>r.map(b=>b.text)),masterCommand.body.reply_markup.inline_keyboard.map(r=>r.map(b=>b.text)));
});
test('validated Telegram media->text rejection blocks before claim or edit; no silent replacement',async()=>{
 const f=await setup({supported:false});const c=await f.show({kind:'master',episode_id:'ep'}),before=await f.store.get('1');
 await assert.rejects(f.svc.show('1','1',{kind:'menu'}),/TELEGRAM_MEDIA_TO_TEXT_UNSUPPORTED/);
 assert.deepEqual(await f.store.get('1'),before);const r=await f.cb(c,'menu');assert.equal(r.blocked,true);
 assert.deepEqual(await f.store.get('1'),before);assert.equal(f.uploads(),1);
});
test('text acknowledgement rejects residual video and incorrect keyboard',async()=>{
 const f=await setup(),c=(await f.svc.show('1','1',{kind:'menu'})).commands[0];
 await assert.rejects(f.ack({...c,idempotency_key:'wrong'}),/identity/);
 await assert.rejects(acknowledgeCommand(f.store,'1','1',c.idempotency_key,{...f.message(c),video:{file_id:'old'}}),/representation/);
 await assert.rejects(acknowledgeCommand(f.store,'1','1',c.idempotency_key,{...f.message(c),reply_markup:{inline_keyboard:[]}}),/keyboard/);await f.ack(c);
});
test('publication states render complete previews, are SHA-bound and cannot publish',async()=>{
 const f=await setup();let c=await f.show({kind:'master',episode_id:'ep'});await f.cb(c,'approve_final');let row=await f.store.get('1');
 row.state.episodes.ep.publication_preview_available=true;row.state.episodes.ep.publication_inventory=[{platform:'youtube',implementation_status:'IMPLEMENTED',account_connection_status:'DISCONNECTED'}];await f.store.cas('1',row.revision,row.state);
 for(const kind of ['publish','publish_select','publish_preview','publish_confirm','publishing','published','publish_error']){c=await f.show({kind,episode_id:'ep',platforms:['youtube']});assert.equal(c.method,'editMessageText');assert.equal(c.message_id,138);}
 c=await f.show({kind:'publish_confirm',episode_id:'ep',platforms:['youtube']});const before=await f.store.get('1');assert.equal((await f.cb(c,'publish_commit')).error,'PUBLICATION_DISABLED');assert.deepEqual(await f.store.get('1'),before);
});
test('SHOT_REVIEW and INCIDENT BACK restore complete previous HOME or progress',async()=>{
 const f=await setup();await f.show({kind:'menu'});let c=await f.show({kind:'shot',episode_id:'ep'});let back=(await f.cb(c,'back')).commands[0];assert.equal(back.method,'editMessageText');assert.match(back.body.text,/Content Factory/);
 const progress=await f.show({kind:'progress',episode_id:'ep'});c=await f.show({kind:'incident',episode_id:'ep'});back=(await f.cb(c,'back')).commands[0];assert.equal(back.body.text,progress.body.text);assert.deepEqual(back.body.reply_markup.inline_keyboard.map(r=>r.map(b=>b.text)),progress.body.reply_markup.inline_keyboard.map(r=>r.map(b=>b.text)));
});
test('every text navigation from known media limitation blocks before pending callback or edit',async()=>{
 const f=await setup({supported:false});await f.show({kind:'menu'});const menu=(await f.store.get('1')).state;const currentToken=Object.entries(menu.tokens).find(([,v])=>v.action==='current')[0];const c=await f.show({kind:'master',episode_id:'ep'}),before=await f.store.get('1');
 const r=await f.svc.callback({id:'fixture-current',from:{id:1},message:f.message(c),data:'lr:'+currentToken});assert.equal(r.error,'TELEGRAM_MEDIA_TO_TEXT_UNSUPPORTED');assert.deepEqual(await f.store.get('1'),before);
});
