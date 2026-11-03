import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// Exercise the real worker entrypoint and its real runtime/profile guards. Only
// the SQLite constructor is intercepted: no database can be opened or modified,
// no market feed can start, and all network requests are replaced by fixtures.
const workerUrl=new URL('../scripts/trading-worker.mjs',import.meta.url).href;
const storeUrl=new URL('../lib/trading/sqlite-store.js',import.meta.url).href;
const baseEnv={
 LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',
 LUMI_TRADING_PLATFORM:'EC2',LUMI_TRADING_STORAGE:'SQLITE',
 LUMI_TRADING_DB_PATH:'/var/lib/lumi-trading/trading.sqlite',
 LUMI_TRADING_AWS_ACCOUNT_ID:'000000000000',
 LUMI_TRADING_AWS_INSTANCE_ID:'i-00000000000000000',
 LUMI_TRADING_AWS_REGION:'eu-north-1',
 LUMI_TRADING_SOURCE_BRANCH:'lumi-trading-aws',
 LUMI_TRADING_SECONDARY_PROFILE:'secondary-paper-exploration-1.0.0',
 LUMI_TRADING_SECONDARY_EXECUTION:'secondary-futures-1.0.0',
};

function start(overrides={}, {identityMismatch=false}={}){
 const source=`
 import {registerHooks} from 'node:module';
 let metadataCalls=0;
 registerHooks({load(url,context,nextLoad){
  if(url===${JSON.stringify(storeUrl)})return {
   format:'module',shortCircuit:true,
   source:'export class SQLiteStore { constructor(path) { globalThis.__testStorePath=path; throw new Error("TEST_WORKER_STORE_BOUNDARY"); } }'
  };
  return nextLoad(url,context);
 }});
 globalThis.fetch=async (url,options={})=>{
  metadataCalls++;
  if(url==='http://169.254.169.254/latest/api/token'&&options.method==='PUT')return new Response('synthetic-token');
  if(url==='http://169.254.169.254/latest/dynamic/instance-identity/document'&&options.headers?.['X-aws-ec2-metadata-token']==='synthetic-token')return new Response(JSON.stringify({accountId:'000000000000',instanceId:${JSON.stringify(identityMismatch?'i-11111111111111111':baseEnv.LUMI_TRADING_AWS_INSTANCE_ID)},region:'eu-north-1'}));
  throw new Error('TEST_UNEXPECTED_NETWORK_REQUEST');
 };
 try { await import(${JSON.stringify(workerUrl)}); throw new Error('TEST_WORKER_PASSED_STORE_BOUNDARY'); }
 catch(error){
  if(error.message==='TEST_WORKER_STORE_BOUNDARY')process.stdout.write(JSON.stringify({boundary:'PRE_STORE',path:globalThis.__testStorePath,metadata_calls:metadataCalls}));
  else { process.stderr.write(error.message); process.exitCode=1; }
 }
 `;
 const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{
  env:{...baseEnv,...overrides},encoding:'utf8',timeout:15000,maxBuffer:100000,
 });
 assert.equal(result.signal,null,result.error?.message??result.stderr);
 return result;
}

for(const policy of [undefined,'secondary-profit-policy-1.0.0','secondary-profit-policy-2.0.0','OFF']){
 test(`worker bootstrap accepts profit policy ${policy??'unset'} before opening the store`,()=>{
  const result=start(policy?{LUMI_TRADING_SECONDARY_PROFIT_POLICY:policy}:{});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{boundary:'PRE_STORE',path:baseEnv.LUMI_TRADING_DB_PATH,metadata_calls:2});
 });
}

test('worker bootstrap rejects an unknown profit policy before the store',()=>{
 const result=start({LUMI_TRADING_SECONDARY_PROFIT_POLICY:'secondary-profit-policy-999.0.0'});
 assert.equal(result.status,1);assert.equal(result.stdout,'');
 assert.match(result.stderr,/SECONDARY_PROFIT_POLICY_UNKNOWN/);
});

test('worker bootstrap still requires PAPER before any metadata/store access',()=>{
 const result=start({LUMI_TRADING_MODE:'LIVE',LUMI_TRADING_SECONDARY_PROFIT_POLICY:'secondary-profit-policy-2.0.0'});
 assert.equal(result.status,1);assert.equal(result.stdout,'');
 assert.match(result.stderr,/TRADING_DEDICATED_STAGING_WORKER_REQUIRED/);
});

test('worker bootstrap still verifies EC2 identity with v2',()=>{
 const result=start({LUMI_TRADING_SECONDARY_PROFIT_POLICY:'secondary-profit-policy-2.0.0'},{identityMismatch:true});
 assert.equal(result.status,1);assert.equal(result.stdout,'');
 assert.match(result.stderr,/TRADING_EC2_IDENTITY_MISMATCH/);
});

test('worker bootstrap still refuses a trading-key environment with v2',()=>{
 const result=start({LUMI_TRADING_SECONDARY_PROFIT_POLICY:'secondary-profit-policy-2.0.0',KRAKEN_API_KEY:'synthetic-test-only'});
 assert.equal(result.status,1);assert.equal(result.stdout,'');
 assert.match(result.stderr,/TRADING_PUBLIC_MARKET_ONLY/);
});
