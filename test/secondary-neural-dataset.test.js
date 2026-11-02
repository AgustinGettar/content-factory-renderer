// Isolated synthetic event streams. No live SQLite, remote APIs or trading orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {D,hash} from '../lib/trading/core.js';
import {entryCandidates} from '../lib/trading/secondary-entry-context.js';
import {EXPLORATION_POLICY} from '../lib/trading/secondary-exploration.js';
import {PROFIT_POLICY} from '../lib/trading/secondary-profit-policy.js';
import {captureSecondaryNeuralSignal,buildSecondaryNeuralLabel} from '../lib/trading/secondary-neural-data.js';
import {SecondaryNeuralDataset,NEURAL_DATASET_VERSION,NEURAL_DATASET_LIMITS} from '../lib/trading/secondary-neural-dataset.js';

const C=Date.parse('2026-11-02T02:00:00Z'),T=C+2000,END=T+60000,AS_OF=END+100000;
const q={source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:T,received_at:T,bid:'200.8',ask:'200.81',bid_qty:'100',ask_qty:'100',suspended:false};
const meta={symbol:'PF_XBTUSD',tick_size:.01,qty_step:.0001};
const bars=tf=>Array.from({length:96},(_,i)=>({start:C-(96-i)*tf*60000,end:C-(95-i)*tf*60000,open:199.9,high:200.2,low:199.7,close:199.9,volume:1}));
const wrap=(payload,rowid)=>({rowid,id:'isolated-event-'+rowid,kind:payload.type,payload,created_at:new Date(payload.at??T).toISOString()});
function fixture(id='isolated-operation'){
 const series={5:bars(5),15:bars(15)};Object.assign(series[5].at(-1),{open:199.9,high:200.9,low:199.9,close:200.8,volume:2});
 const decision=entryCandidates(series,q,meta,C,T,0,EXPLORATION_POLICY,PROFIT_POLICY).find(row=>row.pattern==='BREAKOUT');decision.plan.id=id;
 const snapshot=captureSecondaryNeuralSignal({decision,series,quote:q,meta,existing:{positions:[],pendingOrders:[]},cutoff:C,now:T,explorationPolicy:EXPLORATION_POLICY,profitPolicy:PROFIT_POLICY});assert.equal(snapshot.exclusion,null);
 const plan={...structuredClone(decision.plan),sizing:{qty:'.3'}},common={id,version:plan.version,ledger:'FREQUENT_PAPER',realTrading:false,plan};
 const selected={...common,type:'SELECTED',at:T};
 const fill={...common,type:'FILLED',fill_id:id+'-entry',at:T+1100,qty:'.3',price:plan.entry,fee:'.03'};
 const closed={...common,type:'CLOSED',fill_id:id+'-exit',at:END,entered_at:fill.at,entry:fill.price,qty:'.3',remaining_qty:'0',pnl:'.5',gross:'.6',fees:'.1',funding:'0',reason:'TRAILING_RETRACEMENT',quality:'OBSERVED',management_override:false,result_final:true,funding_complete:true,data_gaps:[],excursions:{max_adverse_net:'-.2'},entry_fills:[{id:fill.fill_id,at:fill.at,qty:fill.qty,price:fill.price,fee:fill.fee}]};
 const prediction={version:'secondary-neural-1.0.0',signal_id:snapshot.signal_id,operation_id:id,snapshot_hash:snapshot.snapshot_hash,at:T,mode:'ADVISORY',model_id:'isolated-model',prediction:{status:'AVAILABLE',estimated_net_return:.004},base_reason:'CANDIDATE',base_rank:0,base_candidate_count:1,base_eligible:true,cohort_id:'isolated-cohort',cohort_eligible_count:1,effective_action:'ENTRY_PENDING'};
 const capture={type:'NEURAL_SIGNAL_CAPTURED',id:snapshot.snapshot_id,at:T,ledger:'FREQUENT_PAPER',realTrading:false,snapshot};
 const decisionEvent={type:'NEURAL_ENTRY_DECISION',id:snapshot.signal_id,at:T,ledger:'FREQUENT_PAPER',realTrading:false,decision:prediction};
 return {id,snapshot,plan,selected,fill,closed,prediction,capture,decisionEvent,events:[capture,selected,decisionEvent,fill,closed]};
}
const apply=(reducer,events,start=1)=>reducer.applyPage(events.map((event,i)=>wrap(event,start+i)),{asOf:AS_OF});

