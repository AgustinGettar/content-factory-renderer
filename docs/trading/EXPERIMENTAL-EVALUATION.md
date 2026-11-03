# Evaluación prospectiva de la secundaria PAPER

Protocolo: `secondary-prospective-evaluation-1.0.0`.
Preparado el **2026-11-03 a las 16:17:48 UTC** — 17:17:48 Europe/Rome.
Ámbito: `FREQUENT_PAPER`, estado `KRAKEN_BTCUSD_PAPER`, contrato `PF_XBTUSD`.

Este documento fija qué se medirá y cómo se distinguirán pruebas funcionales,
reconstrucciones históricas y observación prospectiva. No contiene resultados de
rendimiento, certifica un entrenamiento ni afirma ventaja estadística. La fecha
de preparación no se atribuye retrospectivamente a operaciones anteriores: el
conjunto prospectivo comienza después del registro verificable de este protocolo
y de la activación efectiva de cada política. Todo caso anterior queda como
diagnóstico histórico, aunque haya motivado el cambio.

## Preguntas y versiones separadas

La pregunta principal es si se conserva más beneficio neto realizado sin que el
cierre prematuro de movimientos favorables, los costes o las pérdidas compensen
esa mejora. La proporción de aciertos no es el objetivo de optimización.

Se mantienen tres entregas y dominios de comparación distintos:

1. Protección `secondary-profit-policy-2.0.0`, entrada
   `secondary-entry-useful-margin-2.0.0`, salida
   `secondary-net-protection-2.0.0`: protección causal antes del objetivo.
2. Tamaño y ampliaciones `secondary-risk-budget-1.0.0`, ejecución
   `secondary-risk-execution-1.0.0`: riesgo explícito, hasta ×10 y tres tramos.
3. Plazos `secondary-timeframes-1.0.0`: entradas propias de 5m, 15m, 1h y 4h,
   compartiendo cartera y riesgo del movimiento.

Activar las tres no permite atribuir cualquier diferencia exclusivamente a la
protección. Cada fila del análisis conserva versión y hash de entrada, economía,
salida, ejecución, horizonte, tamaño y margen, además del commit efectivo. Los
contratos anteriores conservan su dominio original, aunque cierren después del
despliegue. No se cambia su etiqueta de versión ni se reescribe su resultado.

## Parámetros iniciales congelados

Se usan exactamente los parámetros de los contratos y documentos de estas
entregas. No se barre una grilla de valores ni se cambia el parámetro después de
cada ganancia o pérdida. Una modificación futura necesita versión, motivo y nueva
ventana prospectiva; los resultados del período anterior permanecen publicados.

| Componente | Parámetro inicial |
| --- | --- |
| Economía de entrada | Neto previsto mínimo de 0,20 % del nominal efectivo, con costes y financiación del horizonte firmado |
| Protección temprana | Retroceso proporcional 25 %; piso mínimo inicial 0,05 USD |
| Incertidumbre adicional de protección | Máximo de 1 punto básico del precio de entrada y medio spread observado, multiplicado por cantidad |
| Activación | Piso positivo ejecutable; independiente del objetivo estructural y del mínimo económico de entrada |
| Riesgo por tramo | Menor entre 0,5 % del patrimonio de presupuesto y 10 USD |
| Riesgo por movimiento | Menor entre 1 % y 20 USD |
| Riesgo de cartera | Menor entre 3 % y 50 USD |
| Margen / exposición bruta | Máximo 50 % / 3 veces el patrimonio de presupuesto |
| Estrés de ejecución para tamaño | 5 puntos básicos del nominal; separado de los costes realizados |
| Apalancamiento | Menor entre 2, 5 y 10 que financie la cantidad admisible |
| Escala | Referencia 300 USD; aspiración de 1 USD neto al objetivo, sin veto de salida |
| Concurrencia | Diez IDs únicos de orden/posición como máximo; inicial y hasta dos ampliaciones por movimiento |
| Capital | Capital existente, sin recargas ni multiplicador de recuperación de pérdidas |

| Entrada / contexto | Base | Extensión máxima | Estancamiento | Total máximo |
| --- | --- | --- | --- | --- |
| 5m / 15m | 30 min | 15 min | 10 min | 45 min |
| 15m / 1h | 90 min | 45 min | 30 min | 135 min |
| 1h / 4h | 6 h | 3 h | 2 h | 9 h |
| 4h / 1 día | 24 h | 12 h | 8 h | 36 h |

