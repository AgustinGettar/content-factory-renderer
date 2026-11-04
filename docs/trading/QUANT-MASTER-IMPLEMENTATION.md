# Lumi Trading — implementación cuantitativa PAPER

Especificación: MASTER QUANTITATIVE TRADING INTELLIGENCE suministrada por el propietario el 4 de noviembre de 2026. Base: `91fc37d0b9609b77520833d3ed00278850f32b29`, rama `lumi-trading-aws`. Este cambio amplía el motor existente; no crea otra cuenta, conexión real ni worker de trading.

**Implementado no significa rentable.** Las nueve estrategias son hipótesis deterministas para PAPER. No hay probabilidades calibradas nuevas ni una estrategia aprobada como rentable fuera de muestra. Los métodos avanzados y el cierre parcial 30/30/40 permanecen sin promoción automática.

## Correspondencia con los 17 apartados

| Apartado | Implementación verificable | Activación y límite |
|---|---|---|
| 1. Contexto operativo | Recuperación de contratos existentes, capital finito, un SQLite y un worker; perfiles firmados y versionados. | Solo secundaria `FREQUENT_PAPER`, PF_XBTUSD lineal/USD. No añade capital. |
| 2. Diccionario | `QUANT-DICTIONARY.md` distingue todos los términos solicitados y datos no disponibles. | Un concepto no crea una señal ni certifica una capacidad del exchange. |
| 3. Regímenes | `quant-features.js`: EMA9/21/50/200, pendientes, DMI/ADX, ATR Wilder, VWAP, estructura, volumen, spread. | El régimen filtra las estrategias nuevas; EMA200/anclas incompletas quedan no disponibles. |
| 4. Estrategias | `quant-strategies.js`: SCALP_CONTINUATION, SCALP_REVERSION, BREAKOUT_RETEST, MOMENTUM, TREND_FOLLOWING, MEAN_REVERSION, RANGE_TRADING, VOLATILITY_EXPANSION, LIQUIDITY_SWEEP. | Cada una tiene plazos, regímenes, confirmación, invalidación y veto económico. Las tres reglas previas permanecen disponibles como baseline/fallback al desactivar el módulo. |
| 5. Plazos | `secondary-timeframes.js` v2: entradas 1/5/15/60/240 minutos; datos auxiliares 30m y 1d. | Relojes y cursores independientes. No reproduce entradas históricas al activar. |
| 6. Matemática | Broker decimal existente: PnL lineal, comisiones, funding firmado, slippage incorporado una sola vez. Riesgo exacto por stop y costes; `quant-evaluation.js` amplía métricas. | No multiplica PnL por apalancamiento ni contabiliza aportes como ganancias. |
| 7. Matemática avanzada | Regresión logarítmica, pendiente normalizada, atan, ciclos UTC, correlación, cuantiles, bootstrap por bloques, Monte Carlo de trayectorias, sensibilidad de costes y walk-forward purgado. | Son herramientas de evaluación. No se promocionan métodos por su complejidad o por un resultado aislado. |
| 8. Apertura | Patrón causal, régimen, BBO fresco, contrato y tabla pública de margen, stop/TP, R:R neto ≥1, filtro neto vigente, riesgo, margen, exposición, liquidez y revalidación posterior a latencia. | No cuota mínima de operaciones; todos los rechazos tienen motivo. |
| 9. Ganancias | Protección temprana MFE vigente; `quant-management.js` añade trailing ATR/estructura y break-even plus de USD0,05 para contratos nuevos, más salida por agotamiento confirmado. Time stops propios por plazo. | No aleja stops. Replay compara original, protección temprana, MFE, break-even, 30/30/40 y agotamiento. 30/30/40 no se activa sin validación independiente. |
| 10. Exposición | Presupuesto central, hasta 10 plazas, pirámides ganadoras protegidas de hasta 3 piernas por plazo/movimiento, ejecuciones parciales identificadas. | Plazos distintos no requieren el mismo padre; todos comparten techo correlacionado de BTC. Sin hedge mode ni promediar pérdidas. El scale-in planificado independiente de nuevas confirmaciones no está habilitado. |
| 11. Riesgo | Perfil v2 con ×1/2/3/5/10, menor palanca suficiente, riesgo por stop, límite de margen/exposición, estrés, 3% diario y 10% drawdown desde activación del módulo. | No aumenta riesgo tras pérdidas. Drawdown exige revisión; la supervisión de salidas continúa. |
| 12. IA | Red existente preservada, entrenamiento externo, mínimos de muestras, fallback determinista. Features/régimen/versión de las nuevas operaciones quedan en sus contratos y cierres. | El modelo anterior de 33 features no recibe un dominio incompatible. No hay pesos nuevos entrenados ni probabilidades inventadas. |
| 13. Investigación | `trading-quant-download.py` y `trading-quant-research.mjs`, fuera del EC2 activo, con fuentes/hash, parámetros congelados, baseline, costes, holdout y walk-forward. | Solo datos públicos; escenarios OHLC no certifican fills, cola, funding histórico exacto ni rentabilidad ejecutable. |
| 14. Arquitectura | Ingesta y broker existentes; módulos puros separados para features, estrategias, gestión y evaluación; contratos inmutables, hashes, idempotencia y restauración. | Ningún nuevo escritor ni dependencia. Conserva principal, audiovisual y secretos. |
| 15. Telegram/Mini App | Transporte existente; notificaciones de aperturas/cierres/protección. Panel compacto privado añade 1m, estrategias, riesgo, margen y exposición. | Sin cambios de destinatarios ni bot nuevo. Los errores de estrategia se distinguen de falta de oportunidad. |
| 16. Éxito | Métricas netas por estrategia/régimen/plazo, calidad final, costes, MFE/MAE, drawdown, R y duración. Sharpe/Sortino requieren marcas diarias consecutivas. | No se afirma mejora de rentabilidad sin evidencia posterior. |
| 17. Entrega | Pruebas de regresión externas, migración aditiva, despliegue con copia consistente y verificación de latido, precios y evaluación natural 1m. | Nunca restaura una DB vieja sobre operaciones nuevas; rollback usa el mismo código compatible y `QUANT=OFF`. |

