# Continuación de implementación cuantitativa

Base: `4eda74c73da3830377cde8ca9833bfda65b1dc3c`. Alcance exclusivo de la secundaria PAPER; ninguna orden real, alta de capital, credencial o componente audiovisual.

## Correcciones operativas

- El broker solo liquida la instancia vigente de una posición. Reintentos con una referencia cerrada o anterior a la recuperación no vuelven a acreditar saldo.
- El estrés de margen por mark tiene prioridad sobre una salida discrecional pendiente. Conserva la latencia ya iniciada y la separación entre posiciones.
- MFE/MAE netos incluyen el neto ya realizado más la liquidación neta del remanente. Una reducción de cantidad no se interpreta como una pérdida de mercado.
- Las evaluaciones visibles incluyen solo patrones activos del último cierre evaluado. Se conservan los registros anteriores sin presentarlos como actuales.
- La vista de operaciones transmite `result_final`, `funding_complete` y el neto de la conciliación de funding más reciente. Conserva la fecha y motivo del cierre original.
- El drawdown de cierres usa el orden temporal; Calmar usa rentabilidad geométrica y drawdown de la misma serie diaria. Datos vacíos, booleanos o no finitos no se convierten en resultados financieros.

## Cierres parciales y entradas escalonadas

`QuantResearchBroker` hereda el broker existente y siempre copia el estado recibido. Rechaza ejecutarse donde existe el entorno del worker y no envía notificaciones. Las reducciones reutilizan la contabilidad decimal, BBO, latencia, capacidad compartida, funding y recibos de ejecución del motor. El reparto 30/30/40 redondea a lotes sin aumentar la cantidad total; un IOC cancela el remanente no ejecutado. Los identificadores de solicitud impiden duplicados. Una salida obligatoria prevalece sobre el experimento.

El planificador de scale-in reserva desde el principio el riesgo y la caja de todas las piernas. No añade riesgo tras una pérdida; exige nuevas confirmaciones y revalidación por el broker. No basta con que el planificador acepte una pierna para abrirla.

Estas capacidades se verifican con regresiones de ejecución, pero **no habilitan una política automática nueva**. El replay previo no demostró ventaja de 30/30/40. Los escenarios OHLC no pueden sustituir un replay de cotizaciones para probar liquidez, latencia o el orden de los extremos.

## Modelo cuantitativo externo

Ejecutar fuera del servidor operativo:

```bash
node scripts/trading-quant-meta.mjs --events /ruta/privada/cierres.json --output /ruta/privada/meta-evaluacion.json
```

Entrada: eventos CLOSED de secundaria PAPER con contrato cuantitativo íntegro, timestamps causales, funding final, calidad OBSERVED y sin intervención manual ni huecos de datos. Duplicados idénticos se excluyen; etiquetas incompatibles para un mismo ID abortan la evaluación.

Cada dominio combina estrategia, temporalidad, features y políticas firmadas. Protocolo fijo: al menos 300 observaciones; 60% entrenamiento, 20% calibración y 20% test cronológico; purga de etiquetas solapadas y embargo de una hora; al menos 100/40/50 observaciones por bloque y diez casos de cada clase. Imputación y normalización solo con entrenamiento; indicadores explícitos de ausencia. Regresión logística L2 y calibración Platt se comparan con la probabilidad constante del entrenamiento usando Brier, métricas netas y bootstrap por bloques. El umbral 0,5 no se optimiza sobre test.

El walk-forward repite el protocolo sobre prefijos crecientes del 60%, 80% y 100% del historial, siempre con purga y embargo. Las ventanas insuficientes se declaran como tales; no se imputan resultados. El último bloque y este walk-forward no son réplicas independientes.

Los pesos son artefactos de investigación sin permiso para modificar ejecución, apalancamiento o riesgo. El entrenamiento no es una tarea automática del worker. Se necesita evidencia prospectiva independiente antes de una promoción. La red existente sigue disponible para su dominio original.

La ejecución sobre la evidencia real disponible de la nueva versión devolvió una observación válida y `INSUFFICIENT_DATA`: no produjo un modelo. El resultado de esa operación no prueba rentabilidad.

## Referencias primarias

- Kraken, opciones de orden de derivados: https://support.kraken.com/it/articles/360031471211-derivatives-order-types — IOC ejecuta lo disponible y cancela el resto; reduce-only no incrementa exposición.
- Novy-Marx, *Backtesting Strategies Based on Multiple Signals*: https://www.nber.org/papers/w21329 — combinar y seleccionar señales introduce sesgos de sobreajuste; no valida patrones concretos de BTC.
- Bailey y colaboradores, *The Probability of Backtest Overfitting*: https://escholarship.org/uc/item/4w1110bb — un holdout inspeccionado repetidamente no constituye validación independiente.
