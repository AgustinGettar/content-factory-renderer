import {readFile,writeFile} from 'node:fs/promises';
import {generateImprovementArtifacts} from '../lib/lumi-improvement-loop.js';
const root=new URL('../docs/',import.meta.url);
const state=JSON.parse(await readFile(new URL('lumi-improvement/state.json',root),'utf8'));
const incidents=JSON.parse(await readFile(new URL('lumi-improvement/incidents.json',root),'utf8'));
const result=generateImprovementArtifacts(state,incidents);
for(const [name,text] of [['LUMI_RESUME_STATE.md',result.resume],['LUMI_PROMPT_FEEDBACK.md',result.feedback],['LUMI_NEXT_PROMPT.txt',result.prompt]]){
  await writeFile(new URL(name,root),text);
}
console.log(JSON.stringify({status:'DRAFT_ONLY',input_sha256:result.input_sha256,provider_calls:0}));
