// Offline private-event research; no database connection, network or publication.
import {readFile,writeFile} from 'node:fs/promises';
import {quantMetaDataset,evaluateQuantMeta} from '../lib/trading/quant-meta-label.js';
import {requireExternalResearch} from '../lib/trading/quant-experiments.js';
requireExternalResearch();
const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,all)=>x.startsWith('--')?[...a,[x.slice(2),all[i+1]]]:a,[]));
if(!args.events||!args.output)throw Error('--events and --output required');
const data=JSON.parse(await readFile(args.events,'utf8')),dataset=quantMetaDataset(Array.isArray(data)?data:data.events??[]),groups={};
for(const row of dataset.rows)(groups[row.domain]??=[]).push(row);
const result={generated_at:new Date().toISOString(),mode:'PAPER',realTrading:false,observations:dataset.rows.length,excluded:dataset.excluded,source_hash:dataset.source_hash,label:dataset.label,automatic_promotion:false,domains:Object.fromEntries(Object.entries(groups).map(([key,rows])=>[key,evaluateQuantMeta(rows)])),status:dataset.rows.length?'RESEARCH_ONLY':'INSUFFICIENT_DATA'};
await writeFile(args.output,JSON.stringify(result,null,2),{mode:0o600});
console.log(JSON.stringify({output:args.output,observations:result.observations,domains:Object.keys(groups).length,automatic_promotion:false}));
