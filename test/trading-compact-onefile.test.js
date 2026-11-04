import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync('deploy/trading/compact-panel/simple-onefile.html','utf8');
test('self-contained site module has valid executable JavaScript',()=>{
 const text=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
 assert.ok(text&&text.length>8000);
 assert.doesNotThrow(()=>new vm.Script(text));
});
test('no cross-domain secrets or accidental writes; full view is preserved',()=>{
 assert.match(html,/const API='\/api\/monitor\/live'/);
 assert.match(html,/credentials:'same-origin'/);
 assert.match(html,/href="\/"[^>]+id="full-view"/);
 assert.doesNotMatch(html,/method:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/);
 assert.doesNotMatch(html,/bot\d+:[A-Za-z0-9_-]{30,}/);
 assert.doesNotMatch(html,/<script[^>]*src=|<link[^>]*stylesheet[^>]*href=/);
});
test('PAPER projection gate, separate realized/open and compact cards remain present',()=>{
 assert.match(html,/SECONDARY_PAPER_SNAPSHOT_REQUIRED/);
 assert.match(html,/FREQUENT_PAPER/);
 assert.match(html,/Resultado registrado de cierres/);
 assert.match(html,/Resultado abierto estimado/);
 assert.match(html,/Scalping experimental/);
 for(const tf of ["5:'5m'","15:'15m'","60:'1h'","240:'4h'"])assert.ok(html.includes(tf));
});


test('standalone Sites panel renders all three tabs after successful PAPER fetch', async()=>{
 const script=html.match(/<script type="module">([\\s\\S]*?)<\\/script>/)?.[1];
 const now=Date.now();
 const data={revision:42,feed:{sampled_at:now},
  secondary_finances:{mode:'PAPER',ledger:'FREQUENT_PAPER',equity:'1011',cash:'900',realized_net:'11',
   unrealized_net:'0',realized_result_final:true,valuation_quality:'CURRENT_ESTIMATE',
   total_net:'11',net_result_final:true,costs_recorded:'1'},
  secondary_activity:{snapshot_at:now,process:{status:'RECENT_COMMIT_AND_LEASE'},
   market:{usable:true,issue:null},orders:{open_positions:0,pending:0},
   frames:Object.fromEntries([5,15,60,240].map(n=>[n,{last_completed_at:now-n*60000,
    stale:false,market_regime:{regime:'RANGE'},reason:'WAIT_PULLBACK',reason_text:'Esperando retroceso'}]))},
  frequency:{account:{positions:[],pending_orders:[],equity:'1011'}},operations:[]};
 const root={innerHTML:'',querySelectorAll:()=>[]};
 const status={className:'',textContent:''};
 const buttons=['resumen','operaciones','actividad'].map(view=>({
  dataset:{view},classList:{toggle(){}},setAttribute(){}}));
 let clicked;
 const nav={addEventListener(type,handler){if(type==='click')clicked=handler;},
  querySelectorAll:()=>buttons};
 const document={hidden:false,
  querySelector:query=>({'#content':root,'#status':status,'#nav':nav})[query],
  addEventListener(){}};
 const context={document,window:{addEventListener(){}},setInterval(){},
  fetch:async(url,opts)=>{
   assert.equal(url,'/api/monitor/live');assert.equal(opts.credentials,'same-origin');
   return {ok:true,status:200,json:async()=>data};
  },AbortSignal,console};
 vm.runInNewContext(script,context);
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(root.innerHTML,/Patrimonio ficticio/);
 assert.match(status.textContent,/Motor y mercado actualizados/);
 const click=view=>clicked({target:{closest:()=>buttons.find(b=>b.dataset.view===view)}});
 click('operaciones');
 assert.match(root.innerHTML,/Órdenes pendientes/);
 click('actividad');
 assert.match(root.innerHTML,/Actividad reciente/);
 click('resumen');
 assert.match(root.innerHTML,/Posiciones ahora/);
});
