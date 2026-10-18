# Lumi prompt feedback

Evidence cutoff: 2026-10-18T23:48:24.502328Z.

## Qué pidió el prompt anterior

- Completar y desplegar staging de la activación supervisada autenticada/transaccional, sin aceptación económica, generación ni reservas nuevas.

## Qué se completó realmente

- Se reutilizan la propuesta existente, Recovery Manager, session CAS, journals, materializador, estimador, transporte y recuperación. UI con aceptación explícita y generación separada; referencia de consentimiento y antireplay.
- Transacción service_role con preservación de la reserva original, clave nueva independiente y un único sucesor. Reconciliación de costos por intento; recuperación original prioritaria antes de emisión y preservación de ambas después.

## Qué quedó pendiente

- Decisión humana real sobre el posible doble cargo; cotización/ejecución/recuperación real no realizadas ni autorizadas aquí. EP004 continúa 8/50; imágenes, clips, revisiones, TTS, ensamblado y master pendientes.
- Proveedor original q42 y cargo efectivo desconocidos. Flujo real de dispositivo Telegram no probado.

## Qué trabajo se repitió innecesariamente

- No se rehizo la investigación histórica. Se ejecutó regresión afectada una vez y se repitieron sólo pruebas tocadas por correcciones. No hay base para cuantificar repetición histórica.

## Qué instrucciones evitaron errores

- Leer los cuatro archivos de continuidad primero; distinguir autorización técnica de consentimiento económico; no transformar timeout en no emisión; no tocar reservas ni journals reales.
- Probar el SQL real en PGlite y exigir rollback permitió validar que reserva, operación y claim se escriben juntos. Inspeccionar la recuperación reveló que la conciliación anterior usaba sólo action.key.

## Qué instrucciones generaron fricción

- La recuperación futura debe manejar la aparición tardía del original, pero hoy no existe request ID verificable. Se implementa el camino seguro para evidencia durable vinculada; no se inventa esa evidencia.
- Generación real y aceptación humana están prohibidas durante la intervención: el despliegue técnico no puede declararse avance productivo.

## Qué evidencia faltó

- Request ID, resultado y cobro original q42; decisión humana específica; cotización vigente y resultado real del reemplazo; interacción real Telegram/iPhone.
- Cuota TTS y aceptación real del master futuro.

## Qué decisión humana se necesita

- En Lumi Studio, Producción, abrir Revisar riesgo y autorización. Leer el posible doble cargo y máximo USD 0.3275. La casilla inicia desmarcada. Decidir personalmente; el asistente no acepta por el usuario.
- Aceptar sólo registra consentimiento; una confirmación posterior separada cotiza y puede generar. No se ejecuta automáticamente ni desde este borrador.

## Qué pruebas pasaron

- 155/155 pruebas locales focalizadas; después de la última vinculación antireplay, 39/39 afectadas; 13/13 adversariales finales de activación con el SQL real. CI exacta de release se verifica por GitHub.
- Snapshot real EP004 en sólo lectura: propuesta válida, revisión23, 8/50, riesgo revisable, generate=false, exposición conjunta estimada USD 0.655, disponible USD 6.77375.

## Qué riesgos permanecen

- Posible doble cargo; reserva interna no equivale a gasto. La aceptación y cotización caducan: hace falta nueva revisión explícita si cambian los bytes del payload.
- Un claim ya reservado y bloqueado antes del transporte se conserva; requiere conciliación y nunca dispara un retry. Si el original aparece después de la emisión, se conservan ambos registros.

## Reproduction

node scripts/lumi-improvement-loop.mjs

Input SHA-256: 8d38175c51160fb9f7977b91f062f6696e2e5783c00eb7426f0190bc0405e880. Outputs are inert drafts; generating them cannot expand authorization.
