# Lumi prompt feedback

Evidence cutoff: 2026-10-21T11:34:48.825Z.

## Qué pidió el encargo

- Recuperar la imagen q42 ya emitida y cerrar el circuito de episodio dentro de Studio, sin cotización manual ni otro prompt técnico.

## Qué se completó realmente

- Causa reproducida: handleStageResult leía estimated_cost.usd, pero el recibo real contiene estimate_usd/reserve_usd; usd_amount_invalid aparecía como MINI_ACTION_UNAVAILABLE. Normalización y preservación de reserva por intento.
- Recuperación real automática desde recibo COMPLETE y Storage, sin reenviar ni reservar; una revisión pendiente.
- Trabajo durable por episodio con consentimiento de plan, leases, cotización interna, gates, revisiones, TTS y master. Dos episodios completos de integración con externos simulados.
- Recuperación de decisión humana persistida tras pérdida de respuesta, con binding exacto y validación de bytes; nunca aprobación inventada.

## Qué quedó pendiente

- Revisión visual humana de q42 y aprobación del plan restante dentro de Studio; futuras etapas y master real EP004.
- Cargos y resultado histórico original desconocidos. Asignaciones de voz/infraestructura desconocidas.

## Qué trabajo se repitió innecesariamente

- No se reinvestigó Make ni se reconstruyeron q42, Budget Gate o journals. CI repitió sólo regresiones afectadas cuando cambió su código. El fallo decimal de proyección se corrigió antes de desplegar.

## Qué instrucciones evitaron errores

- Recuperar el recibo y archivo reales; un errorHTTP no prueba fallo del proveedor.
- Preservar dos reservas y el original ambiguo; nunca crear tercer intento.
- No inferir revisión humana o autorización de plan a partir del presupuesto8 ni del chat.
- Procesamiento durable fuera de GET y de sesiones vencidas.

## Qué instrucciones generaron fricción

- Los documentos antiguos seguían indicando reemplazo NOT_CREATED y riesgo pendiente. Se reemplazó ese estado por evidencia actual; no se produjo otro prompt de continuación.

## Qué evidencia faltó

- Cobro real de ambos requests; resultado del original sin ID verificable.
- Revisión artística/iPhone del nuevo resultado y futuras etapas productivas reales.

## Qué decisión humana se necesita

- Revisar q42 en Studio. El plan restante se confirma una vez en la app cuando corresponde; decisiones posteriores editoriales también en Studio.

## Qué riesgos permanecen

- No garantía exactly-once del proveedor. Ningún timeout libera claims ni habilita regeneración.
- Suspensión de Render interrumpe ejecución hasta despertar; no continuidad ilimitada ni hosting adicional.
- Un rechazo artístico o una operación realmente ambigua se conserva y no provoca otra generación automática.

## Reproduction

node scripts/lumi-improvement-loop.mjs

Input SHA-256: fce6705086d65f139bbb4daf9ea03f0df126aea079360266328356499f8a3dac. Outputs are inert drafts; generating them cannot expand authorization.
