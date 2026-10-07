// Process-restart harness only. No network credentials, real provider or live DB.
// Each child is launched with director-offline-guard before this module loads.
import {readFileSync,writeFileSync,renameSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {DurableDryRun} from '../../lib/lumi-durable-dry-run.js';
import {MemoryLumiRecoveryStore} from '../../lib/lumi-recovery-incident-manager-v1.js';
import {MemoryReviewStore,newSession} from '../../lib/telegram-review-v1/core.js';
import {HOME_ASSET} from '../../lib/telegram-review-v1/home-asset.js';
const [directory,mode,time]=process.argv.slice(2),file=join(directory,'checkpoint.json');
mkdirSync(directory,{recursive:true});
class DiskCheckpointFixture extends MemoryLumiRecoveryStore {
  load(){this.episodes=new Map(existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[]);}
  save(){writeFileSync(file+'.tmp',JSON.stringify([...this.episodes]));renameSync(file+'.tmp',file);}
  async getEpisode(id){this.load();return super.getEpisode(id);}
  async putEpisode(value){const r=await super.putEpisode(value);this.save();return r;}
  async createDiagnostic(value){this.load();return super.createDiagnostic(value);}
  async casDiagnostic(value,revision){this.load();return super.casDiagnostic(value,revision);}
  async pendingDiagnostics(){this.load();return super.pendingDiagnostics();}
}
const store=new DiskCheckpointFixture(),reviewStore=new MemoryReviewStore();
await reviewStore.create('1',newSession({user_id:'1',chat_id:'1',message_id:138,cover:HOME_ASSET}));
const env={LUMI_RUNTIME_ENV:'staging',LUMI_TELEGRAM_TRANSPORT_AUTHORITY:'MAKE',LUMI_TELEGRAM_REVIEW_TEST_USERS:'1',RENDER_GIT_COMMIT:'a'.repeat(40)};
const pause=async()=>{process.stdout.write('KILL_NOW\n');await new Promise(()=>{});};
const diagnostics=new DurableDryRun({store,reviewStore,env,clock:()=>Number(time),validateOwner:async()=>true,logger:{info(){},warn(){}},
  inject:async point=>{
    if(mode==='kill-before-execution'&&point==='CLAIMED'||mode==='kill-after-result'&&point==='RESULT_PERSISTED')await pause();
  },
  runStage:async stage=>{
    if(stage==='GENERIC_DRY_RUN'&&mode==='kill-during-execution')await pause();
    const result={
      TTS_PREFLIGHT:{ELEVENLABS_AUTH:'PASS',MODEL_VALIDATION:'PASS',FERNANDA_CALLABLE:'PASS',TTS_QUOTA:'PASS',TTS_BUDGET_GATE:'PASS',TTS_STORAGE_GATE:'PASS',TTS_DRY_BOUNDARY:'PASS'},
      GENERIC_DRY_RUN:{status:'PASS',bound:14,total:14,continuation:'PASS',recovery:'PASS',rollback:'PASS'},
      RUNTIME:{status:'PASS',TELEGRAM_SINGLE_PANEL:'PASS',legacy_preserved:true}
    };
    const trace=join(directory,'trace.json'),calls=existsSync(trace)?JSON.parse(readFileSync(trace,'utf8')):[];
    calls.push(stage);writeFileSync(trace,JSON.stringify(calls));return result[stage];
  }});
if(mode==='prepare'){
  const body={op:'START_DRY_RUN',idempotency_key:'dry-process-test',message_id:138,verify_tts_preflight:true,dry_run:true,provider_generation:false,publication:false,crash_matrix:true};
  process.stdout.write(JSON.stringify(await diagnostics.start({user:'1',chat:'1',body,nonce:'fresh-transport'}))+'\n');
}else{
  await diagnostics.tick();store.load();
  process.stdout.write(JSON.stringify([...store.episodes.values()][0].metadata.dry_run_operation)+'\n');
}
