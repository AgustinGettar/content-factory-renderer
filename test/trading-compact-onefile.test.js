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