La extensión nunca cambia el stop ni se renueva para esperar una ganancia
deseada. Los parámetros, fórmulas y límites operativos completos están en
[EARLY-PROTECTION-2.0.0.md](EARLY-PROTECTION-2.0.0.md),
[RISK-BUDGET-AND-PYRAMID.md](RISK-BUDGET-AND-PYRAMID.md) e
[INDEPENDENT-TIMEFRAMES.md](INDEPENDENT-TIMEFRAMES.md).

## Unidades y ventanas de observación

La unidad contable es el contrato de operación; la unidad de dependencia
estadística es el movimiento. Una orden parcialmente ejecutada y su posición
comparten ID. Tres tramos del mismo movimiento son tres contratos, un grupo de
riesgo y un solo cluster estadístico. Cien fotografías de una operación no son
cien operaciones ni cien etiquetas independientes.

Se emiten cortes descriptivos semanales y un primer informe del período completo
de 28 días desde el inicio prospectivo verificable de cada configuración. Son
fechas de informe, no condiciones para habilitar el simulador, límites diarios
de selección ni una orden de esperar rentabilidad. Se informa lo observado aunque
haya pocas entradas; no se prolonga selectivamente el corte hasta encontrar un
resultado positivo. Los contratos aún abiertos o con financiación pendiente se
cuentan y muestran como censurados o provisionales, sin asignarles un resultado
final imaginario. Las maduraciones posteriores corrigen el estado de evidencia
en una revisión fechada, conservando el informe original.

Los informes muestran operaciones, movimientos, tiempo transcurrido, tiempo con
datos utilizables, exposición, riesgo comprometido y cobertura de cada métrica.
Un período sin una entrada natural de una versión se informa como tal. La
activación de un plazo, una prueba sintética o la publicación de un commit no
cuentan como actividad prospectiva.

## Contabilidad y métricas fijadas

Se concilian recibos de entrada, cierres parciales, cierre final y revisiones de
financiación con el ledger. `CLOSED.pnl` contiene el total acumulado de la
operación: no se suma otra vez a todos sus `PARTIAL_CLOSE.fill_pnl`. Los ajustes
posteriores de financiación se incorporan una vez, por su identidad durable.
Los costes ya incluidos en precios de ejecución no se restan una segunda vez.
Los colchones hipotéticos de protección o estrés no son comisiones pagadas.

| Métrica | Definición y limitación |
| --- | --- |
| Neto realizado después de costes | Suma de resultados definitivos conciliados; los provisionales se muestran aparte |
| Frecuencia | Contratos con al menos un fill y movimientos nuevos por 24 h transcurridas; adicionalmente por hora con datos utilizables y por cierre de vela evaluado |
| Beneficio medio | Media del neto de operaciones definitivas con neto positivo; se informa su cantidad y exposición |
| Pérdida media | Media del neto negativo y de su magnitud absoluta, sin ocultar el peor resultado; ceros aparte |
| Expectativa neta por operación/movimiento | Neto definitivo total dividido por operaciones/movimientos maduros del dominio |
| Drawdown de resultados cerrados | Mayor descenso de la curva acumulada de resultados realizados, en USD y con base de referencia explícita |
| Drawdown marcado de cartera | Sólo el observado con valoraciones válidas y cobertura temporal declarada; no se sustituye por el drawdown de cierres ni se reconstruyen gaps |
| Costes/exposición | Comisiones de entrada y salida y financiación firmada respecto a la exposición de entrada realmente ejecutada; financiación negativa se distingue como crédito |
| Resultado normalizado | Neto y costes por 100 USD de exposición ejecutada y por USD de riesgo al stop con estrés, sin multiplicación adicional por leverage |
| Protección | Activaciones, umbral efectivo, pisos, tiempo hasta activación, salidas por retroceso/estancamiento y extensión usada |
| Desviación de ejecución | Diferencia entre neto observado al disparar y neto de fills posteriores, con latencia, liquidez parcial y gaps identificados |

Los costes de spread y deslizamiento se pueden descomponer para diagnóstico,
pero, cuando están incorporados en los precios, no vuelven a sumarse al total
contable de comisiones/financiación. No se usa el margen como denominador de
retorno para presentar un mayor leverage como mejora de la estrategia.

