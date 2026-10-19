# Lumi prompt feedback

Evidence cutoff: 2026-10-19T01:20:15.040407+00:00.

## Qué pidió el prompt anterior

- Corregir integralmente costos, cotizaciones, trazabilidad y recuperación dentro de la arquitectura existente; preservar USD8 y no emitir ni reservar.

## Qué se completó realmente

- Último rechazo recuperado de claim durable y Render: QUOTE / Q41_REQUEST_RESERVATION_LIMIT_EXCEEDED, sin operación/reserva/journal nuevo. Consentimiento real de 24h vigente conservado.
- Cálculo decimal exacto del margen25%, razones separadas, cotización durable antes de admisión y consulta autenticada sin generación. Fuentes de costo vinculadas generalizadas por target_episode.
- Identidad/idempotencia/quote/reserve antes del transporte, correlación antes de parsear; estados derivados de journal/receipts/reviews; presupuesto completo y biblioteca con evidencia de costos desconocidos.

## Qué quedó pendiente

- Importe/ID/vencimiento de la cotización rechazada: no persistidos históricamente. No puede recuperarse fabricando otra cotización.
- Precio vigente, cargo/resultado original, costo total de EP004 y dispositivo real tras deploy. Producción continúa8/50.

## Qué trabajo se repitió innecesariamente

- Se incluyó un archivo histórico completo en una regresión ampliada: ejecutó fixtures locales de medios/master innecesarios, sin red ni proveedor real. No repetirlo. CI ahora selecciona únicamente11 casos de presupuesto/cotización de ese archivo.
- La nueva exigencia de plan completo bloqueó correctamente el fixture antiguo de episodio nuevo sin pronóstico. Se agregó evidencia económica sintética al fixture; el master completo no se volvió a ejecutar.

## Qué instrucciones evitaron errores

- No inferir emisión desde popup ni ausencia de logs; se comprobó frontera atómica y journal. No confundir Q41 en un código con identidad de toma.
- No elevar el máximo específico ni reutilizar el presupuesto8 como permiso de gasto. No repetir el consentimiento vigente.

## Qué instrucciones generaron fricción

- El importe de un rechazo que el backend descartó no puede reconstruirse. Se reporta la limitación y se prepara consulta separada de generación.

## Qué evidencia faltó

- Cotización histórica exacta y recibo/correlación del estimador; cargo original; precios de6 imágenes,6 clips,voz y asignación de infraestructura.

## Qué decisión humana se necesita

- Consultar cotización sin generar desde la sesión autenticada. No volver a aceptar riesgo vigente. Si la reserva resultante supera.3275, revisar el importe exacto y autorizar expresamente otro máximo antes de cualquier cambio; no basta cap8.

## Qué pruebas pasaron

- Casos focalizados de SQL/auth/adaptador real con HTTP simulado, presupuesto, journal, biblioteca y feedback. Última regresión afectada38/38; subconjunto de cotizaciones11/11. CI exacto validará184 casos, sin ejecutar masters históricos.

## Qué riesgos permanecen

- Original q42 ambiguo y cargo desconocido; no liberar su reserva. Idempotencia oficial documentada, pero replay real no verificado ni habilitado.
- Persistencia local puede fallar después de una respuesta remota; conservar claim y recuperar evidencia, nunca emitir automáticamente.
- Faltan costos completos y revisión real de dispositivo; simulaciones no prueban rentabilidad ni completan EP004.

## Reproduction

node scripts/lumi-improvement-loop.mjs

Input SHA-256: 4e9ac06606f1708a010d2415bb8a46bbf8d3f5d03a7d8166dda3e905487f56b9. Outputs are inert drafts; generating them cannot expand authorization.
