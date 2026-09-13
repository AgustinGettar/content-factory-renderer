import test from 'node:test';
import assert from 'node:assert/strict';
import {handleUpdate,parseLocal,readAI,sourceUrl,aiRequest} from '../supabase/functions/content-factory-bot/core.mjs';
const uid='6213838779';
const update=(data='home')=>({update_id:42,callback_query:{id:'cb',from:{id:uid},data,message:{message_id:8,text:'Old menu',chat:{id:uid,type:'private'}}}});
function mock(overrides={}){
 const calls=[];const tables={cf_bot_admins:[{user_id:uid,chat_id:uid,channel_id:1}],channels:[{id:1,name:'Lumi',timezone:'Europe/Berlin',style_config:{}}],cf_bot_settings:[{generation_enabled:false,integrations:{youtube:'not_connected'}}],...overrides};
 return {calls,db:async(t,q)=>{calls.push({table:t,query:q});return tables[t]??[]},command:async(...args)=>{calls.push({command:args});return {}}};
}
test('start opens the six requested sections without AI or generation',async()=>{
 const m=mock(),r=await handleUpdate({update_id:1,message:{message_id:1,text:'/start',from:{id:uid},chat:{id:uid,type:'private'}}},m);
 assert.equal(r.ai,undefined);assert.equal(r.actions[0].method,'sendMessage');assert.equal(r.actions[0].body.reply_markup.inline_keyboard.flat().length,7);
 assert.equal(m.calls.filter(x=>x.command&&x.command[3]!=='session').length,0);
});
test('unauthorized users and groups receive no data and cause no mutations',async()=>{
 const m=mock({cf_bot_admins:[]});assert.deepEqual(await handleUpdate(update(),m),{actions:[]});assert.equal(m.calls.length,1);
 const u=update();u.callback_query.message.chat.type='group';const n=mock();assert.deepEqual(await handleUpdate(u,n),{actions:[]});assert.equal(n.calls.length,0);
});
test('calendar, history, review, published and stats handle empty state',async()=>{
 for(const route of ['ideas','history:0','reviews:0','approved:0','rejected:0','production:0','calendar','auto:0','published:0','stats:0','upcoming:0','settings']){
  const r=await handleUpdate(update(route),mock());assert.equal(r.actions[0].method,'answerCallbackQuery');assert.ok(r.actions.some(x=>x.method==='editMessageText'),route);assert.equal(r.ai,undefined);
  for(const x of r.actions)for(const row of x.body.reply_markup?.inline_keyboard??[])for(const b of row)assert.ok(Buffer.byteLength(b.callback_data)<=64);
 }
});
test('plain text cannot silently generate an idea',async()=>{
 const m=mock();await handleUpdate({update_id:1,message:{message_id:1,text:'un video nuevo',from:{id:uid},chat:{id:uid,type:'private'}}},m);assert.equal(m.calls.filter(x=>x.command).length,0);
});
test('local dates reject rollover and malformed values',()=>{
 assert.equal(parseLocal('20/09/2026 18:00'),'2026-09-20T18:00:00');
 for(const d of ['31/02/2026 12:00','01/01/2026 24:00','2026-09-20','20/13/2026 00:00'])assert.throws(()=>parseLocal(d));
});
test('private fields cannot flow into OpenAI request',()=>{
 const r=aiRequest('ideas',{name:'PRIVATE_CHANNEL'},[{idea:'colores SECRET_TOKEN'},{idea:'nombre@example.com 1234567'}]);
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_CHANNEL|SECRET_TOKEN|example.com|1234567/);assert.match(r.input,/previous_clips/);assert.equal(r.store,false);assert.ok(!r.tools);
 const t=aiRequest('trends',{},[]);assert.equal(t.tools[0].type,'web_search');assert.equal(t.tool_choice,'required');
});
test('trend references must be HTTPS video links present in actual search evidence',()=>{
 const item={title:'Contemos con Lumi',lesson:'Contar',relation:'Continuación',topic:'números',source_url:'https://www.youtube.com/shorts/abcdef',published_at:'',evidence:'Observado'};
 const response={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({items:[item]}),annotations:[]}]}]};
 assert.equal(readAI(response,'trends').length,0);
 response.output[0].content[0].annotations=[{url:item.source_url}];assert.equal(readAI(response,'trends').length,1);
 for(const u of ['http://youtube.com/watch?v=x','https://youtube.com.evil.test/shorts/x','https://tiktok.com/','javascript:alert(1)'])assert.equal(sourceUrl(u),null);
});
test('cache does not initiate another model call',async()=>{
 const m=mock();m.command=async()=>({id:'x',kind:'ideas',cached:true,status:'pending'});
 const r=await handleUpdate(update('new'),m);assert.equal(r.ai,undefined);
});
test('video lookup always scopes to the authorized channel',async()=>{
 const m=mock();await handleUpdate(update('video:999'),m);assert.equal(m.calls.find(x=>x.table==='videos').query.channel_id,'eq.1');
});
test('disabled AI reports the provider issue without calling the model or creating a job',async()=>{
 const m=mock({cf_bot_settings:[{ai_enabled:false,ai_message:'Sin créditos en la API'}]});
 const r=await handleUpdate(update('new'),m);assert.equal(r.ai,undefined);assert.equal(m.calls.filter(x=>x.command).length,0);assert.match(r.actions.at(-1).body.text,/Sin créditos/);
});