### Ganancias significativas devueltas

El umbral descriptivo inicial es **máximo neto liquidable observado ≥ 0,40 USD**.
Sólo se reconoce un máximo respaldado por cotización causal fresca de PF_XBTUSD,
lado correcto, cantidad identificable, costes y financiación resueltos y capacidad
de salida compartida suficiente para esa cantidad. Un máximo agregado de
`excursions`, un beneficio bruto, una estimación sin liquidez o el high/low de una
vela no satisfacen esta condición por sí solos.

Para una cantidad constante se conserva P, su primera hora observada y el neto
final conciliado. La métrica principal de devolución significativa es la fracción
de operaciones elegibles cuyo neto final es inferior a
`P − max(0,10 USD, 25 % de P)`. Se informa además, por separado, la fracción que
terminó con neto negativo después de ese máximo. Estos umbrales describen la
hipótesis; no añaden reglas de entrada ni de salida al broker.

Cuando hay cierres parciales, la comparación exige reconciliar lo realizado hasta
cada observación más el neto liquidable del remanente. Si cambió la cantidad o
el coste medio por fills adicionales, se segmenta por base constante y se exige
evidencia suficiente para conciliar el conjunto. Reducir cantidad no se etiqueta
como retroceso de mercado. Si no puede hacerse esta conciliación, el caso queda
fuera de esta métrica, con motivo y cobertura, pero permanece en la contabilidad,
en las pérdidas y en las demás métricas reconstruibles. Una operación cuenta
una sola vez en el denominador, no una vez por máximo o cierre parcial.

El piso es un umbral para solicitar salida. La diferencia entre piso y resultado
ejecutado puede ser negativa por latencia, gaps o liquidez. Nunca se acredita el
piso como ganancia realizada ni se presume que el máximo era capturable.

## Comparación con exposición y condiciones comparables

Se muestran a la vez importes reales y resultados normalizados. La suma de USD
puede subir simplemente porque la nueva política asume más exposición. Esa
diferencia no demuestra mejores entradas ni mejores salidas.

Las comparaciones estratifican por plazo, dirección, patrón, versiones/hashes de
entrada/salida/economía/ejecución, régimen de cantidades y calidad de los datos.
Se separan perfiles ×2 históricos de nuevos contratos de riesgo y se conserva el
apalancamiento efectivo de cada uno. Para comparaciones de cohortes de entradas
se mantiene el requisito documentado de exposición comparable dentro del 1 %;
si no hay suficientes pares o cohortes no se amplía esa tolerancia después de
ver el resultado. Se informa falta de comparabilidad.

La comparación de períodos no aleatorizados es observacional: cambios de mercado,
mezcla de señales y disponibilidad de datos pueden explicar diferencias. No se
reconstruye una operación v1 ficticia en el saldo ni se supone que v1 y v2 habrían
recibido los mismos fills. Se presenta qué variables cambiaron conjuntamente.

Los cierres manuales se incluyen en saldo y resultados de la cuenta y se separan
del subconjunto autónomo. Conservan identidad, importe y motivo de exclusión. No
se vuelven a acreditar ni se atribuyen a una decisión del sistema. Tampoco se
eliminan pérdidas, cierres ambiguos o financiación pendiente para mejorar una
tasa de aciertos: su estado y su impacto contable permanecen visibles.

## Actividad, rechazos y datos faltantes

Por plazo se cuentan por separado cierres naturales esperados, evaluaciones
válidas, intentos técnicos, bloqueos transitorios recuperados, evaluaciones
perdidas, candidatos, órdenes seleccionadas, entradas con fill y cierres maduros.
Los rechazos se agrupan por patrón ausente, costes, confirmación repetida,
capital/riesgo/margen, liquidez, datos y plazo no operativo, conservando el motivo
exacto. Un mismo cierre reintentado no se contabiliza como varias oportunidades
independientes. La ausencia de datos lentos no se imputa como pérdida o rechazo
económico de una señal rápida que sí pudo evaluarse.

Se publican los denominadores y exclusiones de cada estadística. Si no existe
serie durable suficiente para una reconstrucción, se declara `NO_RECONSTRUIBLE`;
no se rellena con velas spot, interpolación entre OHLC ni trayectorias inventadas.
La vista recortada del monitor sirve para presentar estado, no como dataset.

