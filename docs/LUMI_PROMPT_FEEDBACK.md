# Lumi prompt feedback

Evidence cutoff: 2026-10-19T00:41:27.938785Z.

## Qué pidió el prompt anterior

- Recuperar el estado real tras confirmación fallida y corregir consentimiento durable; no generar, reservar, reintentar ni alterar la aceptación existente.

## Qué se completó realmente

- Lectura inicial de continuidad, HEAD/live y evidencia durable. Se encontraron dos aceptaciones reales, dos quote claims y cero operaciones/reservas/journals nuevos.
- Separación de consentimiento nuevo explícito (24h), challenge corto y cotización; fingerprint de contenido verificado, renovación sólo del transporte, confirmaciones con ID único, fencing y resultado/error durable. Historial y expiraciones anteriores intactos.
- UI muestra decisión guardada, razón/fecha de vencimiento y códigos seguros. Generador de continuidad ya no afirma aceptación ausente cuando existe.

## Qué quedó pendiente

- Error primario histórico UNKNOWN: no se guardó el resultado del estimador ni código backend. Ambas confirmaciones empezaron antes del vencimiento; no atribuir automáticamente el popup a caducidad.
- Decisión humana nueva sólo porque el consentimiento actual venció explícitamente. Cotización real dentro de USD 0.3275 y resultado EP004 no verificados; progreso sigue 8/50.

## Qué trabajo se repitió innecesariamente

- No se reconstruyó arquitectura ni historia. Se repitieron únicamente pruebas afectadas por la corrección, con red bloqueada. Las pruebas anteriores reemplazaban todo el estimador: no demostraban el éxito de una cotización real.

## Qué instrucciones evitaron errores

- No interpretar popup como prueba de no emisión: se verificó ausencia del journal atómico y operación de reemplazo. Mantener reserva original, q41 y USD8.
- Respetar caducidad explícita impidió prolongar retroactivamente las aceptaciones reales; distinguir vigencia de consentimiento de vigencia del transporte evita pedir decisiones válidas otra vez.

## Qué instrucciones generaron fricción

- No es posible recuperar un código que el backend anterior no persistió. La corrección registra futuros fallos; no se repitió una llamada real para inferir el error pasado.

## Qué evidencia faltó

- Código exacto/recibo de las cotizaciones fallidas; precio vigente real; resultado/cargo original q42; validación Telegram/iPhone después del fix.

## Qué decisión humana se necesita

- Conservar las dos decisiones originales y explicar sus vencimientos. Una nueva aceptación sólo si el usuario desea continuar desde la ya vencida; nunca repetir una aceptación todavía válida. Confirmar generación continúa siendo otra acción explícita.

## Qué pruebas pasaron

- 79/79 focalizadas, incluyendo 20 de SQL/auth/consentimiento; EP005/EP006 sintéticos. Proyección de snapshot EP004 PASS_INTEGRATION sin escrituras. CI final pendiente de verificar por SHA.

## Qué riesgos permanecen

- Cargo original desconocido y posible duplicación; reserva interna no es gasto real. No se promete precio dentro del máximo ni un cargo único.
- Error primario anterior desconocido. Si una cotización supera el máximo, permanece bloqueada; una cotización nueva no amplía permisos. Operación generativa iniciada o ambigua nunca se reintenta.

## Reproduction

node scripts/lumi-improvement-loop.mjs

Input SHA-256: d4753cc74198912544fad8b4fcdd5cbeb972e82c0039551128f4b4143f128ea9. Outputs are inert drafts; generating them cannot expand authorization.
