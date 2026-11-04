# Observación causal de regímenes de mercado — Lumi Trading PAPER

Versión experimental: `secondary-market-regime-observation-1.0.0`.
**No habilita señales, estrategias, entradas, cierres, tamaño ni apalancamiento nuevos.**

## Propósito

Añadir diagnóstico reproducible a los cuatro plazos de entrada ya activos en el
código del futuro lineal `PF_XBTUSD`: **5m, 15m, 1h y 4h**.
No existe un contrato operativo nuevo de **1m** para este motor; la tarjeta spot
histórica de 1m no se interpreta como prueba de entradas de futuros en 1m.
Se preserva la continuidad del contrato de riesgo, protección de beneficio,
persistencia, ledger, outbox y Mini App.

Los resultados se guardan en `secondaryExecution.timeframe_execution.frames[tf].last_regime`
**solamente cuando se completa una evaluación causal**; el monitor de la
secundaria los proyecta como `secondary_activity.frames[tf].market_regime`.
Se etiquetan `advisory_only=true` y `statistically_validated=false`. No se
añade un filtro de admisión. No se atribuyen ganancias a esta entrega.

## Datos y condiciones de validez

- Velas del contrato de futuros, cerradas no después del corte temporal;
  observaciones no disponibles al decidir quedan excluidas.
- La última vela debe terminar exactamente en el corte del plazo.
- Al menos 64 velas contiguas, OHLC numéricos coherentes y volumen no negativo.
- EMA 9, 21 y 50; EMA 200 sólo cuando hay al menos 200 velas.
- ATR 14, ADX/DMI 14 con suavización de Wilder, pendiente EMA21
  normalizada por ATR y tres velas, eficiencia de recorrido 20,
  VWAP/volumen relativo 20 y ratio de expansión de ATR.
- Spread observado únicamente si el bid/ask de `PF_XBTUSD` es válido y reciente.
- Sin datos fiables: `UNKNOWN` con motivo, en lugar de inferir un régimen.

## Etiquetas exclusivas y precedencia heurística

`ILLIQUID` (spread observado mayor de 8 puntos básicos),
`BREAKOUT_EXPANSION` (rotura de 20 velas con volumen, ADX y rango),
`HIGH_VOLATILITY` (ATR actual / anterior al menos 1,65),
`VOLATILITY_COMPRESSION` (ATR actual / anterior como máximo 0,65),
`UPTREND`, `DOWNTREND` (EMAs alineadas, DMI, pendiente y ADX),
`RANGE` (ADX bajo y eficiencia reducida), `UNDETERMINED`.

Umbrales y prioridades son **hipótesis fijadas para diagnóstico**, no
límites científicos ni parámetros optimizados. El spread no disponible
no prueba liquidez suficiente. Un régimen identificado no demuestra
rentabilidad de ninguna estrategia.

## Verificación y límites

`test/secondary-market-regime.test.js` cubre tendencias, ausencia de
look-ahead, velas tardías y abiertas, series discontinuas, spread excesivo
y volumen nulo. Las pruebas con datos construidos sólo prueban lógica
funcional, no ventaja, exactitud empírica ni estado del worker AWS.

Antes de cualquier uso para seleccionar estrategias, registrar matriz de
confusión/estabilidad por régimen, cobertura, costes y PnL prospectivo,
comparar con baseline sin clasificador y aplicar walk-forward por movimiento.
No entrenar ni activar filtros nuevos mediante el worker operativo.

**Despliegue:** rama aislada para revisión. No publicar en el worker sin verificar
estado real, commit, heartbeat, ventanas por plazo, saldo, posiciones,
outbox y tests completos. No fusionar con `main` ni tocar Lumi audiovisual.
