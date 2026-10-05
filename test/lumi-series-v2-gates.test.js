import test from 'node:test';
import assert from 'node:assert/strict';
import {stepIdentity,budgetGate,sourceGate,previousVideoGate,bodyAnatomyGate,BODY_QA_FIELDS} from '../lib/lumi-series-v2-gates.js';
const bodyPass=()=>Object.fromEntries([['BODY_LOCK_VERSION','LUMI_BODY_ANATOMY_LOCK_V1'],['ANATOMY','PASS'],...BODY_QA_FIELDS.map(k=>[k,'PASS'])]);
test('paid scope is restricted to exactly five remaining shots and one immutable revision per stage',()=>{
 assert.equal(stepIdentity('q32','IMAGE'),'q32-SOURCE-V2-1');assert.equal(stepIdentity('q36','VIDEO'),'q36-V2-PRO1');
 for(const [shot,stage] of [['q31','VIDEO'],['q37','VIDEO'],['q32','TTS']])assert.throws(()=>stepIdentity(shot,stage));
});
test('budget must use latest explicit approval and stop above the exact new ceiling',()=>{
 const b={status:'AUTHORIZED',allow_emission:true,authorized_additional_ceiling_usd:3.24};
 assert.doesNotThrow(()=>budgetGate(b,3.238));assert.throws(()=>budgetGate(b,3.241));
 assert.throws(()=>budgetGate({...b,status:'QUALITY_BUDGET_REVIEW_REQUIRED'},3));assert.throws(()=>budgetGate(b,null));
});
test('video requires every source gate and exact byte binding, not a generic image success',()=>{
 const record={sha256:'abc'},qa={...bodyPass(),sha256:'abc',classification:'PASS',IDENTITY:'PASS',REALISM:'PASS',ANATOMY:'PASS',EDUCATIONAL_SEMANTICS:'PASS',COLOR:'PASS',VIDEO_SOURCE_READINESS:'PASS',CARTOON_DRIFT:'MINIMAL'};
 assert.doesNotThrow(()=>sourceGate(record,{content_hash:'abc',result:{visual_qa:qa}}));
 assert.throws(()=>sourceGate(record,{content_hash:'wrong',result:{visual_qa:qa}}));
 assert.throws(()=>sourceGate(record,{content_hash:'abc',result:{visual_qa:{...qa,ANATOMY:'FAIL'}}}));
 assert.throws(()=>sourceGate(record,{content_hash:'abc',result:{visual_qa:{...qa,CARTOON_DRIFT:'HIGH'}}}));
});
test('later paid sources require prior video parity with golden and technical PASS',()=>{
 const r={content_hash:'abc',result:{temporal_qa:{...bodyPass(),sha256:'abc',QUALITY_PARITY_WITH_Q31_PRO2:'PASS_WITH_MINOR_WARNING',TECHNICAL_QA:'PASS'}}};
 assert.doesNotThrow(()=>previousVideoGate(r));assert.throws(()=>previousVideoGate({...r,content_hash:'wrong'}));assert.throws(()=>previousVideoGate({result:{}}));
});

test('source and temporal gates reject unreviewed anatomy, forbidden rear anatomy and contradictory quality PASS',()=>{
 for(const key of BODY_QA_FIELDS)assert.throws(()=>bodyAnatomyGate({...bodyPass(),[key]:'FAIL'}));
 assert.throws(()=>bodyAnatomyGate({ANATOMY:'PASS'}));
 assert.throws(()=>bodyAnatomyGate({...bodyPass(),ANATOMY:'BLOCKER'}));
 const temporal={...bodyPass(),sha256:'abc',TECHNICAL_QA:'PASS',QUALITY_PARITY_WITH_Q31_PRO2:'PASS',NO_BEE_ABDOMEN:'FAIL'};
 assert.throws(()=>previousVideoGate({content_hash:'abc',result:{temporal_qa:temporal}}));
 const source={...bodyPass(),sha256:'abc',classification:'PASS',IDENTITY:'PASS',REALISM:'PASS',EDUCATIONAL_SEMANTICS:'PASS',COLOR:'PASS',VIDEO_SOURCE_READINESS:'PASS',CARTOON_DRIFT:'MINIMAL',NO_REAR_BULB:'UNKNOWN'};
 assert.throws(()=>sourceGate({sha256:'abc'},{content_hash:'abc',result:{visual_qa:source}}));
});
