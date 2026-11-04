# Continuidad operativa y oportunidades PAPER — 2026-11-04

Protocolo aditivo `secondary-quant-opportunities-1.0.0`. Se instala sobre el motor, broker y cartera secundaria existentes. No cambia los contratos anteriores, capital aportado, cartera principal ni audiovisual.

## Diagnóstico verificado antes de intervenir

AWS: worker activo, cero reinicios y cero errores cuantitativos; 992 evaluaciones, una candidata cuantitativa. Equity secundaria 988,982090683479 USD; ninguna posición ni orden pendiente. Ningún bloqueo diario/drawdown. Los contadores de plazos incluyen actividad anterior a la activación cuantitativa y no son el resultado del nuevo motor.

Una tendencia alcista confirmada en 15m/ADX 45,9 fue clasificada HIGH_VOLATILITY y dejó deshabilitado TREND_FOLLOWING. El volumen relativo de 0,599 tampoco alcanzaba el umbral universal 0,8. El mínimo heredado de ganancia neta era 0,20% también para 1m/5m; se separa del umbral de intradía. Los relojes se recuperaban de esperas de datos: no eran un worker detenido. Las múltiples temporalidades ya tenían admisión separada, pero las primeras entradas podían consumir el presupuesto direccional compartido de 1%.

## Implementación y autoridad

| Área | Cambio | Autoridad |
|---|---|---|
| Régimen | Tendencia y volatilidad coexistentes; una tendencia confirmada puede continuar bajo alta volatilidad/compresión | Nuevas entradas PAPER; stop/volatilidad/coste siguen limitando |
| Volumen | Umbral 0,35 sólo en retroceso/continuación/retest de tendencia confirmada; 0,8 resto; momentum/ruptura conservan sus requisitos adicionales | Hipótesis fija experimental; sin promesa de ventaja |
| Umbral neto | 1m/5m: 0,05% del nominal después de costes, con RR neto ≥ 1; otros plazos conservan 0,20% | Override firmado sólo para contratos nuevos; protección existente intacta |
| Ejecución | Compara entrada inmediata con límite pasiva sólo cuando la inmediata falla RR neto; máximo 0,5 ATR de distancia y dos velas/hasta cinco minutos de vigencia | Broker existente: post-only, latencia, volumen posterior que atraviesa el límite, parciales y vencimiento |
| Riesgo | Reserva una quinta parte del presupuesto direccional para cada plazo; admite nuevas señales independientes | Límites originales: diez plazas, riesgo direccional 1%, agregado 3%, margen 50%, exposición 3×; ningún aumento |
| Datos | Diez endpoints públicos normalizados; caché acotada, timeouts y fallos aislados | Observación; nunca sustituye funding liquidado o profundidad ejecutable por estimaciones |
| Flujo | Delta comprador menos vendedor de tres minutos, cambio relativo de OI, confirmación/oposición por señal | Comparación paralela; no bloquea ni crea órdenes |
| Salidas | Registra oposición del flujo durante beneficio positivo para comparar con la protección MFE/ATR vigente | Sin cierre autónomo por flujo hasta validación |
| Estadística | Baseline meta-label 1.1 incorpora flujo/OI faltantes explícitos y separa dominios por protocolo | Entrenamiento externo, purga, embargo, calibración; mínimo 300 resultados por dominio; sin promoción automática |
| Operación | Consulta velas cerradas más cerca del cierre, conserva caché/mutex y gestión por cotización | Sin entradas intravela ni repetición de señales históricas |
| Diagnóstico | Contadores separados desde activación y por plazo; prioriza el motivo de un patrón detectado | No confunde estrategia no habilitada con error del worker |
| Telegram | Las órdenes límite dicen que están pendientes y cuándo vencen | Sólo eventos auténticos del nuevo motor |

## Normalización y conservación

Los timestamps de funding vienen en milisegundos; los restantes en segundos. `slippage_*` son precios de ejecución, no porcentajes. Las unidades de profundidad/OI no se usan como BTC ejecutables sin verificación. `aggressor-differential` se conserva crudo: la dirección se calcula desde buy_volume − sell_volume del endpoint CVD. Todo dato tiene hash, momento de recepción y bucket cerrado. No se permite que un dato obtenido después de una decisión actúe como si hubiera estado disponible antes.

`trading-quant-analytics.mjs` descarga y comprime archivos fuera del worker/SQLite, registra cobertura, huecos y hashes. `trading-quant-opportunities-research.mjs` compara detección y candidatos económicos contra la versión anterior en siete días históricos. Las cotizaciones de ese ensayo son escenarios declarados; no representa fills, rentabilidad ni validación OOS. Una orden maker tocada por una vela no cuenta como ejecutada.

## Criterios de verificación

Pruebas: separación régimen/volatilidad, volúmenes por patrón, ejecución pasiva con volumen posterior, cinco posiciones/plazos bajo el mismo riesgo, reinicio, cierre individual, causalidad/unidades de datos, degradación de endpoints y regresión de todos los módulos PAPER. Revalidación de RR neto después de latencia. Despliegue con SHA exacto, CI, backup consistente, reinicio controlado y lectura posterior del estado real.

Conservar la protección temprana, MFE/MAE, Fibonacci causal, stops y trailing existentes. Grid/martingala, hedge, arbitraje de funding, nuevas salidas por flujo y modelos aprendidos no adquieren autoridad operativa por añadirse un endpoint. Para activarlos deben superar la validación independiente descrita en el protocolo maestro.

## Evidencia externa previa al despliegue

Diez endpoints: 120 buckets cerrados por endpoint en una captura de dos horas, sin huecos internos. Comparación fija de siete días: candidatos económicos 10 → 70; confirmaciones únicas 10 → 68. Desglose 1m 0 → 14, 5m 4 → 33, 15m 5 → 16, 1h 1 → 6, 4h 0 → 1. De los 70 candidatos, 55 son órdenes pasivas; su ejecución no se supone. Esto mide cobertura de oportunidades bajo costes declarados, no beneficio ni ventaja demostrada.
