import {mountMakeTransportEndpoint} from '../lib/telegram-review-v1/make-endpoint.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryReviewStore,ReviewService,newSession,sha256} from '../lib/telegram-review-v1/core.js';
import {MakeTransport,signRequest,multipartBody,multipartPhotoAction,acknowledgeCommand} from '../lib/telegram-review-v1/make-transport.js';
import {signedMediaTransport} from '../lib/telegram-review-v1/runtime.js';
const bytes=Buffer.alloc(6045628,42),sha=sha256(bytes);
const artifact={artifact_id:'q41',mime:'image/png',size:bytes.length,sha256:sha,bucket:'private',path:'q41.png',width:1520,height:2688};
const evidence={http_status:400,description:'Bad Request: failed to get HTTP URL content',execution_id:'edb2c68e1c9c41819ac7d8b08be372f2'};
async function setup(){
 const store=new MemoryReviewStore(),s=newSession({user_id:'1',chat_id:'1',message_id:148,cover:artifact});
 s.screen={kind:'q41_review'};s.episodes={historical:{human_status:'MASTER_HUMAN_APPROVED'}};
 const command={idempotency_key:'old',method:'editMessageMedia',message_id:148,artifact,artifact_sha:sha,body:{chat_id:'1',message_id:148,media:{type:'photo',media:'https://private.invalid/old',caption:'Review original'},reply_markup:{inline_keyboard:[[{text:'Aprobar imagen y revisión visual',callback_data:'lr:approve'}]]}}};
 s.delivery={status:'EMITTING',command,artifact_sha:sha,tokens:['approve']};await store.create('1',s);
 const svc=new ReviewService({store,telegram:new MakeTransport(),loadBytes:async()=>bytes});
 const authorize=async(overrides={})=>{const row=await store.get('1');return svc.authorizeRejectedDelivery('1','1',{expected_revision:row.revision-1,command_id:'old',evidence,...overrides});};
 return {store,svc,authorize,command};
}
test('multipart wire preserves every original byte, fields and same panel',async()=>{
 const f=await setup(),a=await multipartPhotoAction(f.command,async()=>bytes);
 const form=await new Request('http://localhost',{method:'POST',headers:{'content-type':a.content_type},body:Buffer.from(a.multipart_base64,'base64')}).formData();
 assert.equal(form.get('message_id'),'148');assert.equal(JSON.parse(form.get('media')).media,'attach://lumi_file');
 assert.equal(sha256(Buffer.from(await form.get('lumi_file').arrayBuffer())),sha);
});
test('multipart read-only probe parses chat identity',async()=>{
 const a=multipartBody({chat_id:'1'}),f=await new Request('http://localhost',{method:'POST',headers:{'content-type':a.content_type},body:Buffer.from(a.multipart_base64,'base64')}).formData();assert.equal(f.get('chat_id'),'1');
});
test('oversize URL photo switches to binary without signing a URL',async()=>{
 assert.equal(await signedMediaTransport({storage:{from:()=>assert.fail('no URL')}})(artifact),null);
});
test('hash mismatch and unsupported multipart scope fail before emission',async()=>{
 const f=await setup();await assert.rejects(multipartPhotoAction(f.command,async()=>Buffer.from('wrong')),/artifact_bytes_mismatch/);
 await assert.rejects(multipartPhotoAction({...f.command,method:'sendPhoto'},async()=>bytes),/scope_invalid/);
});
test('recovery requires exact revision, command, definitive error and operational panel',async()=>{
 for(const change of [{expected_revision:999},{command_id:'wrong'},{evidence:{...evidence,http_status:500}},{evidence:{...evidence,description:'timeout'}}]){
 const f=await setup();await assert.rejects(f.authorize(change),/rejection_required/);assert.equal((await f.store.get('1')).state.delivery_recovery,undefined);}
 const f=await setup();await assert.rejects(f.svc.recoverRejectedDelivery('1','1'),/rejection_required/);
});
test('double request CAS, restart and lost response never re-emit binary',async()=>{
 const f=await setup();await f.authorize();const r=await Promise.all([f.svc.recoverRejectedDelivery('1','1'),f.svc.recoverRejectedDelivery('1','1')]);assert.equal(r.flatMap(x=>x.commands).length,1);
 const row=await f.store.get('1');assert.equal(row.state.delivery_history.old.status,'DEFINITIVELY_REJECTED');assert.equal(row.state.message_id,148);
 const restarted=new ReviewService({store:f.store,telegram:new MakeTransport(),loadBytes:async()=>bytes});assert.deepEqual((await restarted.recoverRejectedDelivery('1','1')).commands,[]);
});
test('ACK stays bound to replacement command and preserves historical master',async()=>{
 const f=await setup();await f.authorize();const c=(await f.svc.recoverRejectedDelivery('1','1')).commands[0];
 const msg={message_id:148,chat:{id:1},caption:c.body.media.caption,reply_markup:c.body.reply_markup,photo:[{file_id:'q41',file_unique_id:'original'}]};
 await assert.rejects(acknowledgeCommand(f.store,'1','1','old',msg),/mismatch/);
 await acknowledgeCommand(f.store,'1','1',c.idempotency_key,msg);assert.equal((await acknowledgeCommand(f.store,'1','1',c.idempotency_key,msg)).already_applied,true);
 const s=(await f.store.get('1')).state;assert.equal(s.delivery_recovery.status,'DELIVERED');assert.equal(s.episodes.historical.human_status,'MASTER_HUMAN_APPROVED');assert.equal(s.message_id,148);
 assert.deepEqual((await f.svc.recoverRejectedDelivery('1','1')).commands,[]);
});
test('expired operator authorization and ambiguous current state fail closed',async()=>{
 for(const mutate of [s=>s.delivery.status='UNKNOWN',s=>s.delivery_recovery.expires_at=0]){
 const f=await setup();await f.authorize();const row=await f.store.get('1');mutate(row.state);await f.store.cas('1',row.revision,row.state);await assert.rejects(f.svc.recoverRejectedDelivery('1','1'),/rejection_required/);}
});

