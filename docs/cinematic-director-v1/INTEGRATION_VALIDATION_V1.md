# Continuación de integración con originales

Estado: **LUMI CINEMATIC DIRECTOR V1 — INTEGRATION BLOCKER PRESERVED**.

Los originales ya son accesibles y están verificados. La disponibilidad de bytes no cierra los gates de dirección, capacidades o revisión visual completa. No se desplegó esta revisión en staging.

## Recuperación y publicación

- Autoridad recuperada: rama local `local/lumi-cinematic-director-v1`, HEAD inicial `c53bb1c74de38f1bc09804f14b59fc1bf1cf517a`, árbol `3637a38dadc603157df681317c1ef6ddce57122b`. Sin commits posteriores al iniciar y sin cambios tracked.
- `LAST_COMPLETED_ACTION`: implementación opt-in y 169 tests offline, con evidencia documental.
- `FIRST_PENDING_ACTION`: publicación de la rama aislada y vinculación de originales.
- No se aplicó el ZIP. No se modificaron main, producción, RLS, runners, Make, Telegram ni el default legacy.
- Shell Git carece de autenticación de escritura. Se publicó mediante conector GitHub en `lumi-cinematic-director-v1`; el commit remoto inicial `9e2dd48f0bedbf58f7b5aae6a6fb899b6e7eb072` tiene exactamente el mismo árbol que `c53bb1c`. Las fechas/autor del conector producen SHA de commit diferentes; se exige igualdad de árbol, no igualdad ficticia de commits.
- CI inicial real: https://github.com/AgustinGettar/content-factory-renderer/actions/runs/37356548872 — GREEN, incluyendo focused/regression, dry run canónico y revisión de diff. La entrega final registra el run del último árbol publicado.

## Originales y procedencia

Se consultó Supabase mediante SELECT autenticado de `lumi_pilot_runs` y `storage.objects`. Los bytes se materializaron por transferencia autenticada server-side de sus copias originales en ChatGPT Library. Cada SHA coincide con el ledger y con el objeto canónico de Storage. No se descargaron imágenes por URLs públicas ni se usaron signed URLs como identidad.

Los tres bindings en `bindings/` conservan bucket, object path, UUID de Storage, SHA, Library ID, IDs de proveedor, ledger, QA y contrato histórico. El original q31 proviene de un adjunto humano: no se inventa un job de imagen. Las imágenes q32/q33 sí conservan sus jobs.

| Clip | Source | MP4 | Verificación nueva |
|---|---|---|---|
| q31-PRO2 | PNG 941×1672 | H.264 1080×1916 | SHA y decode PASS; 4.042 s, 24 fps, 97 frames, 0 audio, 0 segmentos negros |
| q32 | PNG 1520×2688 | H.264 1080×1912 | SHA y decode PASS; 4.042 s, 24 fps, 97 frames, 0 audio, 0 segmentos negros |
| q33 | PNG 1520×2688 | H.264 1080×1912 | SHA y decode PASS; 4.042 s, 24 fps, 97 frames, 0 audio, 0 segmentos negros |

Se extrajeron frames 0/20/48/69/75/80/89/96 de cada original. Son derivados QA locales, no nuevas fuentes. Las observaciones nuevas enumeran explícitamente los frames visualmente inspeccionados. Decode completo y muestreo no certifican la toma entera a velocidad nativa. Los originales no fueron modificados ni transcodificados.

## Integración y compatibilidad

La entrada sigue siendo `lib/lumi-series-v2-execution.js:runLumiV2Step`, opt-in antes de clientes y emisiones. `reviewAtCanonicalBoundary` puede consumir `historicalReplay` con binding, observaciones y mediaRoot locales. Valida alcance, fingerprint, SHA de ambos originales y ejecuta el compilador existente. No es otro pipeline ni una ruta de despacho.

`canonical_path` es una extensión explícita del envelope de medios: conserva identidad persistente aunque la ruta local de transporte cambie. Requiere SHA verificado. El V2 cerrado y V3 de diez bloques no se alteran. Los bloques V3 originales siguen bajo pruebas exactas.

