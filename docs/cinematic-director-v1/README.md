# LUMI_CINEMATIC_DIRECTOR_V1

**Continuación 2026-10-05:** consultar `INTEGRATION_VALIDATION_V1.md` para publicación remota, CI, medios auténticos, topología y replay. El reporte siguiente documenta la fase inicial en `c53bb1c`; sus frases “no push” y “originales no materializados” son históricas y fueron superadas por la continuación. Los blockers restantes no se convierten en PASS.

Estado: **IMPLEMENTED_WITH_BLOCKERS**. Implementación local e integración offline probadas; no desplegada, sin validación mediante nuevas generaciones.

Base: `AgustinGettar/content-factory-renderer`, rama `lumi-app-recovery-manager-v1`, commit `f42d5a83e2806b3db17080c2829d305bad4a8525`. Trabajo aislado en `local/lumi-cinematic-director-v1`. `main` sigue en `5fe5556395829e78817771f96d33cce3f692965d`. No push, merge ni deploy.

## Entrada e integración

La única modificación del runtime existente está en `lib/lumi-series-v2-execution.js`, función `runLumiV2Step`: una rama opt-in antes de autorización remota, creación de clientes, storage, quotes, claims o journal. Requiere simultáneamente:

- `LUMI_CINEMATIC_DIRECTOR_V1=true`.
- `LUMI_RUNTIME_ENV=local_offline`.
- Selección existente `LUMI_PIPELINE_VERSION=v1_1_2`.
- `directorReview` explícito, con input y directorio local de salida.

No se agregó boot action, ruta HTTP, dispatcher ni runner. No se cambió ninguna variable del entorno real. Con flag ausente/apagado continúa la implementación anterior. `pipelineVersion({})` sigue devolviendo `legacy`. Con flag activo en staging/producción, el módulo rechaza antes de crear clientes. No existe modo de despacho del director en esta versión.

El dry run llama a **la función canónica real**, no solo al compilador desde una CLI independiente. Su rama offline lee el Episode Plan y Shot Pack persistidos, reutiliza `validateThirdShotPack`, comprueba episodio, plano, duración y objetivo educativo, y retorna antes del límite de emisión. No prueba persistencia remota ni el preflight online.

Los aliases q35→q37 y q36→q39 permanecen: la fuente de q35 es s35, pero la pregunta pertenece al beat s37; el cierre usa fuente s36 y beat s39. Se preservan seis shots, nueve beats y 4/4/4/4/5/5 s. Los planes existentes no se modifican.

## Código y reutilización

- `lib/cinematic-director-v1/PROMPT_COMPILER_V3.mjs`: recuperado de Library. Conserva su API y salida `OFFLINE_REVIEW_DRAFT` de diez bloques. Se extrajeron dos funciones reutilizables, `evaluateSourceEvidence` y `evaluatePostproductionEvidence`; `evaluateReadiness` conserva orden, errores y política histórica. No hay otro validador V2.
- `LUMI_KLING_SHOT_CONTRACT_V2.schema.json` y sus 38 tests originales: preservados. V3 no estaba integrado en la rama recuperada; se incorpora su código existente.
- `LUMI_CINEMATIC_DIRECTION_V1.schema.json`: envoltorio explícito. La parte `contract` pasa por `validateShotContract`; la extensión cerrada pasa por Ajv, ya dependiente del repositorio.
- `director.js`: evidencia de bytes/revisiones, compatibilidad de actuación, configuración por episodio/plano, congelación local, fingerprints, paquetes, checklist y revisión estructural de secuencia.
- `projection.js`: gramática V1 para presentación de flor, espera atenta, mirada al espectador y despedida. Proyección en inglés vigente o español explícito, con correspondencia en el resumen español. Sin llamadas a modelos, regex visuales, mejora automática ni traducción externa.
- `profiles.js`: política offline versionada y capacidades vinculadas al endpoint exacto. No sustituye presupuesto ni autorización del Recovery Manager.
- `integration.js`: puente mínimo desde la entrada canónica. Reutiliza el validador de Shot Pack y la selección existente por pipeline.
- `scripts/director-offline-guard.mjs`: bloquea red, importaciones de SDKs generativos y procesos auxiliares; solo permite ffmpeg/ffprobe con inputs locales para regresiones existentes.
- `scripts/director-dry-run.mjs`: tres ejemplos sintéticos y paquetes documentales q31/q32/q33 a través de la entrada canónica.
- `test/lumi-cinematic-director-v1.test.js`, `test/fixtures/director-v1.js` y `director-v3-baseline.json`: casos concretos y comparación exacta con seis salidas V3 recuperadas.

