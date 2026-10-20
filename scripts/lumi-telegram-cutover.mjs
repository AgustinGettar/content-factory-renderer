// Explicit operator invocation only. No token/webhook secret leaves the backend.
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
const [action,sha,keyFile,expectedDestination]=process.argv.slice(2);
if(!['INSPECT','CONFIGURE'].includes(action)||!/^[a-f0-9]{40}$/.test(sha||'')||!keyFile)throw Error('Usage: INSPECT|CONFIGURE staging_sha private_key_file [destination_sha256]');
const key=(await readFile(keyFile,'utf8')).trim();
const body={action,expected_staging_sha:sha};
if(action==='CONFIGURE')body.expected_destination_sha256=expectedDestination;
const timestamp=String(Math.floor(Date.now()/1000)),payload=JSON.stringify(body);
const signature=createHmac('sha256',key).update(timestamp+'\n'+payload).digest('hex');
try{
 const r=await fetch('https://content-factory-av2-staging.onrender.com/lumi/telegram-review/telegram/cutover',{
  method:'POST',headers:{'content-type':'application/json','x-lumi-cutover-timestamp':timestamp,'x-lumi-cutover-signature':signature},body:payload,signal:AbortSignal.timeout(90000)});
 const data=await r.json();console.log(JSON.stringify({http_status:r.status,...data}));if(!r.ok)process.exitCode=1;
}catch{console.error('DIRECT_CUTOVER_RESPONSE_UNAVAILABLE: inspect real state; do not repeat CONFIGURE');process.exitCode=1;}