## Parámetros operativos nuevos

- Flags: `LUMI_TRADING_SECONDARY_QUANT=secondary-quant-1.0.0`, riesgo `secondary-risk-budget-2.0.0`, plazos `secondary-timeframes-2.0.0`. Se conserva `secondary-profit-policy-2.0.0`.
- Entrada 1m: contexto 5m; horizonte base 10 minutos, extensión 5, estancamiento 3. No cambia contratos previos.
- Riesgo por pierna: máximo 0,5% de equity y USD10; riesgo por movimiento y dirección BTC: 1% y USD20; cartera: 3% y USD50. Sin crédito al riesgo por ganancias no realizadas.
- Margen ≤50% de equity; exposición bruta ≤3×; hasta 10 plazas. Notional candidato ≤USD600, ≤60% de equity y limitado adicionalmente por ATR, stop, caja y BBO. No busca una ganancia monetaria arbitraria para elegir apalancamiento.
- Ninguna estrategia dispone de probabilidades calibradas. No hay ponderación aprendida ni mayor capital por la última operación ganadora.
- Se conserva el mínimo neto del 0,20% del notional. El experimento de 0,05% en scalping no produjo más operaciones admisibles en esta muestra y no se activó. También se exige R:R neto ≥1 y stop técnico ≤3 ATR.
- Las observaciones OFI de mejor nivel, microprice, CVD y liquidaciones describen solo el flujo recibido, con cobertura incompleta explícita. No activan entradas por sí solas.
- Rechazos idénticos conservan contador por cada cierre pero archivan un registro al cambiar el motivo o por hora; candidatos siempre se registran. Evita crecimiento innecesario de SQLite al añadir 1m y nueve estrategias.

## Margen y liquidación: alcance preciso