`topology.js` añade el lock V2 al director opt-in. Reutiliza el body gate anterior cuando hay QA legacy y no cambia sus consumidores. La misma función evalúa fuente, paquete de video, QA temporal muestreado y checklist de master. No se ejecutó una creación/revisión de master real. Es un evaluador de observaciones tipadas, no un detector de píxeles ni otro escritor de aprobaciones.

`acting-presets.js` define los nueve presets requeridos, límites cualitativos, ojos/cabeza/brazos/alas/cámara, movimientos prohibidos y final. No inventa grados medidos. Los cuatro patrones de proyección anteriores se vinculan a la biblioteca; los restantes quedan disponibles para planificación revisada, sin ampliar silenciosamente el enum V2 ni enviar nuevos prompts. La aprobación de cada actuación futura sigue pendiente.

q31 es Golden GREETING únicamente. Su aprobación humana del artefacto se mantiene aunque reportes históricos digan PENDING. El ledger y la instrucción humana posterior son específicos del mismo SHA. El actor/fecha históricos permanecen desconocidos; la reafirmación de la sesión se registra por separado. El warning alar no aprueba nuevas deformaciones ni convierte el contorno posterior de su fuente en anatomía universal.

## Replay y límites

Los packets e inputs en `replay/` proceden de los seis originales, no de fixtures. El replay llama al punto canónico dos veces por plano: mismos fingerprints y decisiones, sin clientes ni red. Todos los payloads son null/NOT_SENT y execution=false.

- q31: compatible con HUMAN_APPROVED del clip histórico, sin nueva certificación anatómica. La fuente requiere revisión bajo V2 por su contorno posterior. No se solicita reparar q31.
- q32: bloquea POSTERIOR_BODY_MUTATION; conserva el precursor parcialmente ocluido como hipótesis separada. La fuente previa no tiene el defecto confirmado del video; sus checks V2 adicionales siguen pendientes. Cámara fija no evitó el giro corporal observado.
- q33: bloquea EXTRA_BODY_SEGMENT en fuente y STRIPED_ABDOMEN en video. El diagnóstico de fuente heredada y amplificación temporal prevalece sobre el primer reporte que decía “solo video”.

No se concluye que una palabra causó el defecto. Preservar torso y localizar gesto reduce riesgo de forma plausible, no garantiza obediencia. El texto exacto del request histórico no se reconstruye usando código modificado después de esas generaciones.

Los contratos históricos tienen locks sin hashes y Golden roles incompletos. Los packets conservan SCHEMA_VALID=false y sus blockers; la prueba de clasificación histórica PASS no los convierte en propuestas despachables. Tampoco se inventaron manos libres, medidas, revisiones humanas o medios Golden faltantes.

## Capacidades y bloqueos de integración

`PROVIDER_ENDPOINT_CAPABILITY_MATRIX_V1.json` registra todos los ejes pedidos y separa confirmado, observado y desconocido. Las fuentes oficiales consultadas son los API references exactos de Pro y Marketing Studio; el catálogo del conector devolvió Turbo, por lo que no se trasladó ese esquema a Pro.

Confirmado: Pro por endpoint del request; image_url, duración entera 3–15, sound on/off, cfg_scale 0–1, multi_shots; opcionales last_image_url/elements/multi_prompt desactivados. Las salidas históricas 1080×1916/1912 no prometen 9:16 exacto. El ledger conserva request IDs, estimaciones y modo solicitado; la ausencia de ACTUAL_MODE no implica Standard.

Pendiente: límites documentados de prompt y MIME/peso/dimensiones, envelopes completos originales PREPARED/ACKNOWLEDGED/terminal. Su existencia en Storage se verificó, pero esos JSON privados no se recuperaron por una vía autenticada de bytes disponible en esta sesión. No se extrajeron credenciales ni se creó una vía de descarga en el servidor. El request journal SQL contiene antiguas tomas Standard distintas y no se usó como evidencia de estos jobs Pro.

