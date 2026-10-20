import {recoveryDigest} from './lumi-supervised-replacement.js';

export const INCIDENT_FIELDS=Object.freeze(['INCIDENT_ID','EPISODE_ID','AFFECTED_ACTION','SYMPTOM','ROOT_CAUSE','EVIDENCE','CONFIDENCE','USER_IMPACT','FINANCIAL_RISK','FIX_STATUS','FIX_COMMIT','TEST_EVIDENCE','REGRESSION_GUARD','REUSABILITY','NEXT_ACTION']);
export const BLOCKER_CATEGORIES=Object.freeze(['PROVIDER_EVIDENCE','BUDGET','GENERATION','HUMAN_REVIEW','TTS','ASSEMBLY','DELIVERY','MINI_APP_UX','INFRASTRUCTURE']);
const check=(ok,message)=>{if(!ok)throw Error(message);};
export function validateImprovementState(state,incidents){
  check(state?.version===1&&state.episode_id&&state.observed_at&&state.source_commit,'IMPROVEMENT_STATE_REQUIRED');
  check(state.authorizations?.provider_generation===false&&state.authorizations?.new_reservations===false
    &&state.authorizations?.automatic_prompt_execution===false,'IMPROVEMENT_PREPARATION_SCOPE_REQUIRED');
  check(Number.isFinite(state.budget?.ceiling_usd)&&state.budget.ceiling_usd>0
    &&Number.isFinite(state.budget.exposure_usd)&&state.budget.exposure_usd>=0,'IMPROVEMENT_BUDGET_REQUIRED');
  check(Number.isInteger(state.progress?.completed)&&Number.isInteger(state.progress?.total)&&state.progress.completed<=state.progress.total,'IMPROVEMENT_PROGRESS_REQUIRED');
  check(Array.isArray(incidents)&&new Set(incidents.map(i=>i.INCIDENT_ID)).size===incidents.length,'INCIDENT_IDS_INVALID');
  for(const i of incidents){
    check(INCIDENT_FIELDS.every(k=>Object.hasOwn(i,k)),'INCIDENT_FIELDS_MISSING');
    check(['CONFIRMED','PROBABLE','UNKNOWN'].includes(i.CONFIDENCE)&&Array.isArray(i.EVIDENCE)&&i.EVIDENCE.length,'INCIDENT_EVIDENCE_REQUIRED');
    check(i.CONFIDENCE!=='UNKNOWN'||i.ROOT_CAUSE===null,'UNKNOWN_CAUSE_MUST_BE_NULL');
    check(Array.isArray(i.TEST_EVIDENCE)&&i.REGRESSION_GUARD&&i.NEXT_ACTION,'INCIDENT_GUARD_REQUIRED');
  }
  check(BLOCKER_CATEGORIES.every(c=>state.blockers.some(b=>b.category===c)),'BLOCKER_CATEGORY_MISSING');
  for(const b of state.blockers){
    check(BLOCKER_CATEGORIES.includes(b.category)&&Array.isArray(b.dependencies)&&b.evidence
      &&Number.isInteger(b.priority)&&b.resolution_cost&&b.time_estimate,'BLOCKER_PRIORITIZATION_REQUIRED');
  }
  check(state.first_safe_action&&Array.isArray(state.acceptance)&&state.acceptance.length,'NEXT_SAFE_ACTION_REQUIRED');
  return true;
}

