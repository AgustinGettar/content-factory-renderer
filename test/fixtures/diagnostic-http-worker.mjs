import {readFileSync,writeFileSync,renameSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {MemoryLumiRecoveryStore} from '../../lib/lumi-recovery-incident-manager-v1.js';
import {isolatedFixture,secret} from './isolated-validation-v2.js';
import {signRequest} from '../../lib/telegram-review-v1/make-transport.js';
const [directory,mode,point]=process.argv.slice(2);mkdirSync(directory,{recursive:true});
const read=(name,fallback)=>existsSync(join(directory,name))?JSON.parse(readFileSync(join(directory,name),'utf8')):fallback;
const save=(name,value)=>{const path=join(directory,name);writeFileSync(path+'.tmp',JSON.stringify(value));renameSync(path+'.tmp',path);};
class DiskStore extends MemoryLumiRecoveryStore{
  constructor(){super();this.episodes=new Map(read('rows.json',[]));this.writes=0;}
  async putEpisode(value){const result=await super.putEpisode(value);save('rows.json',[...this.episodes]);this.writes++;return result;}
}
let entered,release;
const wait=new Promise(r=>release=r);
const f=await isolatedFixture({store:new DiskStore(),request:read('request.json'),base:read('base.json'),
  inject:async e=>{
    if(mode==='crash'&&e.point===point){process.stdout.write('KILL_NOW\n');await new Promise(()=>setInterval(()=>{},1000));}
    if(mode==='serve'&&e.point==='HTTP_RECEIVED_PERSISTED'){entered=true;process.stdout.write('RECEIVED\n');await wait;}
  }});
const nonce='request-'+point;
if(mode==='prepare'){
  save('request.json',f.request);save('base.json',f.base);
  for(const phase of ['CONTEXT','CREATE']){const r=await f.call(phase);if(r.code!==200)throw Error('PREPARATION_FAILED');}
  save('before.json',[...f.store.episodes]);
}else if(mode==='crash'){
  await f.send(f.envelope('RESUME',{},nonce));throw Error('CRASH_POINT_NOT_REACHED');
}else if(mode==='recover'){
  const before=readFileSync(join(directory,'rows.json'),'utf8');
  const path=`/lumi/telegram-review/make/diagnostic/local-operator/${f.base.operation_id}/${nonce}`;
  const signed={method:'GET',path,body:Buffer.alloc(0),requestId:'read-after-restart',timestamp:String(Math.floor(Date.now()/1000))};
  const q=await f.isolatedValidation.http.query({signed,signature:signRequest(secret,signed),user:'local-operator',
    operationId:f.base.operation_id,requestId:nonce});
  const v=await f.read();
  process.stdout.write(JSON.stringify({query:q,rows:f.store.episodes.size,writes:f.store.writes,
    unchanged:before===readFileSync(join(directory,'rows.json'),'utf8'),checkpoint_version:v.checkpoint.metadata.runtime_revision,
    first_pending_action:v.checkpoint.first_pending_action,lease_state:v.lease?'HELD':'FREE',
    claims:Object.keys(v.review.state.production_commands).length,events:f.events,production_access:f.forbidden,
    provider_generation_calls:0,guard_attempts:globalThis.LUMI_OFFLINE_GUARD.attempts})+'\n');
}else if(mode==='serve'){
  // Loopback transport only. Child is preloaded with the network/provider guard.
  const server=createServer(async(req,res)=>{
    if(req.url==='/release'){release();res.end('released');return;}
    if(req.url==='/stop'){res.end('stopped');server.close();return;}
    if(req.method!=='POST'||req.url!=='/lumi/telegram-review/make/v1'){res.writeHead(404).end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks),envelope={body:JSON.parse(body),signed:{method:'POST',path:req.url,body,
      timestamp:req.headers['x-lumi-timestamp'],requestId:req.headers['x-lumi-request-id']},signature:req.headers['x-lumi-signature']};
    const reply=await f.send(envelope);res.writeHead(reply.code,{'content-type':'application/json'}).end(JSON.stringify(reply.value));
    process.stdout.write('COMPLETED\n');
  });
  server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port,envelope:f.envelope('RESUME',{},nonce)})+'\n'));
  await new Promise(r=>server.on('close',r));
  if(!entered)throw Error('TIMEOUT_REQUEST_DID_NOT_REACH_ADMISSION');
  process.stdout.write(JSON.stringify({provider_generation_calls:0,guard_attempts:globalThis.LUMI_OFFLINE_GUARD.attempts})+'\n');
}
await f.cleanup();