Se verifica la tabla pública `marginSchedules.europa.retail` de PF_XBTUSD: primer escalón 10% inicial/5% mantenimiento, siguiente a USD30 millones. Este es un perfil de referencia PAPER elegido explícitamente, no una inferencia sobre la categoría de una cuenta real del usuario. El límite nominal del motor queda muy por debajo del siguiente escalón. Un cambio incompatible en la tabla bloquea nuevas señales hasta revisar el modelo.

El cálculo algebraico usa mark, cantidad, entrada, margen USD aislado, mantenimiento y reserva de comisión de cierre. El funding conocido se descuenta conservadoramente del margen de referencia. Las posiciones virtuales separadas, la cartera real del exchange, sus haircuts, neteo por contrato, comisiones especiales de liquidación y ADL no son idénticos. Por ello la salida se llama **estrés de margen**, y `actual_exchange_liquidation=false`; no se presenta una liquidación real exacta sin esos datos. El stop y el estrés deben quedar antes de la frontera del modelo.

## Investigación reproducible y resultados

Datos públicos descargados: 43.200 velas de 1m (30 días), 17.280 de 5m (60 días), 11.520 de 15m (120 días), 5.760 de 30m, 4.320 de 1h (180 días), 2.190 de 4h (365 días), 500 de 1d. Corte: 2026-11-04 12:00 UTC. No se usan velas futuras para detectar señales.

La evaluación histórica aplica entrada en la siguiente apertura nativa bajo spread/slippage declarados, comisiones taker, funding adverso supuesto y stop primero si una vela toca SL y TP. Son escenarios de sensibilidad, no recibos reales ni reconstrucción tick a tick. Las MAE/MFE de OHLC son límites de vela; no acreditan el orden de sus extremos. Las variantes de salida usan muestras netas y no pueden demostrar qué habría sido ejecutable dentro de la vela.

El informe `QUANT-RESEARCH-2026-11-04.json` contiene resultados por plazo y estrategia. **Ninguna variante reúne condiciones de promoción como rentable**. Las celdas con resultado positivo tienen muestras pequeñas o no sostienen el holdout. La mayor parte de los escenarios netos es negativa. Esto impide prometer mayores ganancias y evita promover automáticamente scale-out, modelos o arbitrajes.

Reproducir fuera del servidor activo:

```bash
python scripts/trading-quant-download.py --output /tmp/lumi-public-history --end 2026-11-04T12:00:00Z
node scripts/trading-quant-research.mjs --data /tmp/lumi-public-history --output /tmp/lumi-quant-research.json
# Sensibilidad predeclarada: no actualiza el motor.
node scripts/trading-quant-research.mjs --data /tmp/lumi-public-history --output /tmp/lumi-quant-cost-sensitivity.json --scalp-net-fraction 0.0005
```

Se necesita una muestra prospectiva nueva e independiente para cualquier ajuste posterior a esta inspección. El holdout ya observado no puede reutilizarse para afirmar una mejora nueva. Los gates exigen tamaño muestral, intervalo de expectativa positivo, estabilidad walk-forward, costes adversos y datos de ejecución; nunca publican un modelo automáticamente.

## Fuentes primarias consultadas

- Kraken API, velas de futuros: https://docs.kraken.com/api/docs/futures-api/charts/candles
- Kraken API, ticker y precios: https://docs.kraken.com/api/docs/futures-api/websocket/ticker
- Kraken API, instrumentos: https://futures.kraken.com/derivatives/api/v3/instruments
- Kraken, comisiones: https://www.kraken.com/it/pro/fees
- Kraken, margen EEA: https://support.kraken.com/it/articles/derivatives-margin-schedule-and-maximum-leverage-eea
- Kraken, contrato lineal EEA: https://support.kraken.com/articles/perpetual-contract-specifications-for-clients-in-the-eea
- Cont, Kukanov y Stoikov, *The Price Impact of Order Book Events* (2010): https://arxiv.org/abs/1011.6402 — investigación sobre renta variable, no prueba de ventaja en BTC.
- Bailey, Borwein, López de Prado y Zhu, *The Probability of Backtest Overfitting* (2015): https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253
- Bailey y López de Prado, *The Deflated Sharpe Ratio* (2014): https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551
