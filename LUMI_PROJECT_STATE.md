# Lumi Project State

## Authority
- Validated code SHA: 472adc82cc4bd9c8582c3a01c3df7e4f0cccb421
- Validated branch: lumi-pilot-ci-validation
- State handoff branch: lumi-pilot-migration-handoff (documentation only; no CI rerun)
- Production authority: main@5fe5556; no production changes during this execution
- Approved reusable scenes: S11, S12, S17
- S13/S14/S15/S16/S18/S19: NOT_STARTED
- Accepted narrative: ep_lumi_huevos_001 / lumi_cinco_huevos

## Gates
- PILOT_CODE_VALIDATED=YES
- CI_RUN_ID=36634634737
- NPM_CI=PASS
- SYNTAX=PASS
- FOCUSED_TESTS=19/19
- REGRESSION=54/54
- SECURITY_DIFF=PASS (test helper only; no secrets)
- PILOT_MIGRATION=PASS
- MIGRATION_NAME=lumi_pilot_internal_runs
- MIGRATION_VERSION=20260929220840
- SUPABASE_PROJECT=hdptwtzhpfdrqiuezjhu (Content Factory)
- Schema/columns/types/timestamps/constraints/indexes=PASS
- Unique key=pilot_id+scene_id+stage
- RLS=enabled
- anon/authenticated=DENIED (SELECT/INSERT/UPDATE)
- service_role=ALLOWED (SELECT/INSERT/UPDATE); transactional INSERT/UPDATE operational
- Valid IMAGE/VIDEO, duplicate rejection, invalid stage/status rejection, terminal states=PASS
- TRANSACTIONAL_ROLLBACK=PASS
- PILOT_ROWS=0
- STAGING_DEPLOY=NOT_PERFORMED
- STAGING_DEFAULT_OFF_PROOF=PENDING
- DRY_CLAIM=PENDING (runtime integration proof not yet performed)

## Accounting
- IMAGE_CALLS=0/6
- KLING_CALLS=0/6
- COST=USD 0
- IMAGE_HARD_BUDGET=USD 2.00
- VIDEO_HARD_BUDGET=USD 3.00
- ASSEMBLY_GATE=3/9
- MASTER=NOT_CREATED

## Runtime
- Preserved reported state: pilot boot OFF, image runner OFF, Higgsfield runner OFF, autorun=false
- Live runtime flags not reverified in this execution
- No Render deployment or environment mutation performed
- No provider calls performed

## NEXT_ACTION
Confirm Render workspace My Workspace (tea-dahl5nh594qs73ffjhcg), as required by the Render connector before selecting a workspace.
Then inspect content-factory-av2-staging and its sanitized source; set nonsecret flags by MERGE, deploy validated runtime default-OFF, verify health/logs/production, and perform dry claim without provider.
Only after all gates PASS, execute the authorized serial one-shot pilot and QA.

## DO_NOT_TOUCH
Production main, Telegram, Make, queues, publication, approval workflow, Draft→HD production.
No CI/tests/npm ci repetition. No runner rewrite without demonstrated defect.
No multimedia before migration/staging/default-OFF/dry-claim gates pass.
