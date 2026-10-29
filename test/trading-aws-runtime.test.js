import test from 'node:test';
import assert from 'node:assert/strict';
import {assertTradingRuntime} from '../lib/trading/runtime-guard.js';
const env={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',SUPABASE_URL:'https://mofjhwathxzfnjapvvst.supabase.co',LUMI_TRADING_PLATFORM:'EC2',LUMI_TRADING_SOURCE_BRANCH:'lumi-trading-aws',LUMI_TRADING_AWS_ACCOUNT_ID:'123456789012',LUMI_TRADING_AWS_INSTANCE_ID:'i-1234567890abcdef0',LUMI_TRADING_AWS_REGION:'eu-north-1'};
const identity={accountId:env.LUMI_TRADING_AWS_ACCOUNT_ID,instanceId:env.LUMI_TRADING_AWS_INSTANCE_ID,region:env.LUMI_TRADING_AWS_REGION};
function metadata(doc=identity,token='offline-imds-token'){
  const calls=[];
  return {calls,fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url==='http://169.254.169.254/latest/api/token')return new Response(token);
    assert.equal(url,'http://169.254.169.254/latest/dynamic/instance-identity/document');
    assert.equal(options.headers['X-aws-ec2-metadata-token'],token);
    return new Response(typeof doc==='string'?doc:JSON.stringify(doc));
  }};
}
const noNetwork=async()=>{assert.fail('invalid configuration must not access metadata');};
test('EC2 requires IMDSv2 then pins account, instance and region without IAM credential requests',async()=>{
  const m=metadata();assert.deepEqual(await assertTradingRuntime(env,m),{platform:'EC2'});
  assert.equal(m.calls.length,2);assert.equal(m.calls[0].options.method,'PUT');
  assert.equal(m.calls[0].options.headers['X-aws-ec2-metadata-token-ttl-seconds'],'60');
  for(const call of m.calls){assert.equal(call.options.redirect,'error');assert.ok(call.options.signal instanceof AbortSignal);}
});
for(const field of ['accountId','instanceId','region'])test(`EC2 rejects a different ${field}`,async()=>{
  await assert.rejects(assertTradingRuntime(env,metadata({...identity,[field]:'other'})),/TRADING_EC2_IDENTITY_MISMATCH/);
});
for(const key of ['LUMI_TRADING_AWS_ACCOUNT_ID','LUMI_TRADING_AWS_INSTANCE_ID','LUMI_TRADING_AWS_REGION','LUMI_TRADING_SOURCE_BRANCH'])test(`EC2 rejects missing ${key} before network`,async()=>{
  await assert.rejects(assertTradingRuntime({...env,[key]:''},{fetchImpl:noNetwork}),/TRADING_EC2_CONFIGURATION_REQUIRED/);
});
test('EC2 cannot bypass existing isolation or inject exchange credentials',async()=>{
  for(const patch of [{LUMI_RUNTIME_ENV:'production'},{LUMI_TRADING_MODE:'REAL'},{SUPABASE_URL:'https://other.supabase.co'},{RENDER_SERVICE_ID:'copied'},{KRAKEN_API_KEY:'test'}])
    await assert.rejects(assertTradingRuntime({...env,...patch},{fetchImpl:noNetwork}),/TRADING_(DEDICATED_STAGING_WORKER_REQUIRED|MIXED_HOST_IDENTITY|PUBLIC_MARKET_ONLY)/);
});
test('EC2 metadata errors are sanitized and never fall back to IMDSv1',async()=>{
  for(const m of [metadata('{invalid'),metadata(identity,''),metadata(identity,'bad\ntoken'),metadata('x'.repeat(16385)),{fetchImpl:async()=>new Response('private error',{status:403})},{fetchImpl:async()=>{throw Error('network token secret');}}])
    await assert.rejects(assertTradingRuntime(env,m),{message:'TRADING_EC2_METADATA_UNAVAILABLE'});
  await assert.rejects(assertTradingRuntime(env,metadata(null)),/TRADING_EC2_IDENTITY_MISMATCH/);
});
