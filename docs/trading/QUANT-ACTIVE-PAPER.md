# Perfil PAPER activo y tomas parciales

Alcance: secundaria `FREQUENT_PAPER`, PF_XBTUSD, capital finito existente. No órdenes reales, cambios de cartera principal ni aprendizaje automático con autoridad de ejecución.

Activación explícita: `LUMI_TRADING_SECONDARY_ACTIVE=secondary-active-paper-1.0.0`, junto con riesgo `secondary-risk-budget-3.0.0`, motor cuantitativo y oportunidades activos. Los contratos anteriores conservan sus reglas. `OFF` detiene la admisión nueva de este perfil, sin cambiar las salidas de posiciones ya ejecutadas bajo él.

## Admisión

| Control | Anterior | Perfil activo |
|---|---:|---:|
| Relación neta TP/pérdida al stop mínima | 1 | 0,8 |
| Máxima distancia al stop estructural | 3 ATR | 4 ATR |
| Volumen relativo para reversión/rango | 0,8 | 0,25 |
| Volumen relativo para continuación/retest | Dependiente del régimen | Hasta 0,35 |
| Riesgo máximo por entrada | 0,5% / 10 USD | 1% / 20 USD |
| Riesgo agregado por dirección BTC | 1% / 20 USD | 2% / 40 USD |
| Riesgo total máximo | 3% / 50 USD | 5% / 75 USD |
| Referencia máxima de exposición inicial | 600 USD | 1.000 USD |

Siempre se aplica el menor límite y la cantidad se redondea hacia abajo. Se conserva la reserva para cinco temporalidades: con equity de 1.000 USD, el presupuesto inicial por plazo/dirección es como máximo 4 USD (0,4%), no 10 USD. La volatilidad, el margen y la liquidez pueden reducirlo más. Cinco plazos no son cinco activos diversificados. Hasta diez posiciones/órdenes; ampliaciones de una misma tendencia requieren confirmación nueva y posición inicial favorable/protegida. Sin multiplicador después de pérdidas.

La relajación de `ERRATIC` a admisión de rango exige ADX local menor que 25, eficiencia hasta 0,4 y pendiente normalizada absoluta hasta 0,15. Se mantiene el veto ante tendencia fuerte del contexto, la confirmación de rechazo real y los niveles estructurales. Momentum/expansión conservan sus confirmaciones fuertes propias. No se inventan objetivos más lejanos ni patrones para aumentar el conteo.

Se conservan datos frescos, spread máximo, costes/funding, validación posterior a latencia, lotes, margen agregado máximo del 50%, exposición bruta de 3×, stop original y frenos diarios del 3% / drawdown del 10%. El apalancamiento se elige entre 1/2/3/5/10 según restricciones; no se sube para alcanzar un beneficio arbitrario.

## Parciales operativos

Solo los planes nuevos con contrato activo pueden reducir voluntariamente exposición:

1. Hasta el 30% de la cantidad inicial cuando el neto de liquidación, normalizado a la cantidad inicial, alcanza el mayor de 0,40 USD y 0,25 del riesgo inicial.
2. Hasta otro 30% cuando alcanza el mayor de 0,80 USD y 0,50 del riesgo inicial.
3. El remanente conserva la protección neta y el trailing ya existentes. Por redondeo o falta de liquidez, puede ser más del 40%.

Cada fragmento debe aportar al menos 0,10 USD netos estimados después de costes, tener funding conocido y tamaño válido. No hay autoridad sobre contratos anteriores. Estos parámetros son una prueba prospectiva PAPER autorizada, no una mejora de rentabilidad validada; la restricción de parciales del contrato base sigue vigente para contratos sin este añadido.

La orden tiene latencia y vida máxima de cinco segundos. La primera cotización ejecutable permite un solo intento: se cancela el remanente IOC, incluso si no hubo liquidez para ningún fill. No persigue liquidez en cotizaciones posteriores. Si no llega una cotización ejecutable antes del vencimiento, se cancela al recuperar los datos. Una etapa cancelada no se reintenta ni habilita la siguiente. Solo dos etapas durables por posición, identificadas de forma determinista y verificadas al reiniciar.

El stop, el estrés de margen, el piso neto protegido, el trailing técnico, los plazos de salida y los cierres manuales tienen prioridad. Si el neto se deteriora antes de ejecutar, se cancela la toma parcial. No se alejan stops ni se garantiza que un beneficio observado termine realizado.

Contabilidad por fragmento: cantidad, margen liberado, comisión de entrada atribuida, comisión de salida, funding y neto. Una posición se cuenta cerrada una sola vez cuando se liquida todo; cerrar una no cierra otras. Telegram informa del fragmento y de la cantidad restante. El monitor publica el estado de ambas etapas.

## Evidencia reproducible

`node --test test/secondary-quant.test.js` incluye latencia, reinicio, corrupción de estado, redondeo, expiración, liquidez parcial, prioridad del piso protegido, reconciliación de caja/neto y cinco posiciones simultáneas independientes.

`node scripts/trading-quant-active-research.mjs --data <velas> --output <informe.json>` compara reglas fijas sobre siete días de velas reales, con separación temporal de cinco y dos días, fuera del worker. Supone spread de 1 pb y funding adverso de 0,3 pb/h. No simula fills ni rentabilidad. Las fechas ya fueron inspeccionadas antes: no constituyen validación independiente fuera de muestra. Las tomas parciales necesitan resultados prospectivos con cotizaciones reales.

Más candidatos y mayor pérdida permitida no demuestran expectativa positiva. Una relación neta de 0,8 necesita más de 55,6% de aciertos si todos los resultados fueran exactamente +0,8R/−1R; los parciales y salidas dinámicas cambian esa distribución.