// Closed template: no LLM, network, shell, permission changes or auto-execution.
// Inputs and outputs are versioned together; no runtime timestamps/randomness.
export function generateImprovementArtifacts(state,incidents){
  validateImprovementState(state,incidents);
  const open=incidents.filter(i=>i.FIX_STATUS!=='RESOLVED');
  const blockers=[...state.blockers].sort((a,b)=>a.priority-b.priority||a.category.localeCompare(b.category));
  const digest=recoveryDigest({state,incidents});
  const budget=state.budget,original=state.original;
  const prompt=[
    state.continuation?.title||'LUMI APP — Q42 SUPERVISED REPLACEMENT ACTIVATION READINESS',
    'BORRADOR. No autoriza nuevos gastos ni se ejecuta automáticamente.',
    'MODELO: ASTRA — RAZONAMIENTO MUY ALTO.',
    state.continuation?.mission||'MISIÓN ÚNICA: cerrar la integración pendiente para poder resolver image:q42 mediante recuperación original o un único reemplazo supervisado, manteniendo el camino al master EP004.',
    `Repositorio: ${state.repository}; rama exclusiva: ${state.branch}; staging: ${state.staging_service}; Supabase: ${state.supabase_project}.`,
    `Leé primero docs/LUMI_RESUME_STATE.md, docs/LUMI_PROMPT_FEEDBACK.md y docs/lumi-improvement/incidents.json. Estado observado: ${state.observed_at}; base: ${state.source_commit}.`,
    'Verificá HEAD remoto, CI y SHA live actuales; conservá cambios concurrentes. No repitas la investigación histórica.',
    ...(state.transport?[`TRANSPORTE: ${state.transport.status}. ${state.transport.summary}`,`TRABAJO RECUPERADO: ${state.transport.recovered_work}`]:[]),
    `Episodio: ${state.episode_id}; ${state.status}; ${state.progress.completed}/${state.progress.total}; último ${state.last_completed_action}; pendiente ${state.first_pending_action}.`,
    `Operación original: ${original.operation_id}; intento journal: ${original.attempt_id}; ${original.status}/${original.response}; reserva USD ${original.reserved_usd}.`,
    `Propuesta: ${state.proposal_id||'consultar registro durable'}; estado REPLACEMENT_PROPOSAL; aceptación de riesgo ${state.consent?.status||'NOT_GRANTED'}. ${state.consent?.explanation||''}`,
    `Techo USD ${budget.ceiling_usd}; exposición interna USD ${budget.exposure_usd}; disponible USD ${Number((budget.ceiling_usd-budget.exposure_usd).toFixed(6))}; máximo nuevo propuesto USD ${budget.proposed_new_reservation_usd}. No son cargos reales ni garantía del proveedor.`,
    ...(state.cost_recovery?[`Último rechazo: ${state.cost_recovery.error_code}, fase ${state.cost_recovery.failure_stage}; cotización USD ${state.cost_recovery.quote_amount_usd??'UNKNOWN_NOT_PERSISTED'}; reserva calculada USD ${state.cost_recovery.calculated_reservation_usd??'UNKNOWN_NOT_PERSISTED'}; multiplicador ${state.cost_recovery.reservation_multiplier}. ${state.cost_recovery.evidence_limitation}`]:[]),
    'Usá sólo el consentimiento específico vigente del reemplazo; no reutilices la autorización original de q42 ni la ampliación a USD 8. No simules ni importes aceptación humana. No liberes la reserva ambigua.',
    `PRIMERA ACCIÓN SEGURA: ${state.first_safe_action}`,
    state.continuation?.integration_status||'Reutilizá Recovery Manager, proposal/risk gate y los contratos existentes. La validación de riesgo actual produce un descriptor inerte: todavía requiere integración transaccional y autenticada de la nueva operación, reserva, journal y recuperación; no es un permiso de emisión.',
    'Antes de cualquier emisión futura: evidencia fresca del original, aprobación específica de riesgo vinculada a propuesta/importe, cotización vigente ligada al nuevo payload, presupuesto para ambas reservas, identidad e idempotencia nuevas, claim único y validación final justo antes del transporte.',
    state.continuation?.decision_rule||'En ausencia de autorización específica, completá implementación, pruebas focalizadas y preparación de la decisión humana; no generes ni reserves. Si aparece un resultado original verificable, recuperalo sin nueva emisión y pedí revisión humana del artefacto.',
    'BLOQUEOS PRIORIZADOS:',
    ...blockers.map(b=>`${b.priority}. ${b.category}: ${b.status} — ${b.description}; depende de ${b.dependencies.join(', ')||'ninguno'}; costo ${b.resolution_cost}; tiempo ${b.time_estimate}.`),
    'INCIDENTES ABIERTOS:',...open.map(i=>`${i.INCIDENT_ID} [${i.CONFIDENCE}]: ${i.SYMPTOM}. Próximo: ${i.NEXT_ACTION}`),
    'EVIDENCIA A REUTILIZAR:',...state.tests.map(t=>`${t.status}: ${t.command}; ${t.result}`),
    ...state.recent_commits.map(c=>`Commit ${c.sha}: ${c.subject}`),
    state.continuation?.prohibitions||'PROHIBICIONES: no main/producción/Make; no multimedia, reenvíos, variantes, reintentos automáticos ni nuevos gastos bajo este borrador; no superar USD 8; runners OFF; autorun false; publicación deshabilitada; no tocar q41 ni el journal original.',
    'ACEPTACIÓN:',...state.acceptance,
    'Separá PASS_REAL, PASS_INTEGRATION, PASS_OFFLINE y NOT_TESTED_REAL. Las simulaciones no avanzan el checkpoint ni prueban cobros o generación real.',
    'Actualizá incidentes, feedback y estado una vez al cierre; generá un solo borrador siguiente. No lo ejecutes automáticamente.',
    `INPUT_SHA256: ${digest}`,
  ].join('\n')+'\n';
  const resume=['# Lumi resume state',`Observed: ${state.observed_at}. Input SHA-256: ${digest}.`,
    `Repository: ${state.repository}; branch: ${state.branch}; source commit: ${state.source_commit}.`,
    `Deployment evidence: ${state.deployment_evidence}. Always resolve current HEAD/live before writing.`,
    ...(state.transport?[`Transport: ${state.transport.status}. ${state.transport.summary}`,`Recovered work: ${state.transport.recovered_work}`]:[]),
    `Episode: ${state.episode_id}; ${state.status}; ${state.progress.completed}/${state.progress.total}.`,
    `Last: ${state.last_completed_action}; next: ${state.first_pending_action}.`,
    `Original operation: ${original.operation_id}; journal attempt: ${original.attempt_id}; ${original.status}/${original.response}.`,
    `Proposal: ${state.proposal_id}; risk acceptance ${state.consent?.status||'NOT_GRANTED'}; replacement operation ${state.replacement?.operation_status||'NOT_CREATED'}; reservation ${state.replacement?.reservation_status||'NONE'}. ${state.consent?.explanation||''}`,
    `Budget USD ${budget.ceiling_usd}; exposure ${budget.exposure_usd}; proposed additional maximum ${budget.proposed_new_reservation_usd}; charges UNKNOWN.`,
    '## Evidence-based metrics',...Object.entries(state.metrics).map(([k,v])=>`${k}: ${JSON.stringify(v)}`),
    '## Blockers',...blockers.map(b=>`${b.priority}. ${b.category} / ${b.status}: ${b.description}`),
    `Next safe action: ${state.first_safe_action}`,
    'Canonical structured inputs: docs/lumi-improvement/state.json and incidents.json. Regenerate once with node scripts/lumi-improvement-loop.mjs. No provider or database calls.',
    'docs/RESUME_STATE_EP004.json is historical; this snapshot supersedes its status, not its evidence.'
  ].join('\n\n')+'\n';
  const feedback=['# Lumi prompt feedback',`Evidence cutoff: ${state.observed_at}.`,
    ...Object.entries(state.feedback).flatMap(([k,v])=>[`## ${k}`,Array.isArray(v)?v.map(x=>'- '+x).join('\n'):String(v)]),
    '## Reproduction','node scripts/lumi-improvement-loop.mjs',
    `Input SHA-256: ${digest}. Outputs are inert drafts; generating them cannot expand authorization.`].join('\n\n')+'\n';
  return {prompt,resume,feedback,input_sha256:digest};
}
