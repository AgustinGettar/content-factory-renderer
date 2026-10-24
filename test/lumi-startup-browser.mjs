// Actual browser, real application. All account/API responses are synthetic;
// Telegram's CDN is deliberately held pending to prove it cannot block Studio.
import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const files=Object.fromEntries(await Promise.all(['app.js','style.css','index.html'].map(async n=>[n,await readFile(new URL('../public/lumi-studio/'+n,import.meta.url),'utf8')])));
const fixture=()=>({client_scope:'fixture-owner',client_session:'fixture-session',server_time:Date.now(),review_revision:4,
 episode:{id:'fixture-episode',title:'La granja',next_action:'video:q43',checkpoint_version:55,actions:[]},episodes:[],
 operation:{kind:'production_stage',status:'RUNNING',phase:'GENERATING'},episode_job:{id:'same-job',status:'WAITING_PROVIDER'},
 review_policy:{mode:'SUPERVISED',choice_available:true},episode_plan_authorization:{status:'AUTHORIZED',approval_available:true},
 current_action:{status:'SUBMITTED',emission_locked:true,operations:[]},production:{shots:[],action:{stage:'VIDEO'}},
 media:[],reviews:[],review_receipts:[],action_receipts:[],capabilities:{generate:false},budget:{ceiling_usd:8,exposure_usd:3,remaining_usd:5},settings:{}});
const browser=await chromium.launch({headless:true,...(process.env.LUMI_TEST_BROWSER?{executablePath:process.env.LUMI_TEST_BROWSER,args:['--no-sandbox','--disable-gpu']}: {})});
try{
 for(const scenario of ['existing-session','fresh-launch','read-failure']){
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[],paths=[],posts=[];
  let releaseSdk,failed=scenario==='read-failure',sdkFinished=false;const sdk=new Promise(resolve=>releaseSdk=resolve),raw='signed-fixture-init-data';
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname,json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(u.hostname==='telegram.org'){await sdk;sdkFinished=true;return route.fulfill({contentType:'text/javascript',body:''});}
   if(u.hostname!=='lumi.test')throw Error('EXTERNAL_REQUEST_FORBIDDEN');
   if(p==='/lumi/studio')return route.fulfill({contentType:'text/html',body:files['index.html']});
   if(p.endsWith('/app.js'))return route.fulfill({contentType:'text/javascript',body:files['app.js']});
   if(p.endsWith('/style.css'))return route.fulfill({contentType:'text/css',body:files['style.css']});
   paths.push(p);if(req.method()==='POST'){posts.push(p);assert.equal(p,'/lumi/studio/api/auth');assert.equal(req.postDataJSON().initData,raw);return json({csrf:'fixture'});}
   if(p.endsWith('/session')){assert.equal(u.searchParams.get('state'),'1');if(failed)return json({error:'UNAVAILABLE'},503);if(scenario==='fresh-launch')return json({error:'MINI_SESSION_REQUIRED'},401);return json({csrf:'fixture',state:fixture()});}
   if(p.endsWith('/state'))return json(fixture());
   throw Error('UNEXPECTED_API '+p);
  });
  const start=Date.now();await page.goto('https://lumi.test/lumi/studio#tgWebAppData='+encodeURIComponent(raw),{waitUntil:'domcontentloaded'});
  if(failed){await page.locator('[data-action=login]').waitFor({timeout:3000});failed=false;await page.locator('[data-action=login]').click();}
  await page.locator('.workflow-steps').waitFor({timeout:3000});assert.equal(sdkFinished,false,'Studio must render while the SDK is stalled');
  assert.equal(posts.length,scenario==='fresh-launch'?1:0);assert.equal(paths.filter(p=>p.endsWith('/state')).length,scenario==='fresh-launch'?1:0);
  await page.locator('[data-tab=ajustes]').click();await page.getByRole('heading',{name:'Tu estudio, bien cuidado.'}).waitFor();
  assert.equal(errors.length,0,errors.join(';'));
  console.log(JSON.stringify({measurement:'STUDIO_BROWSER_STARTUP',scenario,ready_ms:Date.now()-start,requests:paths.length,posts:posts.length,sdk_pending:true}));
  releaseSdk();await context.close();
 }
}finally{await browser.close();}
