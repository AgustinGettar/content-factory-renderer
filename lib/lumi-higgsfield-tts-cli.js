import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

// Official Higgsfield client, not a guessed public API endpoint. Installation and
// a noninteractive authenticated session are deployment requirements; never log in here.
// Reference: higgsfield-ai/cli README.md and MODELS.md (text2speech_v2).
export function createHiggsfieldTtsCliClient({executable='higgsfield',run=exec}={}) {
  const call=async args=>{
    const {stdout}=await run(executable,[...args,'--json'],{timeout:60000,maxBuffer:1024*1024});
    return JSON.parse(stdout);
  };
  const jobFrom=(value,id=null)=>{
    const candidates=Array.isArray(value)?value:Array.isArray(value.results)?value.results:Array.isArray(value.jobs)?value.jobs:[value];
    const jobs=candidates.filter(x=>x&&typeof x.id==='string'&&(!id||x.id===id));
    if(jobs.length!==1)throw Error('HIGGSFIELD_CLI_JOB_ENVELOPE_UNVERIFIED');return jobs[0];
  };
  return {
    transport:'OFFICIAL_HIGGSFIELD_CLI',
    async preflight(request){
      // The same authenticated CLI/configuration as submit; cost never creates a job.
      const response=await call(['generate','cost',request.model,'--prompt',request.prompt,'--variant',request.variant,
        '--voice_type',request.voice_type,'--voice_id',request.voice_id]);
      const cost=response.cost??response;
      if(!Number.isFinite(cost.credits_exact)||cost.credits_exact<0)throw Error('HIGGSFIELD_COST_ENVELOPE_UNVERIFIED');
      return {authenticated:true,currency:'CREDITS',units:cost.credits_exact,
        provider:'Higgsfield',transport:'OFFICIAL_HIGGSFIELD_CLI',provenance:'AUTHENTICATED_GENERATE_COST',
        ...(Number.isFinite(cost.usd)?{usd:cost.usd}:{}),quoted_at:new Date().toISOString()};
    },
    async submit(request){
      const value=await call(['generate','create',request.model,'--prompt',request.prompt,'--variant',request.variant,
        '--voice_type',request.voice_type,'--voice_id',request.voice_id]);
      const job=jobFrom(value);
      return {job_id:job.id,status:job.status};
    },
    async poll(id){
      if(!/^[a-zA-Z0-9-]+$/.test(id))throw Error('HIGGSFIELD_JOB_ID_INVALID');
      const job=jobFrom(await call(['generate','get',id]),id);
      return {job_id:job.id,status:job.status,artifact_url:job.results?.rawUrl??job.result_url??null,
        // Official client credit costs are not USD. Unknown charges stay null.
        actual_cost:null};
    }
  };
}