Mask/negative_prompt/seed/resolution y otros campos ausentes del endpoint Pro se bloquean, no se ignoran. No se deduce soporte mask de otra plataforma o del modelo subyacente. No hay garantía exactly-once remota: INSPECT_FIRST y reconciliación existentes siguen siendo autoridad.

## Reparación mínima futura, sin ejecutar

| Plano | Fuente | Video | Preset | Calls propuestos | Costo actual |
|---|---|---|---|---|---|
| q32 | SOURCE_REUSE condicionado a revisión de fuente V2 | VIDEO_REPAIR_REQUIRED | PRESENT_OBJECT | 0 imagen + 1 video | Sin cotización vigente; referencia histórica USD 0.381 |
| q33 | SOURCE_REGEN_REQUIRED | VIDEO_REPAIR_REQUIRED | PRESENT_OBJECT | 1 imagen + 1 video | Sin cotización vigente; referencia histórica USD 0.608 |

Sin retries, variantes ni resubmits. Los importes son evidencia histórica, no presupuesto ni autorización. No se autoriza q33 ni q34–q36.

## Pruebas y reproducción

200 tests locales PASS: 169 originales/regresión + 31 nuevos, incluyendo 20 combinaciones de defectos genéricos en las cuatro etapas. Otro episodio y otro shot se bloquean por la misma categoría. También se cubren UNKNOWN/oclusión, SHA incorrecto, warning acotado, cámara fija con giro, presets, campos no soportados y ruta canónica distinta del transporte.

El workflow `.github/workflows/lumi-cinematic-director-v1.yml` corre solo en la rama aislada, sin secretos, despliegue ni proveedores. `director-offline-guard.mjs` bloquea red y clientes auxiliares. La revisión de diff comprueba superficies protegidas, rutas permitidas y credenciales; no pretende ser una auditoría integral del repositorio. No se reinterpretó el fixture externo ausente de otra suite como regresión nueva.

Reproducción con originales ya descargados:

```bash
node --import ./scripts/director-offline-guard.mjs scripts/director-verify-originals.mjs "$MEDIA_ROOT" /tmp/lumi-original-check
node --import ./scripts/director-offline-guard.mjs scripts/director-dry-run.mjs /tmp/lumi-drafts
node --import ./scripts/director-offline-guard.mjs scripts/director-authentic-replay.mjs "$MEDIA_ROOT" /tmp/lumi-drafts /tmp/lumi-replay
```

La CI no descarga medios privados; sus regresiones unitarias están rotuladas como sintéticas. El replay auténtico ocurrió localmente y entrega manifests auditables; no se presenta como replay remoto.

## Gate de staging

No cumplido: capacidades incompletas, envelopes pendientes y paquetes de dirección incompletos. Conforme al orden autorizado, no se desplegó ni se añadió una entrada HTTP/runner para superar estos blockers. El modo staging del director continúa rechazado; la integración staging y su dry run son trabajo pendiente explícito.

Render exige selección confirmada de workspace; `list_services` no pudo inspeccionar servicios sin esa selección. Se encontró un único workspace, pero no se seleccionó automáticamente ni se modificó ningún servicio. El SHA/health histórico en PROJECT_STATE no se presenta como verificación actual.

`PROVIDER_CALLS=0`, `IMAGE_CALLS=0`, `VIDEO_CALLS=0`, `TTS_CALLS=0`, `NEW_GENERATION_COST=0`, `NEW_MEDIA_GENERATED=0`, `MASTER=NOT_CREATED`, `EPISODE_RESUMED=false`, `PRODUCTION_ACTIVATED=false`.

`NEXT_ACTION=COMPLETE_ENDPOINT_AND_DIRECTION_EVIDENCE_THEN_VALIDATE_STAGING`. No corresponde todavía `AUTHORIZE_ONE_CONTROLLED_Q32_DIRECTOR_REPAIR`.
