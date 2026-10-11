import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryReviewStore,newSession,ReviewService,sha256} from '../lib/telegram-review-v1/core.js';

async function fixture(){
 const bytes=Buffer.from('offline HOME photo'),cover={artifact_id:'home',sha256:sha256(bytes),size:bytes.length,
  mime:'image/png',bucket:'private',path:'home.png'};
 const store=new MemoryReviewStore(),calls=[];
 await store.create('1',newSession({user_id:'1',chat_id:'1',message_id:138,cover,
  legacy_menu:[[{text:'Ideas',callback_data:'ideas'}]]}));
 const telegram={async call(method,body){
  calls.push({method,body:structuredClone(body)});
  if(method==='answerCallbackQuery')return true;
  assert.equal(method,'editMessageMedia');assert.equal(body.message_id,138);assert.equal(body.media.type,'photo');
  return {message_id:138,chat:{id:1},photo:[{file_id:'home',file_unique_id:'home-unique'}]};
 }};
 const production={create:()=>assert.fail('episode creation forbidden'),resume:()=>assert.fail('provider access forbidden')};
 const svc=new ReviewService({store,telegram,loadBytes:async()=>bytes,production});
 const callback=async action=>{
  const s=(await store.get('1')).state,entry=Object.entries(s.tokens).reverse().find(([,v])=>v.action===action);
  assert.ok(entry,action);return {id:'offline-'+action,from:{id:1},message:{chat:{id:1},message_id:138},data:'lr:'+entry[0]};
 };
 return {store,calls,svc,callback};
}

test('HOME -> Create -> EP004 budget -> HOME uses only panel 138 and retains legacy menu',async()=>{
 const f=await fixture();await f.svc.show('1','1',{kind:'menu'});
 assert.equal(f.calls.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data,'ideas');
 await f.svc.callback(await f.callback('create_v2_ideas'));
 await f.svc.callback(await f.callback('create_v2_budget'));
 assert.match(f.calls.at(-1).body.media.caption,/USD 5,00/);
 assert.match(f.calls.at(-1).body.media.caption,/Inicio bloqueado/);
 await f.svc.callback(await f.callback('back'));
 assert.equal((await f.store.get('1')).state.screen.kind,'create_v2_ideas');
 await f.svc.callback(await f.callback('menu'));
 const s=(await f.store.get('1')).state;
 assert.equal(s.panel_state,'HOME');assert.equal(s.panel_content_type,'photo');
 assert.deepEqual(s.episodes,{});assert.equal(s.v2_authorizations,undefined);
 assert.ok(f.calls.every(c=>c.method==='editMessageMedia'||c.method==='answerCallbackQuery'));
});

test('blocked start is idempotent across restart; callback authorization flags cannot bypass it',async()=>{
 const f=await fixture();await f.svc.show('1','1',{kind:'create_v2_budget'});
 const cb=await f.callback('create_v2_start');
 Object.assign(cb,{budget_gate:'PASS',authorized:true,authorized_ceiling_usd:5,create_v2:true});
 const before=await f.store.get('1');
 for(let i=0;i<2;i++){
  const r=await f.svc.callback(cb);assert.equal(r.error,'BUDGET_GATE_BLOCKED');
  assert.equal(r.episode_created,false);assert.equal(r.authorization_created,false);assert.equal(r.provider_calls,0);
 }
 const restarted=new ReviewService({store:f.store,telegram:f.svc.telegram,loadBytes:()=>assert.fail('no upload'),production:f.svc.production});
 assert.equal((await restarted.callback(cb)).blocked,true);
 assert.deepEqual(await f.store.get('1'),before);
});

test('wrong owner, chat or panel cannot invoke EP004 start',async()=>{
 const f=await fixture();await f.svc.show('1','1',{kind:'create_v2_budget'});
 const valid=await f.callback('create_v2_start'),before=f.calls.length;
 for(const change of [cb=>cb.from.id=2,cb=>cb.message.chat.id=2,cb=>cb.message.message_id=139]){
  const cb=structuredClone(valid);change(cb);await assert.rejects(f.svc.callback(cb));
 }
 assert.equal(f.calls.length,before);
});
