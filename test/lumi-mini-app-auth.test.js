import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {MemoryReviewStore} from '../lib/telegram-review-v1/core.js';
import {MiniAppAuth,validateInitData,assertMiniPrincipal,miniAppEnabled} from '../lib/telegram-mini-app/auth.js';

const token='12345:OFFLINE_TELEGRAM_TOKEN',env={LUMI_RUNTIME_ENV:'staging',SUPABASE_URL:'https://mofjhwathxzfnjapvvst.supabase.co',LUMI_TELEGRAM_BOT_TOKEN:token};
function sign(values={},key=token){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:'test-query',user:JSON.stringify({id:1,first_name:'Test'}),...values});
 const secret=createHmac('sha256','WebAppData').update(key).digest(),check=[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 p.set('hash',createHmac('sha256',secret).update(check).digest('hex'));return p.toString();}
async function fixture(){const store=new MemoryReviewStore();await store.create('1',{user_id:'1',chat_id:'1',message_id:148});let active=true;
 const auth=new MiniAppAuth({store,env,validateOwner:async(u,c)=>active&&u==='1'&&c==='1'});return {store,auth,deactivate:()=>active=false};}

test('AUTH_SECURITY: official HMAC, exact identity, timestamp and duplicate-field checks',()=>{
 assert.equal(validateInitData(sign(),token).user,'1');
 for(const raw of [sign({},'other'),sign().replace('Test','Forged'),sign()+'&user=%7B%22id%22%3A2%7D',
  sign({auth_date:String(Math.floor(Date.now()/1000)-301)}),sign({auth_date:String(Math.floor(Date.now()/1000)+60)}),
  sign({user:'{"id":"1"}'}),sign({user:'null'}),sign({chat_type:'group'}),sign({chat:JSON.stringify({id:-1,type:'group'})}),sign({auth_date:'1e10'})])
  assert.throws(()=>validateInitData(raw,token));
 assert.throws(()=>assertMiniPrincipal({user:'1'}),/SESSION_REQUIRED/);
});
test('AUTH_SECURITY: exchange is one-time across instances; session supports re-open, CSRF and owner revocation',async()=>{
 const f=await fixture(),raw=sign(),results=await Promise.allSettled([f.auth.login(raw),f.auth.login(raw)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const session=results.find(x=>x.status==='fulfilled').value;
 const restarted=new MiniAppAuth({store:f.store,env,validateOwner:async()=>true});
 await assert.rejects(restarted.login(raw),/REPLAY/);
 assert.equal((await restarted.authenticate(session.cookie,session.csrf)).user,'1');
 await assert.rejects(restarted.authenticate(session.cookie,'forged'),/CSRF/);
 await assert.rejects(restarted.authenticate('1.'+'a'.repeat(64)),/SESSION_EXPIRED/);
 const principal=await restarted.authenticate(session.cookie);assert.throws(()=>assertMiniPrincipal({...principal}));
 f.deactivate();await assert.rejects(f.auth.authenticate(session.cookie),/SESSION_EXPIRED/);
});
test('AUTH_SECURITY: no freely supplied identity, wrong private chat or expired session; staging is pinned',async()=>{
 const f=await fixture();await assert.rejects(f.auth.login(sign({user:JSON.stringify({id:2})})),/OWNER/);
 await assert.rejects(f.auth.login(sign({chat:JSON.stringify({id:2,type:'private'})})),/OWNER/);
 const s=await f.auth.login(sign()),p=await f.auth.authenticate(s.cookie),r=await f.store.get('1');
 r.state.mini_app.sessions[p.session].expires_at=0;await f.store.cas('1',r.revision,r.state);await assert.rejects(f.auth.authenticate(s.cookie),/EXPIRED/);
 assert.equal(miniAppEnabled(env),true);
 for(const patch of [{LUMI_RUNTIME_ENV:'production'},{SUPABASE_URL:'https://production.supabase.co'},{RENDER_SERVICE_ID:'production'},{LUMI_MINI_APP_ENABLED:'false'}])assert.equal(miniAppEnabled({...env,...patch}),false);
});
test('MOBILE_UI_OFFLINE: four accessible sections, safe areas, native video, separate spend/generation and no client secrets',async()=>{
 const js=await readFile(new URL('../public/lumi-studio/app.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/lumi-studio/style.css',import.meta.url),'utf8'),html=await readFile(new URL('../public/lumi-studio/index.html',import.meta.url),'utf8');
 for(const word of ['Inicio','Videos','Producción','Ajustes'])assert.ok(js.includes(word));
 assert.match(html,/viewport-fit=cover/);assert.match(html,/aria-live="polite"/);assert.match(css,/safe-area-inset-bottom/);
 assert.match(js,/controls playsinline/);assert.match(js,/Autorizar este importe/);assert.match(js,/Confirmar y generar/);
 assert.match(js,/Consultando precio…/);assert.match(js,/visibilitychange/);
 assert.doesNotMatch(js+html,/initDataUnsafe|SUPABASE_SERVICE_ROLE_KEY|HF_API_KEY|editMessageMedia|api\.higgsfield/);
});
