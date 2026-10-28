import {readFile,writeFile} from 'node:fs/promises';
import {replay} from '../lib/trading/backtest.js';
const [inputPath,outputPath]=process.argv.slice(2);if(!inputPath||!outputPath)throw Error('Usage: node scripts/trading-replay.mjs market-events.json report.json');
const input=JSON.parse(await readFile(inputPath,'utf8'));
const reports=[30,60,180,300].map(seconds=>replay(input,{latency:seconds*1000}));
await writeFile(outputPath,JSON.stringify({mode:'OFFLINE_RESEARCH_ONLY',reports},null,2)+'\n');
console.log(JSON.stringify(reports.map(r=>({latency:r.latency,fills:r.fills,net:r.net,validation:r.validation}))));