async function endpoint(f){
 const routes=new Map(),secret='test-secret-'.repeat(5),path='/lumi/telegram-review/make/v1';
 mountMakeTransportEndpoint({get:()=>{},post:(p,h)=>routes.set(p,h)},{store:f.store,env:{LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',LUMI_TELEGRAM_CALLBACK_SECRET:secret},loadBytes:async()=>bytes,log:()=>{}});
 return async(body,id,forged=false)=>{const rawBody=Buffer.from(JSON.stringify(body)),signed={timestamp:String(Math.floor(Date.now()/1000)),requestId:id,path,body:rawBody},res={code:200,status(c){this.code=c;return this;},json(v){this.value=v;return this;}};
 await routes.get(path)({body,rawBody,path,headers:{'x-lumi-timestamp':signed.timestamp,'x-lumi-request-id':id,'x-lumi-signature':forged?'0'.repeat(64):signRequest(secret,signed)}},res);return res;};
}
test('signed authorization and fresh Make ISO command emit one transient binary action',async()=>{
 const f=await setup(),call=await endpoint(f),revision=(await f.store.get('1')).revision;
 assert.equal((await call({op:'AUTHORIZE_REJECTED_DELIVERY',user_id:'1',chat_id:'1',command_id:'old',expected_revision:revision,evidence},'authorize')).code,200);
 const body={update_id:5,message:{from:{id:1},chat:{id:1},date:new Date().toISOString(),text:'/recuperar_entrega'}};
 const r=await call(body,'dispatch');assert.equal(r.code,200);assert.equal(r.value.actions.length,1);assert.ok(r.value.actions[0].multipart_base64);
 assert.equal(JSON.stringify((await f.store.get('1')).state).includes('multipart_base64'),false);
 assert.equal((await call(body,'duplicate')).value.actions.length,0);
});
test('forged authorization and stale recovery command cannot claim emission',async()=>{
 const f=await setup(),call=await endpoint(f),revision=(await f.store.get('1')).revision;
 assert.equal((await call({op:'AUTHORIZE_REJECTED_DELIVERY',user_id:'1',chat_id:'1',command_id:'old',expected_revision:revision,evidence},'forged',true)).code,401);
 assert.equal((await call({message:{from:{id:1},chat:{id:1},date:'2020-01-01T00:00:00.000Z',text:'/recuperar_entrega'}},'expired')).code,409);
 assert.equal((await f.store.get('1')).state.delivery.command.idempotency_key,'old');
});