No se duplican claims, ledger, reconciliación ni Recovery Manager. `bodyAnatomyGate` se invoca sin rebajar UNKNOWN o warnings. `sourceGate`, `previousVideoGate` y `recordShotPackTemporalQa` siguen siendo los controles/escritores existentes. El director entrega un plan de QA, nunca resultados visuales fabricados ni una aprobación alternativa.

## Autoridad y diferencias encontradas

Se inspeccionaron LUMI_PROJECT_STATE y addendum, Bible V2, Character/World/Style, perfiles V2, preset 1.1.2, Episode Plan, Shot Pack, contrato/compilador, informes q31–q33, adaptador, journal y Recovery Manager. Los archivos en `evidence/` son copias documentales con SHA en `manifest.json`; no son nuevas revisiones visuales.

1. PROJECT_STATE y el addendum preservan checkpoints anteriores; no revocan la aprobación posterior de q31-PRO2. El perfil posterior nombra Pro y el propio runtime usa `kling-video/v3.0/pro/image-to-video`.
2. V3 histórico impone Standard y USD 4; Shot Pack histórico fija Standard y otros techos. Se preservan para sus consumidores. La nueva proyección utiliza una política explícita del episodio con procedencia. Su presupuesto autorizado incremental es cero; los importes históricos no se convierten en permisos actuales.
3. Nombres históricos `ultra-realistic` sobreviven como evidencia, pero no entran en el prompt proyectado. La dirección actual es premium stylized 3D CGI. El runtime antiguo sigue intacto cuando el flag está apagado; esta tarea no reescribe sus prompts globales.
4. q31-PRO2 sigue HUMAN_APPROVED, SHA `ea5a54493bf1ccf037ac5acac2d81668c0d9f7c0239d81479dfa7968c7ee0307`. El warning aceptado de alas conserva su alcance. El reporte recuperado no expone actor ni fecha exactos: se registran como desconocidos, sin retirar la aprobación histórica y sin usarla para aprobar otro artefacto/anatomía.
5. El informe de Quality Gate retiró el PASS inicial de q32. El forense posterior, ligado a los mismos SHA/request IDs y al commit base, identifica q32 como `TEMPORAL_MUTATION` y q33 como `SOURCE_DEFECT_WITH_TEMPORAL_AMPLIFICATION`. Son diagnósticos recuperados, no una nueva certificación. El precursor parcialmente ocluido de q32 conserva su incertidumbre. No se atribuye causalidad a una palabra del prompt.
6. Los contratos V2 recuperados son borradores históricos con locks/hash sin completar y Golden roles sin vincular. No se rellenan con medidas, manos libres o geometría oculta inventadas.

Un conflicto de política sin resolución explícita devuelve `POLICY_CONFLICT`. El módulo no selecciona otro proveedor/tier para hacerlo pasar.

## Capacidades del endpoint

Fuente oficial consultada el 2026-10-05: https://open.higgsfield.ai/models/kling-video/v3.0/pro/image-to-video/api-reference

Se confirmó documentalmente el endpoint Pro y los campos `prompt` string, `image_url` string requerido, `sound` on/off, `duration` entero 3–15, `cfg_scale` 0–1 y `multi_shots` booleano. Audio apagado y una toma se representan mediante controles reales; CFG permanece 0.5 sin pretender que sea un porcentaje de obediencia.

La página lista Elements, multiprompt y end frame; esta integración los deja desactivados, sin crear recursos ni inferir compatibilidad de los cuatro roles Golden. No añade seed, negative_prompt, resolution, aspect_ratio, camera_control ni enhance_prompt.

Pendientes: límite documentado de longitud del prompt y restricciones completas de MIME/dimensiones/peso de medios. `CAPABILITIES_VERIFIED=false` para el perfil real hasta verificarlos. Una frase de la página dice Standard junto al endpoint Pro: se registra la inconsistencia; el endpoint solicitado no demuestra el modo interno ejecutado. Las transformaciones internas del proveedor no son observables.

## Evidencia y salidas

