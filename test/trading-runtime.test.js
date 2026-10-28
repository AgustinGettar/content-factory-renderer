import test from 'node:test';
import assert from 'node:assert/strict';
import {assertTradingRuntime} from '../lib/trading/runtime-guard.js';

const common={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',SUPABASE_URL:'https://mofjhwathxzfnjapvvst.supabase.co'};
const render={...common,RENDER_GIT_BRANCH:'lumi-telegram-review-v1',RENDER_SERVICE_ID:'srv-dedicated-paper',LUMI_TRADING_RENDER_SERVICE_ID:'srv-dedicated-paper'};
const gce={...common,LUMI_TRADING_PLATFORM:'GCE',LUMI_TRADING_SOURCE_BRANCH:'lumi-trading-gcp',LUMI_TRADING_GCP_PROJECT_ID:'lumi-paper-test',LUMI_TRADING_GCP_INSTANCE_ID:'1234567890123456789',LUMI_TRADING_GCP_ZONE:'us-central1-a'};
const identity={'project/project-id':gce.LUMI_TRADING_GCP_PROJECT_ID,'instance/id':gce.LUMI_TRADING_GCP_INSTANCE_ID,'instance/zone':'projects/123456/zones/us-central1-a'};
function metadata(overrides={},responseOptions={}){
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});
    const path=url.replace('http://metadata.google.internal/computeMetadata/v1/','');
    assert.ok(Object.hasOwn(identity,path));
    return new Response({...identity,...overrides}[path],{status:200,headers:{'Metadata-Flavor':'Google'},...responseOptions});
  };
  return {calls,fetchImpl};
}
const noNetwork=async()=>{assert.fail('configuration rejection must precede network access');};

test('existing dedicated Render configuration remains valid without metadata requests',async()=>{
  assert.deepEqual(await assertTradingRuntime(render,{fetchImpl:noNetwork}),{platform:'RENDER'});
});
for(const [name,change] of Object.entries({
  production:{LUMI_RUNTIME_ENV:'production'},real:{LUMI_TRADING_MODE:'LIVE'},
  database:{SUPABASE_URL:'https://other.supabase.co'},branch:{RENDER_GIT_BRANCH:'main'},
  missingId:{LUMI_TRADING_RENDER_SERVICE_ID:''},wrongId:{RENDER_SERVICE_ID:'srv-other'},
  audiovisual:{RENDER_SERVICE_ID:'srv-dapgakqd0e5s73fottig',LUMI_TRADING_RENDER_SERVICE_ID:'srv-dapgakqd0e5s73fottig'}
}))test(`Render rejects ${name}`,async()=>{
  await assert.rejects(assertTradingRuntime({...render,...change},{fetchImpl:noNetwork}),/TRADING_DEDICATED_STAGING_WORKER_REQUIRED/);
});

test('GCE verifies project, full numeric instance identity and zone without requesting credentials',async()=>{
  const m=metadata();assert.deepEqual(await assertTradingRuntime(gce,m),{platform:'GCE'});
  assert.equal(m.calls.length,3);
  for(const {options} of m.calls){assert.deepEqual(options.headers,{'Metadata-Flavor':'Google'});assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);}
});
for(const [path,value] of Object.entries({'project/project-id':'another-project','instance/id':'1234567890123456788','instance/zone':'projects/123456/zones/us-east1-b'}))
  test(`GCE rejects another ${path}`,async()=>{
    await assert.rejects(assertTradingRuntime(gce,metadata({[path]:value})),/TRADING_GCE_IDENTITY_MISMATCH/);
  });
for(const [name,change] of Object.entries({
  noProject:{LUMI_TRADING_GCP_PROJECT_ID:''},noInstance:{LUMI_TRADING_GCP_INSTANCE_ID:''},
  invalidInstance:{LUMI_TRADING_GCP_INSTANCE_ID:'not-a-numeric-id'},noZone:{LUMI_TRADING_GCP_ZONE:''},
  unsafeZone:{LUMI_TRADING_GCP_ZONE:'us-central1-.'},main:{LUMI_TRADING_SOURCE_BRANCH:'main'},
  noSource:{LUMI_TRADING_SOURCE_BRANCH:undefined}
}))test(`GCE rejects ${name} before any network access`,async()=>{
  await assert.rejects(assertTradingRuntime({...gce,...change},{fetchImpl:noNetwork}),/TRADING_GCE_CONFIGURATION_REQUIRED/);
});
test('GCE also accepts the existing staging source branch after review',async()=>{
  assert.equal((await assertTradingRuntime({...gce,LUMI_TRADING_SOURCE_BRANCH:'lumi-telegram-review-v1'},metadata())).platform,'GCE');
});
for(const [name,change] of Object.entries({production:{LUMI_RUNTIME_ENV:'production'},real:{LUMI_TRADING_MODE:'LIVE'},database:{SUPABASE_URL:'https://other.supabase.co'}}))
  test(`GCE retains ${name} isolation`,async()=>{
    await assert.rejects(assertTradingRuntime({...gce,...change},{fetchImpl:noNetwork}),/TRADING_DEDICATED_STAGING_WORKER_REQUIRED/);
  });
for(const key of ['RENDER_SERVICE_ID','RENDER_GIT_BRANCH','LUMI_TRADING_RENDER_SERVICE_ID'])
  test(`GCE rejects copied ${key}`,async()=>{
    await assert.rejects(assertTradingRuntime({...gce,[key]:'copied'},{fetchImpl:noNetwork}),/TRADING_MIXED_HOST_IDENTITY/);
  });
test('exchange credentials are forbidden on both hosts, including empty variables',async()=>{
  for(const env of [render,gce])for(const key of ['KRAKEN_API_KEY','KRAKEN_SECRET','KRAKEN_PRIVATE_KEY'])
    await assert.rejects(assertTradingRuntime({...env,[key]:''},{fetchImpl:noNetwork}),/TRADING_PUBLIC_MARKET_ONLY/);
});
test('unknown or blank platform cannot silently fall back to Render',async()=>{
  for(const platform of ['','LOCAL','gce'])await assert.rejects(assertTradingRuntime({...render,LUMI_TRADING_PLATFORM:platform},{fetchImpl:noNetwork}),/TRADING_UNSUPPORTED_PLATFORM/);
});
test('failed metadata requests fail closed with no raw network error or response disclosure',async()=>{
  const scenarios=[
    {fetchImpl:async()=>{throw Error('sensitive internal diagnostic');}},
    metadata({}, {status:403}),metadata({}, {headers:{}}),metadata({}, {headers:{'Metadata-Flavor':'other'}}),
    metadata({'instance/id':' '+gce.LUMI_TRADING_GCP_INSTANCE_ID}),metadata({'instance/id':''}),metadata({'instance/id':'x'.repeat(257)})
  ];
  for(const scenario of scenarios)await assert.rejects(assertTradingRuntime(gce,scenario),{message:'TRADING_GCE_METADATA_UNAVAILABLE'});
});
