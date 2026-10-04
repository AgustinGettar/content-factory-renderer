import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('app.post("/lumi-pipeline/v1_1_2/episodes/third/temporal-qa"');
const end=source.indexOf('app.post("/lumi-pipeline/v1_1_2/episodes/third/tts"',start);
const route=source.slice(start,end);
for(const valid of [true,false])test('temporal QA route '+(valid?'binds reviewed bytes':'rejects mismatched bytes'),async()=>{
 const sha='a'.repeat(64);let handler,received;
 const sandbox={app:{post:(path,fn)=>{handler=fn;}},authorized:()=>true,LUMI_RUNTIME_ENV:'staging',supabase:{},
 recordThirdShortTemporalQa:async input=>{received=input;if(input.expectedSha256!==sha)throw new Error('artifact_binding_required');return {status:'PASS',provider_calls:0};}};
 vm.runInNewContext(route,sandbox);
 let code=200,payload;
 const res={status(n){code=n;return this;},json(p){payload=p;return this;}};
 await handler({body:{scene_id:'q31',classification:'PASS',sha256:valid?sha:'b'.repeat(64),findings:[]}},res);
 assert.equal(code,valid?200:400);assert.equal(payload.ok,valid);
 if(valid)assert.equal(received.expectedSha256,sha);
});
