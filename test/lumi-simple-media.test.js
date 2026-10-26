import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {digest} from '../lib/telegram-mini-app/editor-media.js';
import {sendPrivateMedia,processDiagnostic} from '../lib/telegram-mini-app/private-media.js';
import {summarizeResults,uniquePosts} from '../public/lumi-studio/results-ui.js';
const get=(url,options={})=>new Promise((resolve,reject)=>{const req=http.request(url,options,res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));});req.on('error',reject);req.end();});
test('PRIVATE_STREAM actual HTTP range reads bounded upstream bytes, HEAD no body, private identity checked before cache',async()=>{
 const bytes=Buffer.alloc(4*1024*1024,17),a={bucket:'private',path:'verified.mp4',mime:'video/mp4',size:bytes.length,sha256:digest(bytes)},reads=[];
 const storage={openRead:async(_b,_p,{range})=>{const [start,end]=range.slice(6).split('-').map(Number);const part=bytes.subarray(start,end+1);reads.push(part.length);return new Response(part,{status:206,headers:{'Content-Length':String(part.length),'Content-Range':`bytes ${start}-${end}/${bytes.length}`}});},download:()=>{throw Error('FULL_DOWNLOAD_FORBIDDEN');}};
 const app=express();app.get('/private',async(req,res)=>{if(req.headers.cookie!=='owner=fixture')return res.sendStatus(401);try{await sendPrivateMedia(req,res,storage,a);}catch(e){res.status(409).json({error:e.message});}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/private';
 try{for(const raw of ['bytes=0-1023','bytes=2097152-2098175','bytes=-1024']){const r=await get(url,{headers:{cookie:'owner=fixture',range:raw}});assert.equal(r.status,206);assert.equal(r.bytes.length,1024);assert.equal(r.headers['content-length'],'1024');assert.equal(r.headers['content-type'],'video/mp4');assert.ok(r.headers['content-range']);}
 assert.equal((await get(url,{method:'HEAD',headers:{cookie:'owner=fixture'}})).bytes.length,0);assert.equal((await get(url,{headers:{range:'bytes=0-1'}})).status,401);assert.equal((await get(url,{headers:{cookie:'owner=fixture',range:'bytes=0-1,5-9'}})).status,416);assert.deepEqual(reads,[1024,1024,1024]);
 console.log(JSON.stringify({range_samples:3,source_bytes:bytes.length,upstream_bytes:reads.reduce((a,b)=>a+b,0),head_upstream_reads:0}));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('RESULTS summary preserves absent/zero, deduplicates publications, rejects mixed scopes and unknown units',()=>{
 const p={key:'a',network:'instagram',post_id:'1',range:{from:'a',to:'b'},organic_paid:'ORGANIC',observed_at:'2026-10-26T00:00Z',values:{views:{value:0,unit:'count'},likes:{value:null,unit:'count'}}};
 const next={...p,observed_at:'2026-10-26T01:00Z',values:{...p.values,views:{value:5,unit:'count'}}};let s=summarizeResults({posts:[p,next]});assert.equal(s.posts,1);assert.equal(s.views.value,5);assert.equal(s.likes.value,null);assert.equal(uniquePosts([next,p]).length,1);
 s=summarizeResults({posts:[p,{...next,network:'tiktok',organic_paid:'NOT_SPECIFIED'}]});assert.equal(s.posts,2);assert.equal(s.views.value,null);assert.equal(s.comparable,false);
 assert.equal(summarizeResults({posts:[{...p,values:{views:{value:200,unit:'people'}}}]}).views.value,null);
});
test('PROCESS_DIAGNOSTIC retains explicit signal/code and never infers OOM or exposes source arguments',()=>{
 const d=processDiagnostic({code:1,signal:null,killed:false,stderr:'error https://private.example/file?token=secret\nfailed /tmp/private/owner.mp4 token=abc'},480000,performance.now()-12);
 assert.equal(d.exit_code,1);assert.equal(d.signal,null);assert.equal(d.timeout_ms,480000);assert.ok(d.elapsed_ms>=12);assert.doesNotMatch(JSON.stringify(d),/private.example|owner.mp4|secret|abc|OOM/);
});
test('PRIVATE_STORAGE renews server-only signed access for each bounded read and forwards cancellation',async()=>{
 const {createArtifactStorage}=await import('../lib/lumi-artifact-materialization-v2.js'),calls=[],issued=[],originalFetch=globalThis.fetch;
 const storage=createArtifactStorage({storage:{from:bucket=>({createSignedUrl:async(path,ttl)=>{issued.push({bucket,path,ttl});return {data:{signedUrl:'https://storage.example.test/read/'+issued.length}};}})}}),controller=new AbortController();
 globalThis.fetch=async(url,options)=>{calls.push({url,...options});return new Response(new Uint8Array([1]),{status:206,headers:{'Content-Length':'1','Content-Range':'bytes 0-0/10','Content-Type':'video/mp4'}});};
 try{await storage.openRead('private','verified/clip.mp4',{range:'bytes=0-0',signal:controller.signal});await storage.openRead('private','verified/clip.mp4',{range:'bytes=0-0',signal:controller.signal});assert.equal(issued.length,2);assert.equal(issued[0].ttl,60);assert.notEqual(calls[0].url,calls[1].url);assert.equal(calls[0].headers.Range,'bytes=0-0');assert.equal(calls[0].signal,controller.signal);await assert.rejects(storage.openRead('private','../wrong'),/IDENTITY_INVALID/);}finally{globalThis.fetch=originalFetch;}
});
