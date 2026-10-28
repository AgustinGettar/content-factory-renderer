// Deployment identity checks only. Never infer a live-money mode from a host.
const STAGING_URL='https://mofjhwathxzfnjapvvst.supabase.co';
const AUDIOVISUAL_SERVICE='srv-dapgakqd0e5s73fottig';
const METADATA='http://metadata.google.internal/computeMetadata/v1/';
const SOURCE_BRANCHES=new Set(['lumi-telegram-review-v1','lumi-trading-gcp']);

export async function assertTradingRuntime(env,{fetchImpl=globalThis.fetch}={}){
  if(env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_MODE!=='PAPER'||env.SUPABASE_URL!==STAGING_URL)
    throw Error('TRADING_DEDICATED_STAGING_WORKER_REQUIRED');
  if(Object.keys(env).some(k=>/KRAKEN.*(SECRET|PRIVATE|API_KEY)/.test(k)))
    throw Error('TRADING_PUBLIC_MARKET_ONLY');

  // Absence preserves the previously supported Render deployment configuration.
  const platform=env.LUMI_TRADING_PLATFORM??'RENDER';
  if(platform==='RENDER'){
    if(env.RENDER_GIT_BRANCH!=='lumi-telegram-review-v1'||!env.LUMI_TRADING_RENDER_SERVICE_ID||
      env.RENDER_SERVICE_ID!==env.LUMI_TRADING_RENDER_SERVICE_ID||env.RENDER_SERVICE_ID===AUDIOVISUAL_SERVICE)
      throw Error('TRADING_DEDICATED_STAGING_WORKER_REQUIRED');
    return {platform};
  }
  if(platform!=='GCE')throw Error('TRADING_UNSUPPORTED_PLATFORM');

  // An explicit GCE configuration does not impersonate Render or disable the
  // private staging/PAPER checks. Reject a copied Render service environment.
  if(env.RENDER_SERVICE_ID||env.RENDER_GIT_BRANCH||env.LUMI_TRADING_RENDER_SERVICE_ID)
    throw Error('TRADING_MIXED_HOST_IDENTITY');
  const project=env.LUMI_TRADING_GCP_PROJECT_ID;
  const instance=env.LUMI_TRADING_GCP_INSTANCE_ID;
  const zone=env.LUMI_TRADING_GCP_ZONE;
  if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project??'')||
    !/^[1-9][0-9]{0,19}$/.test(instance??'')||
    !/^[a-z]+-[a-z]+[0-9]+-[a-z]$/.test(zone??'')||
    !SOURCE_BRANCHES.has(env.LUMI_TRADING_SOURCE_BRANCH))
    throw Error('TRADING_GCE_CONFIGURATION_REQUIRED');

  async function readMetadata(path){
    try{
      const response=await fetchImpl(METADATA+path,{
        headers:{'Metadata-Flavor':'Google'},redirect:'error',signal:AbortSignal.timeout(2000)
      });
      if(!response.ok||response.headers.get('Metadata-Flavor')!=='Google')throw Error();
      const value=await response.text();
      if(!value||value.length>256||value!==value.trim())throw Error();
      return value;
    }catch{throw Error('TRADING_GCE_METADATA_UNAVAILABLE');}
  }
  // Only public VM identity metadata; never request a service-account token.
  const [actualProject,actualInstance,actualZone]=await Promise.all([
    readMetadata('project/project-id'),readMetadata('instance/id'),readMetadata('instance/zone')
  ]);
  if(actualProject!==project||actualInstance!==instance||
    !new RegExp('^projects/[0-9]+/zones/'+zone+'$').test(actualZone))
    throw Error('TRADING_GCE_IDENTITY_MISMATCH');
  return {platform};
}
