import {readFile, writeFile, mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha256, stableStringify} from './PROMPT_COMPILER_V3.mjs';

const root = new URL('../../docs/cinematic-director-v1/', import.meta.url);
const read = async path => JSON.parse(await readFile(new URL(path, root)));

export async function runHumanApprovedStagingReplay({env, logger=console}) {
  if (env.LUMI_RUNTIME_ENV !== 'staging' || env.PROVIDER_CALLS_ALLOWED !== '0' ||
      env.LUMI_DIRECTOR_ASSEMBLY_REPLAY !== 'HUMAN_REVIEW_20261005')
    throw new Error('DIRECTOR_STAGING_ZERO_PROVIDER_REPLAY_REQUIRED');
  const {createClient} = await import('@supabase/supabase-js');
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
  const {runLumiV2Step} = await import('../lumi-series-v2-execution.js');
  const approvals = await read('human-review-20261005/HUMAN_ASSEMBLY_APPROVALS_V1.json');
  const supersession = await read('human-review-20261005/UNUSED_REPAIR_SUPERSESSION_V1.json');
  for (const p of supersession.preserved) {
    if (sha256(await readFile(new URL(p.path,root))) !== p.sha256) throw new Error('ARCHIVED_REPAIR_ORIGINAL_CHANGED');
  }
  const directory = await mkdtemp(join(tmpdir(),'lumi-director-assembly-'));
  const results = [];
  try {
    const bindings = Object.fromEntries(await Promise.all(['q31','q32','q33'].map(async q=>[q,await read('bindings/'+q+'_ORIGINAL_MEDIA_BINDING_V1.json')])));
    for (const q of ['q31','q32','q33']) {
      const binding=bindings[q], mediaRoot=join(directory,q);
      await mkdir(mediaRoot,{recursive:true});
      for (const artifact of [binding.source,binding.video,bindings.q31.video]) {
        const r=await db.storage.from(artifact.bucket).download(artifact.object_path);
        if(r.error)throw new Error('DIRECTOR_REPLAY_ORIGINAL_DOWNLOAD_FAILED:'+q);
        const bytes=Buffer.from(await r.data.arrayBuffer());
        if(sha256(bytes)!==artifact.sha256)throw new Error('DIRECTOR_REPLAY_ORIGINAL_SHA_MISMATCH:'+q);
        await writeFile(join(mediaRoot,artifact.local_filename),bytes);
      }
      const input=await read('closure-v2/replay/'+q+'_AUTHENTIC_DIRECTOR_INPUT_V1.json');
      input.media=input.media.map(m=>({...m,path:join(mediaRoot,m.role==='source'?binding.source.local_filename:bindings.q31.video.local_filename)}));
      const packet=await runLumiV2Step({env:{...env,LUMI_PIPELINE_VERSION:'v1_1_2'},directorReview:{input,
        outputDirectory:join(directory,'decisions'),historicalReplay:{binding,observations:await read('closure-v3/'+q+'_BOUND_QA_OBSERVATIONS_R2.json'),mediaRoot},
        humanAssemblyApproval:approvals.records.find(r=>r.shot===q)}});
      const replay=packet.historical_replay;
      if(!replay.assembly_eligible || !replay.repair_execution_forbidden || replay.minimum_future_repair!==null ||
          packet.gates.EXECUTION_AUTHORIZATION || packet.PROVIDER_REQUEST_PREVIEW.payload!==null)throw new Error('DIRECTOR_REPLAY_PROVIDER_BOUNDARY_VIOLATION');
      const ledger=await db.from('lumi_pilot_runs').select('id,content_hash,result').eq('id',binding.ledger.video_row_id).single();
      if(ledger.error||ledger.data.content_hash!==binding.video.sha256)throw new Error('DIRECTOR_REPLAY_LEDGER_BINDING_MISMATCH');
      const existing=ledger.data.result;
      const updated={...existing,human_review_layers:{...(existing.human_review_layers||{}),HUMAN_REVIEW_20261005:replay.human_review_layer},
        assembly_eligible:true,golden_reference:replay.golden_reference,golden_scope:replay.golden_scope,golden_anatomy_reference:false};
      const u=await db.from('lumi_pilot_runs').update({result:updated}).eq('id',binding.ledger.video_row_id).eq('content_hash',binding.video.sha256).select('result').single();
      if(u.error||stableStringify(u.data.result.visual_qa)!==stableStringify(existing.visual_qa)||
          stableStringify(u.data.result.temporal_qa)!==stableStringify(existing.temporal_qa)||
          u.data.result.human_review_layers?.HUMAN_REVIEW_20261005?.record_sha256!==replay.human_review_layer.record_sha256)
        throw new Error('DIRECTOR_HUMAN_LAYER_WRITE_VERIFICATION_FAILED');
      results.push({shot:q,artifact_sha256:binding.video.sha256,outcome:replay.repair_outcome,
        HUMAN_REVIEW_PROVENANCE:'PASS',AUTOMATED_FINDINGS_PRESERVED:true,assembly_eligible:true,
        golden_reference:replay.golden_reference,golden_scope:replay.golden_scope,provider_calls:0,
        historical_replay:replay});
    }
    const report={version:'CANONICAL_STAGING_ASSEMBLY_REPLAY_V1',status:'PASS',
      entrypoint:'runLumiV2Step → reviewAtCanonicalBoundary',code_sha:env.RENDER_GIT_COMMIT||null,
      results,CANONICAL_STAGING_REPLAY:'PASS',HUMAN_REVIEW_PROVENANCE:'PASS',
      unused_repair_plans:supersession,provider_calls:0,repair_calls:0,autorun:false,runners:'OFF'};
    const storage=db.storage.from('av2-generative-video-benchmarks');
    const path='lumi-series-v2/ep_lumi_flores_003/director-human-assembly-20261005/replay.json';
    const bytes=Buffer.from(JSON.stringify(report));
    const u=await storage.upload(path,bytes,{contentType:'application/json',upsert:true});
    if(u.error)throw new Error('DIRECTOR_REPLAY_PERSIST_FAILED');
    const downloaded=await storage.download(path);
    if(downloaded.error||sha256(Buffer.from(await downloaded.data.arrayBuffer()))!==sha256(bytes))throw new Error('DIRECTOR_REPLAY_PERSIST_HASH_FAILED');
    logger.info(JSON.stringify({event:'lumi_director_human_assembly_replay',...report}));
    return report;
  } finally {await rm(directory,{recursive:true,force:true});}
}