test('durable pages produce one complete row and checkpoint resumes without reading UI history',()=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset();apply(dataset,f.events.slice(0,3));const checkpoint=dataset.checkpoint();const resumed=new SecondaryNeuralDataset({checkpoint:JSON.parse(JSON.stringify(checkpoint))});apply(resumed,f.events.slice(3),4);
 const result=resumed.export();assert.equal(result.version,NEURAL_DATASET_VERSION);assert.equal(result.source,'DURABLE_SQLITE_EVENTS');assert.equal(result.rows.length,1);assert.equal(result.rows[0].label.status,'MATURE');assert.equal(result.rows[0].label.full_fill,true);assert.equal(result.rows[0].snapshot.input_hash,f.snapshot.input_hash);assert.deepEqual(result.rows[0].decision,f.prediction);assert.equal(result.counts.usable,1);assert.equal(result.checkpoint.cursor,5);assert.equal(result.counts.captures,1);
 const once=resumed.checkpoint();resumed.applyPage(f.events.map((event,i)=>wrap(event,i+1)),{asOf:AS_OF});assert.deepEqual(resumed.checkpoint(),once);
});
test('duplicate raw fills, close receipts and worker labels cannot add operations or outcomes',()=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset();apply(dataset,f.events);const label=buildSecondaryNeuralLabel({snapshot:f.snapshot,closed:f.closed,entryEvents:[f.fill],exitEvents:[f.closed]});
 apply(dataset,[f.fill,f.closed,{type:'NEURAL_LABEL_RECORDED',id:f.id,at:END,ledger:'FREQUENT_PAPER',realTrading:false,label}],6);
 const result=dataset.export();assert.equal(result.rows.length,1);assert.equal(result.rows[0].label.label_revision,1);assert.equal(result.counts.label_updates,1);assert.equal(result.counts.worker_label_disagreements,0);assert.equal(result.rows[0].label.net,'0.5');
});
test('original events reconstruct a mature label when the bounded worker cache had no label record',()=>{
 const dataset=new SecondaryNeuralDataset(),a=fixture('isolated-a'),b=fixture('isolated-b');apply(dataset,[a.capture,b.capture,a.selected,b.selected,a.fill,b.fill,a.closed,b.closed]);
 const result=dataset.export();assert.equal(result.rows.length,2);assert(result.rows.every(row=>row.label.status==='MATURE'));assert.equal(result.counts.usable,2);assert.equal(result.counts.label_updates,2);
});
test('late funding revisions update one operation and survive checkpoints without conflicting duplicate training rows',()=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset();Object.assign(f.closed,{quality:'FUNDING_GAP',funding_complete:false,result_final:false});apply(dataset,f.events);
 let result=dataset.export();assert.equal(result.rows[0].label.status,'PENDING');const firstHash=result.rows[0].label.label_hash;
 const funding={type:'FUNDING_RECONCILED',version:f.plan.version,ledger:'FREQUENT_PAPER',realTrading:false,id:f.id,at:END+1000,amount:'.1',net_adjustment:'-.1',net_after:'.4',funding_complete:true,plan:f.plan};apply(dataset,[funding],6);
 result=dataset.export();assert.equal(result.rows.length,1);assert.equal(result.rows[0].label.status,'MATURE');assert.equal(result.rows[0].label.net,'0.4');assert.equal(result.rows[0].label.label_revision,2);assert.equal(result.rows[0].label.supersedes_label_hash,firstHash);
 const resumed=new SecondaryNeuralDataset({checkpoint:dataset.checkpoint()});apply(resumed,[funding],7);assert.equal(resumed.export().rows[0].label.label_revision,2);
 const next={...funding,at:END+2000,amount:'.05',net_adjustment:'-.05',net_after:'.35'};apply(resumed,[next],8);result=resumed.export();assert.equal(result.rows.length,1);assert.equal(result.rows[0].label.label_revision,3);assert.equal(result.rows[0].label.net,'0.35');assert.equal(result.counts.usable,1);assert.equal(result.counts.pending_labels,0);
});
test('partials are aggregated once; manual evidence in an earlier fragment excludes the final operation',()=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset();const partial={...f.closed,type:'PARTIAL_CLOSE',fill_id:'first-exit',at:END-1000,qty:'.1',remaining_qty:'.2',pnl:'.2',gross:'.23',fees:'.03',management_override:true,reason:'MANUAL_CLOSE'};
 apply(dataset,[...f.events.slice(0,-1),partial,f.closed]);const result=dataset.export();assert.equal(result.rows.length,1);assert.equal(result.rows[0].label.status,'EXCLUDED');assert.equal(result.rows[0].label.exclusion,'MANUAL_OR_MANAGEMENT_OVERRIDE');assert.equal(result.rows[0].label.net,'0.5');
});
test('unfilled, rejected and absent signals remain unlabelled rather than synthetic losses',()=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset();const rejected={...f.decisionEvent,decision:{...f.prediction,base_eligible:false,effective_action:'EXPECTED_NET_TARGET_BELOW_MINIMUM'}};
 apply(dataset,[f.capture,rejected,{...f.selected,type:'NOT_FILLED',at:T+30000,reason:'IOC_NO_OBSERVED_LIQUIDITY'},{type:'PAPER_CAPITAL_TOPUP',at:T+5000,ledger:'FREQUENT_PAPER',amount:'1000000',realTrading:false}]);
 const result=dataset.export();assert.equal(result.rows.length,0);assert.equal(result.counts.unfilled,1);assert.equal(result.counts.unlabelled,1);assert.equal(result.counts.usable,0);assert.equal(result.counts.captures,1);assert.equal(result.unexecuted_outcomes,'UNLABELLED_NOT_LOSSES');
});
test('the opportunity denominator includes missing forecasts, no fills, pending and excluded outcomes without fabricating labels',()=>{
 const dataset=new SecondaryNeuralDataset(),mature=fixture('isolated-covered'),unfilled=fixture('isolated-unfilled'),waiting=fixture('isolated-waiting'),excluded=fixture('isolated-excluded'),pending=fixture('isolated-pending'),unknown=fixture('isolated-unknown-domain');
 for(const f of [unfilled,waiting,pending,unknown])Object.assign(f.prediction,{model_id:null,prediction:{status:'UNAVAILABLE',reason:'NO_TRAINED_MODEL',estimated_net_return:null}});
 mature.prediction.realized_pnl='MUST_NOT_LEAK_TO_OPPORTUNITY';mature.prediction.candidate_predictions=[{status:'PREDICTED',model_id:'isolated-candidate',estimated_net_return:.003,generated_at:T,authority:'NONE',role:'CANDIDATE_ADVISORY',future_outcome:'MUST_NOT_LEAK_TO_OPPORTUNITY'}];
 Object.assign(excluded.closed,{quality:'DATA_GAP',data_gaps:[{from:T+5000,to:END-1000}]});
 Object.assign(pending.closed,{quality:'FUNDING_GAP',funding_complete:false,result_final:false});
 Object.assign(unknown.snapshot,{domain:undefined,x:null,exclusion:'NO_PRE_ENTRY_POSITION_CONTEXT',data_quality:'UNAVAILABLE'});unknown.snapshot.snapshot_hash=hash({...unknown.snapshot,snapshot_hash:undefined});unknown.prediction.snapshot_hash=unknown.snapshot.snapshot_hash;
 const stream=[...mature.events,unfilled.capture,unfilled.selected,unfilled.decisionEvent,{...unfilled.selected,type:'NOT_FILLED',at:T+30000},waiting.capture,waiting.selected,waiting.decisionEvent,...excluded.events,...pending.events,unknown.capture,unknown.decisionEvent];apply(dataset,stream);
 const before=dataset.checkpoint(),result=dataset.export();assert.equal(result.opportunities_complete,true);assert.equal(result.opportunities.length,6);assert.equal(result.rows.length,3);assert.equal(result.counts.usable,1);assert.equal(result.counts.pending_labels,1);assert.equal(result.counts.excluded,1);assert.deepEqual(dataset.checkpoint(),before);
 const all=new Map(result.opportunities.map(row=>[row.operation_id,row]));assert.equal(all.get(unfilled.id).decision.prediction.status,'UNAVAILABLE');assert.equal(all.get(waiting.id).decision.base_eligible,true);assert.equal(all.get(unknown.id).domain,null);assert.equal(all.get(unknown.id).feature_schema_hash,unknown.snapshot.feature_schema_hash);
 assert.equal(all.get(mature.id).decision.candidate_predictions[0].generated_at,T);assert.equal(all.get(mature.id).decision.candidate_predictions[0].model_id,'isolated-candidate');assert.equal(all.get(mature.id).snapshot_hash,mature.snapshot.snapshot_hash);assert.equal(all.get(mature.id).movement_key,mature.snapshot.context.movement_key);
 assert(!JSON.stringify(result.opportunities).includes('MUST_NOT_LEAK_TO_OPPORTUNITY'));
 for(const opportunity of result.opportunities){for(const key of ['label','net','exposure','costs','closed_at','net_return','x'])assert(!Object.hasOwn(opportunity,key));assert.equal(opportunity.decision.at,opportunity.decision_at);}
 assert.deepEqual(new SecondaryNeuralDataset({checkpoint:JSON.parse(JSON.stringify(before))}).export().opportunities,result.opportunities);
 apply(dataset,stream);assert.equal(dataset.export().opportunities.length,6);assert.equal(dataset.export().rows.length,3);
});
test('historical missing snapshots remain explicit exclusions without altering the historical learning group',()=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset(),oldLearning={usable:0,excluded:10,exclusions:{NO_PRE_ENTRY_FEATURES:8,INCOMPLETE_MARKET_DATA:2}},before=structuredClone(oldLearning);
 apply(dataset,[f.selected,f.fill,f.closed]);const result=dataset.export();assert.equal(result.rows.length,1);assert.equal(result.rows[0].snapshot,null);assert.equal(result.rows[0].label.exclusion,'NO_PRE_ENTRY_SNAPSHOT');assert.equal(result.counts.excluded,1);assert.deepEqual(oldLearning,before);
});
test('a backdated snapshot recorded after selection is not accepted as a pre-entry photograph',()=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset();apply(dataset,[f.selected,f.capture,f.fill,f.closed]);const label=dataset.export().rows[0].label;assert.equal(label.status,'EXCLUDED');assert.equal(label.exclusion,'PRE_ENTRY_SNAPSHOT_RECORDED_TOO_LATE');assert.equal(label.net_return,null);
});
test('payload tampering, cursor conflicts and bad pages cannot partially advance a checkpoint',()=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset();apply(dataset,f.events.slice(0,2));const before=dataset.checkpoint();
 const changed=structuredClone(wrap(f.capture,1));changed.payload.snapshot.x[0]=0;assert.throws(()=>dataset.applyPage([changed],{asOf:AS_OF}),/REPLAY_CONFLICT/);assert.deepEqual(dataset.checkpoint(),before);
 assert.throws(()=>dataset.applyPage([wrap(f.fill,3),{...wrap(f.closed,4),kind:'FILLED'}],{asOf:AS_OF}),/EVENT_INVALID/);assert.deepEqual(dataset.checkpoint(),before);
 const checkpoint=dataset.checkpoint();checkpoint.cursor=999;assert.throws(()=>new SecondaryNeuralDataset({checkpoint}),/CHECKPOINT_INVALID/);
});
test('source IDs, mode, future observations, page and event limits fail visibly',()=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset();assert.throws(()=>new SecondaryNeuralDataset({mode:'REAL'}),/PAPER_ONLY/);assert.throws(()=>new SecondaryNeuralDataset({realTrading:true}),/PAPER_ONLY/);
 assert.throws(()=>dataset.applyPage([wrap({...f.capture,mode:'REAL'},1)],{asOf:AS_OF}),/PAPER_ONLY/);assert.throws(()=>dataset.applyPage([wrap(f.capture,1)],{asOf:T-1}),/CAPTURE_INVALID/);assert.equal(dataset.cursor,0);
 assert.throws(()=>dataset.applyPage(Array(NEURAL_DATASET_LIMITS.page+1).fill(wrap(f.capture,1)),{asOf:AS_OF}),/PAGE_LIMIT/);
 assert.throws(()=>dataset.applyPage([wrap({...f.capture,padding:'x'.repeat(NEURAL_DATASET_LIMITS.eventBytes)},1)],{asOf:AS_OF}),/EVENT_LIMIT/);
 apply(dataset,[f.capture]);assert.throws(()=>new SecondaryNeuralDataset({checkpoint:dataset.checkpoint(),sourceId:'OTHER'}),/CHECKPOINT_INVALID/);
});
test('private checkpoint only needs immutable observed events, and event wrappers may contain JSON payload strings',()=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset();dataset.applyPage(f.events.map((event,i)=>({...wrap(event,(i+1)*10),payload:JSON.stringify(event)})),{asOf:AS_OF});
 const checkpoint=JSON.parse(JSON.stringify(dataset.checkpoint())),resumed=new SecondaryNeuralDataset({checkpoint});assert.deepEqual(resumed.export(),dataset.export());assert.equal(resumed.cursor,50);assert.equal(checkpoint.checkpoint_hash,hash({...checkpoint,checkpoint_hash:undefined}));
 assert.equal(D(resumed.export().rows[0].label.net_return).mul(resumed.export().rows[0].label.exposure).minus('.5').abs().lt('0.000000000001'),true);
});
test('the source high-watermark acknowledges filtered gaps without inventing event rows',()=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset();apply(dataset,f.events);const before=dataset.summary();dataset.acknowledgeExport({cursorEnd:50,highWatermark:50,asOf:AS_OF,exportHash:hash('isolated-export'),complete:true});assert.equal(dataset.cursor,50);assert.deepEqual(dataset.summary(),before);assert.equal(new SecondaryNeuralDataset({checkpoint:dataset.checkpoint()}).cursor,50);
 assert.throws(()=>dataset.acknowledgeExport({cursorEnd:49,highWatermark:50,asOf:AS_OF,exportHash:hash('bad'),complete:true}),/EXPORT_CHECKPOINT_INVALID/);
 dataset.acknowledgeExport({cursorEnd:51,highWatermark:70,asOf:AS_OF,exportHash:hash('isolated-prefix'),complete:false});assert.equal(dataset.export().opportunities_complete,false);
 dataset.acknowledgeExport({cursorEnd:70,highWatermark:70,asOf:AS_OF,exportHash:hash('isolated-complete'),complete:true});assert.equal(dataset.export().opportunities_complete,true);
});
test('the external Python trainer accepts the actual JS schema, continuous label and prospective decision',t=>{
 const f=fixture(),dataset=new SecondaryNeuralDataset();apply(dataset,f.events);const exported=dataset.export();exported.rows[0].synthetic=true;
 const script=new URL('../scripts/trading-neural-train.py',import.meta.url).pathname;
 const dir=mkdtempSync(join(tmpdir(),'lumi-neural-dataset-isolated-')),path=join(dir,'synthetic.json');t.after(()=>rmSync(dir,{recursive:true,force:true}));writeFileSync(path,JSON.stringify(exported));
 const code="import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('trainer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nwith open(sys.argv[2]) as f:d=json.load(f)\nrow,skip=m.compact_row(d['rows'][0],d['as_of'],allow_synthetic=True)\nassert skip is None and row['row']['status']=='MATURE' and row['row']['full_fill'] is True\nassert row['row']['prediction']['model_id']=='isolated-model'\nprint(json.dumps({'status':row['row']['status'],'features':len(row['row']['x']),'target':row['row']['y']}))\n";
 const result=spawnSync('python3',['-c',code,script,path],{encoding:'utf8',timeout:10000,maxBuffer:100000});assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.features,33);assert.equal(receipt.status,'MATURE');assert.equal(receipt.target,Number(exported.rows[0].label.net_return));
});