Cada packet separa `DIRECTOR_PLAN`, `PROVIDER_PROMPT`, `PROVIDER_REQUEST_PREVIEW` y `V3_AUDIT`. Un contrato válido no prueba píxeles. Cada hecho observado debe coincidir con una observación en una revisión citada de los mismos bytes; desconocidos/propuestas no se convierten en hechos.

El plan creativo se congela y escribe con creación exclusiva antes de proyectar. Un archivo idéntico se reutiliza; una colisión con contenido diferente bloquea. El fingerprint creativo incorpora fuente, dirección, prompt, parámetros, versiones/política y capacidades; omite URLs firmadas, rutas locales y timestamps de revisión. Una renovación de URL no crea intención nueva. La aprobación de dirección se vincula al fingerprint exacto; cambios materiales requieren nueva revisión.

El request preview siempre lleva `NOT_SENT`, `payload=null` y `executable=false`. Identifica parámetros y rol de `image_url`, separa referencias QA de condicionamiento y oculta transporte. Cuando falta fuente no inventa URL ni produce prompt que finja estar vinculado. Los borradores incompletos siguen visibles con bloqueos. Ninguna salida es una autorización de despacho.

Los warnings no se borran. V3 conserva su exigencia estricta de QA PASS para Golden/source; un warning histórico de un contorno no equivale a aprobar una fuente nueva. Las aprobaciones sintéticas solo se aceptan como fixtures en el modo local explícito y nunca pasan HUMAN_DIRECTION_APPROVAL.

## Ejecución reproducible

Node 24; dependencias instaladas desde el lockfile con `npm ci --ignore-scripts --no-audit --no-fund`. Sin scripts de instalación ni cambios al lockfile.

```bash
node --import ./scripts/director-offline-guard.mjs --test \
  lib/cinematic-director-v1/PROMPT_COMPILER_V3.test.mjs \
  test/lumi-cinematic-director-v1.test.js \
  test/lumi-series-v2-gates.test.js \
  test/lumi-third-shot-pack-v1.test.js \
  test/lumi-third-shot-pack-runtime-v1.test.js \
  test/lumi-third-shot-pack-preflight-resume.test.js \
  test/lumi-recovery-incident-manager-v1.test.js \
  test/lumi-recovery-server-integration.test.js \
  test/lumi-q31-qa-recovery.test.js \
  test/lumi-q31-pro2-calibration.test.js \
  test/provider-emission-journal-v1.test.js

node --import ./scripts/director-offline-guard.mjs \
  scripts/director-dry-run.mjs ./director-output
```

**Resultado ejecutado: 169/169 tests PASS**, sin fallos ni skips: 38 originales V3, 52 tests del director y 79 regresiones existentes. La comparación de las seis salidas V3 históricas es exacta, incluidos errores y hashes. Tres ejemplos offline y tres paquetes documentales se ejecutaron por la entrada canónica.

La regresión usa mocks rotulados cuando evalúa el journal/adaptador; no llega a proveedores. El guard impide acceso de red también para consultas, upload y recursos auxiliares. No ejecutar comandos de server/start, preflight online ni boot actions para revisar este módulo.

## Trabajo pendiente y límite de validación

- Vincular bytes originales aprobados y revisiones actuales de actuación/pose/captions y todos los Golden requeridos. No se pidieron ni generaron medios nuevos. Los paquetes reales registran que sus originales no fueron materializados/revisados visualmente en este dry run.
- Resolver el defecto de fuente documentado de q33 antes de animar; q32 conserva el bloqueo temporal. Esta tarea no autoriza ninguna reparación.
- Completar procedencia precisa del warning q31 y revisión de secuencia/vecinos. No convertir muestreo ni decode en visual PASS.
- Completar capacidades oficiales, revisar la dirección exacta y obtener futuros controles canónicos de presupuesto/ejecución. El director no implementa una vía de envío futura oculta.
- Probar integración remota y videos reales únicamente en otra fase autorizada. No se consultó/escribió la base de datos en esta fase ni se reanudó el episodio.

Estado final: `PRODUCTION_ACTIVATED=false`, `PROVIDER_CALLS=0`, `NEW_GENERATION_COST=0`, `NEW_MEDIA=0`, `TTS=0`, `MASTER=NOT_CREATED`, `EPISODE_RESUMED=false`.

Continuation review R2: [closure report](closure-v2/REVIEW_CLOSURE_REPORT.md). All-frame static review is recorded separately from pending native-speed playback. Staging remains gated.