## Dependencia temporal y entrenamiento

`movement_id` reúne los nuevos tramos correlacionados; los dominios históricos
mantienen sus identificadores originales. Ningún movimiento puede quedar a ambos
lados de una separación entrenamiento/validación. También se excluyen intervalos
de exposición o etiquetado solapados y se aplica una purga no menor al horizonte
máximo de los dominios comparados: 45 min en 5m, 135 min en 15m, 9 h en 1h y 36 h
en 4h. Un estudio mezclado usa el máximo pertinente, no la purga corta de 5m.

Los intervalos o errores estándar deben respetar grupos y dependencia temporal;
un cálculo que trate todos los tramos o snapshots como independientes se rechaza.
Los reportes iniciales son descriptivos. Una futura prueba confirmatoria debe
fijar método, comparaciones y umbrales antes de usar su propio período final; no
reutilizar una ventana inspeccionada como evidencia final de una versión ajustada.

Los mínimos del entrenador de entradas siguen intactos: **128 etiquetas maduras
y 32 movimientos para arrancar**, y **64 etiquetas maduras nuevas** para un lote
posterior. Las fotografías de salida y fragmentos no satisfacen esos mínimos.
La calibración, validación final y controles de autoridad adicionales de
[NEURAL-TRAINER.md](NEURAL-TRAINER.md) siguen vigentes. No se rebaja ninguno para
producir un checkpoint ni se reutiliza automáticamente el modelo de 5m en 4h.

## Asesor de salidas sin autoridad

El asesor de salida permanece **COLLECTING/ADVISORY, autoridad NONE, modelo
ausente y cero actualizaciones de gradiente** mientras no exista una entrega
externa verificable distinta. Su captura causal no equivale a entrenamiento y no
cambia la autoridad actual de la red de entradas.

Las acciones que se investigan son conservar con stop/plazo firmados, proteger
con la regla firmada y solicitar cierre respetando la latencia contractual. Las
variables de decisión sólo usan lo observado hasta ese instante: N, máximo causal,
retroceso, edad, volatilidad/momentum pasados, spread/liquidez, financiación,
protección y acción. Una etiqueta posterior nunca entra en esas variables.

La comparación requiere evidencia de mercado posterior separada, con cotizaciones,
cantidades, financiación y tiempos suficientes para sustentar el protocolo de
ejecución de cada escenario. Después de cerrar una operación, ese seguimiento no
es una posición, no consume ni añade saldo real del simulador y no constituye una
ejecución realmente observada del bot. Si faltan datos para sustentar un escenario,
su etiqueta queda ausente y reduce cobertura; no se inventa un retorno ni se
convierte el máximo futuro en beneficio conocido o capturable. Las fotografías
compactas por sí solas no garantizan esa reconstrucción.

Cualquier ensayo externo conserva un registro propio de consumo de liquidez por
escenario, evitando reutilizar el mismo volumen para varias órdenes de ese
escenario. Sus resultados se identifican como simulaciones condicionadas a datos
observados, separados del ledger y de la actividad natural. La investigación no
modifica los contratos abiertos ni permite bajar pisos, ensanchar stops o exceder
presupuestos.

## Evidencia, privacidad y estado de entrega

Se registra hora UTC y se presenta Europe/Rome sin ambigüedad, commits inicial y
final, política realmente activa, contratos preservados, conteos naturales por
plazo, exclusiones y recursos usados. Pruebas sintéticas, reconstrucciones posibles
y observaciones del worker ocupan secciones distintas. Un commit no es despliegue;
un despliegue no es una entrada; un caso ganador no demuestra rentabilidad.

La exportación se realiza con el exportador compatible y lectura transaccional
que incluye WAL, sin copiar SQLite ni usar la vista del panel como dataset. Datos,
checkpoints y pesos permanecen privados y se verifican con SHA-256. Entrenamiento,
backtests y dependencias ML corren exclusivamente fuera de EC2. Si falta capacidad
de transferencia privada o entrenamiento, se informa esa parte bloqueada y la
protección determinista continúa. No se sustituyen esos trabajos por entrenamiento
en el worker ni se promete trabajo en segundo plano.
