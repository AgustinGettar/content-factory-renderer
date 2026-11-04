# Diccionario y capacidad del motor PAPER

Este diccionario describe conceptos; no convierte su nombre en un indicador disponible ni en una ventaja estadística. El contrato operativo es un futuro perpetuo lineal BTC/USD PF_XBTUSD, con USD ficticios y posiciones virtuales independientes. No hay órdenes reales, contratos inversos, margen cruzado ni arbitraje entre exchanges. Los datos ausentes se expresan como `null`/`UNAVAILABLE`.

## Mercado y ejecución

| Concepto | Significado y uso |
|---|---|
| Spot | Compra/venta del activo al contado; sus velas no sustituyen las del futuro. |
| Futures / perpetual futures | Derivado con vencimiento / sin vencimiento; el perpetuo utiliza funding para aproximarse al índice. |
| Contrato lineal / inverso | PnL proporcional a diferencia de precios en moneda cotizada / diferencias de precios recíprocos en moneda base. Lumi usa exclusivamente el primero. |
| Margen inicial / mantenimiento | Colateral para abrir / mínimo para conservar la exposición. No equivalen a pérdida al stop. |
| Aislado / cruzado | Colateral reservado a una posición / compartido por la cuenta. Lumi modela USD aislados por posición virtual; no replica una cuenta real de Kraken con neteo por contrato. |
| Mark / index / last | Precio de riesgo / referencia compuesta / última operación. La valoración de salida usa bid/ask; la referencia de liquidación usa mark disponible. |
| Bid / ask / spread | Mejor compra / mejor venta / diferencia entre ambas. Un long sale por bid y un short por ask. |
| Order book / profundidad / liquidez | Órdenes disponibles por nivel / volumen a distintas distancias / capacidad de ejecutar. Lumi observa BBO; no inventa profundidad L2. |
| Slippage | Diferencia adversa respecto al precio de referencia. Si está incorporada al fill, no se resta otra vez del PnL. |
| Maker / taker | Provee liquidez pasiva / cruza contra liquidez disponible. Comisiones y condiciones de fill diferentes. |
| Funding rate | Transferencia periódica entre largos y cortos; el crédito recibido aumenta el neto. La admisión puede reservar una estimación adversa. |
| Open interest | Contratos abiertos agregados; no es volumen negociado. Solo se muestra cuando existe dato público válido. |
| Basis / contango / backwardation | Diferencia futuro–referencia / futuro por encima / por debajo. No constituye arbitraje sin costes y dos piernas ejecutables. |
| Liquidación / ADL | Cierre por insuficiencia de margen / desapalancamiento de contrapartes del exchange. Lumi usa una referencia explícita; no simula colas reales de ADL. |
| Reduce-only / post-only | Solo reduce exposición / solo acepta ejecución pasiva. Nunca son equivalentes. El broker impide sobrecerrar una posición y respeta post-only. |
| Market / limit | Ejecutar contra liquidez actual / exigir un precio límite. Una señal no es un fill. |
| Stop-market / stop-limit | Disparador que solicita mercado / límite. El segundo puede no ejecutarse; Lumi no garantiza stops. |
| Trailing stop | Umbral que acompaña un movimiento favorable y no se aleja para aumentar pérdida. |
| OCO | Una ejecución cancela la orden alternativa. No se presupone una OCO real del exchange en PAPER. |
| Partial fill / latency / cancel-replace | Ejecución parcial / demora entre decisión y ejecución / cancelar y sustituir conservando identidad y reservas. |

## Estructura e indicadores

| Concepto | Significado y límites |
|---|---|
| Long / short | Exposición que gana con subida / bajada, antes de costes. |
| Tendencia / rango | Desplazamiento direccional persistente / oscilación local entre extremos. |
| Impulso / retroceso / pullback | Avance direccional / corrección / retorno a una zona antes de eventual continuación. El contacto solo no confirma entrada. |
| Breakout / breakdown / retest | Ruptura superior / inferior / comprobación posterior del nivel roto. |
| Soporte / resistencia | Zonas de rechazo observadas; no barreras garantizadas. |
| HH / HL / LH / LL | Máximo creciente / mínimo creciente / máximo decreciente / mínimo decreciente. Los pivotes requieren barras posteriores de confirmación ya cerradas. |
| BOS / CHoCH | Ruptura de estructura / cambio de carácter respecto a la estructura previa; no se marca un pivote usando futuro aún desconocido. |
| Barrido / falsa ruptura | Cruce de un extremo seguido de recuperación / fallo de continuidad. Requiere rechazo y contexto; no todo barrido revierte. |
| Consolidación / compresión / expansión | Pausa local / disminución / aumento del rango o volatilidad. |
| SMA / EMA / WMA | Media simple / exponencial / ponderada. EMA 9/21/50/200 no se sustituye por cero si falta historia. |
| VWAP / anchored VWAP | Precio típico ponderado por volumen / desde un ancla declarada. VWAP de velas aproxima el de trades; un ancla incompleta permanece no disponible. |
| RSI / Stochastic / CCI | Osciladores de fuerza relativa / posición dentro del rango / desviación del precio típico. Sobrecompra no implica venta automática. |
| MACD | Diferencia EMA12–EMA26, señal EMA9 de la diferencia e histograma. |
| ATR | Suavizado de Wilder del máximo de rango y saltos contra cierre anterior. Mide amplitud, no dirección. |
| ADX / DMI | Fuerza direccional / componentes +DI y −DI suavizados. ADX alto por sí solo no indica long. |
| Bollinger / Keltner / Donchian | Bandas de desviación estándar / ATR alrededor de media / máximos y mínimos de ventana. |
| Supertrend | Régimen derivado de bandas ATR con cambios de lado. No es un stop garantizado. |
| Ichimoku | Conjunto de puntos medios y desplazamientos de representación. Los spans calculados hoy no se convierten en datos futuros observados. |
| OBV / MFI | Volumen acumulado con signo del retorno / flujo monetario del precio típico. |
| Volumen relativo | Volumen actual respecto a una referencia de barras anteriores. |
| Perfil de volumen / POC / VAH / VAL | Histograma de volumen por precio / nivel modal / límites alto y bajo del área de valor. Requiere trades por precio; no se inventa con una vela OHLC. |
| Pivotes | Extremos confirmados o niveles de sesión calculados con datos anteriores; se distingue su definición. |

## Gestión, evaluación y estrategias

| Concepto | Definición |
|---|---|
| Position sizing / risk per trade | Cantidad calculada desde la pérdida adversa al stop, comisiones, funding y estrés / presupuesto por entrada. |
| Portfolio heat | Suma de pérdidas presupuestadas de posiciones y órdenes pendientes; se contabilizan sus cantidades restantes. |
| Drawdown | Caída desde el máximo de equity; se distingue la curva marcada de la basada solo en cierres. |
| MAE / MFE | Peor / mejor excursión observada durante la posición; las cotizaciones muestreadas no prueban ejecución a ese precio. |
| R-multiple | Neto realizado dividido por riesgo inicial. |
| Expectancy | Media de netos; también P(ganar)×ganancia media − P(perder)×pérdida media. |
| Profit factor | Suma de netos positivos / valor absoluto de netos negativos. Sin pérdidas muestrales, se declara indefinido en lugar de certeza. |
| Win rate / payoff ratio | Proporción de operaciones positivas / ganancia media dividida por pérdida media absoluta. |
| Sharpe / Sortino | Retorno medio sobre volatilidad total / desviación bajista, con intervalos consistentes. No se anualizan trades como si fueran días. |
| Calmar / recovery factor | Retorno anualizado sobre drawdown máximo / beneficio neto sobre caída máxima en dinero. |
| Break-even / break-even plus | Precio que cubre todos los costes / que además deja el margen neto declarado. |
| TP / SL | Objetivo de beneficio / invalidación de pérdida. Un objetivo no predice que el precio lo alcance. |
| Scale-in / pyramiding | Fraccionar una entrada planificada / añadir una nueva confirmación favorable a una posición ganadora protegida. No equivalen a promediar pérdidas. |
| Scale-out | Reducir una fracción, conservando contabilidad proporcional y sin cerrar posiciones ajenas. Los candidatos 30/30/40 se comparan en replay y no tienen promoción automática. |
| Hedging | Exposiciones opuestas; puede añadir costes sin ventaja. No está habilitado en el modelo operativo actual. |
| Scalping / momentum | Captura de movimientos breves / aceleraciones confirmadas. El neto y la liquidez deciden la admisión. |
| Trend following / continuación | Seguir dirección confirmada / reanudarla después de pausa o retroceso. |
| Mean reversion / range trading | Retorno hacia referencia / operar extremos de un rango con invalidación. Bloqueados ante tendencia contraria fuerte. |
| Breakout / volatility breakout | Ruptura de estructura / ruptura acompañada por expansión tras compresión. |
| Swing trading | Exposición a movimientos de mayor duración; horizonte y financiación propios de 1h/4h. |
| Grid / market making | Rejilla de órdenes / provisión bilateral de liquidez. Sin inventario, cola y selección adversa validados permanecen sin autoridad. |
| Statistical arbitrage | Relaciones estadísticas entre activos o contratos; requiere series compatibles y estabilidad fuera de muestra. |

## Matemáticas y aprendizaje

Pendiente: regresión de log-precios por unidad de tiempo, normalizada por ATR/precio. Ángulo: `atan(pendiente normalizada)`, independiente de los píxeles del gráfico. Seno y coseno codifican hora/día UTC; no predicen por sí mismos.

Correlación y covarianza describen dependencia; abrir distintos plazos de BTC no crea diversificación independiente. Los cuantiles e intervalos mediante bootstrap por bloques conservan parte de la dependencia temporal; no corrigen mágicamente la elección de muchas estrategias. Las hipótesis y parámetros se congelan antes de evaluar. El walk-forward purga etiquetas solapadas y aplica embargo. El holdout inspeccionado ya no puede reutilizarse como nueva prueba independiente tras ajustar parámetros.

Probabilidad condicional, inferencia bayesiana y redes neuronales son hipótesis/modelos, no porcentajes inventados. La calibración compara probabilidades contra frecuencias observadas y Brier. Sin modelo calibrado, probabilidad = `null`. La red existente conserva su dominio y su mínimo de datos; las estrategias nuevas registran sus propios features y resultados sin introducirlos en un modelo incompatible. Entrenamiento y simulaciones ocurren fuera del worker; ninguna salida de investigación cambia automáticamente riesgo, ejecución o apalancamiento.

Estacionariedad y volatilidad condicional necesitan pruebas/modelos temporales independientes. El régimen determinista de Lumi no se presenta como prueba ADF ni como GARCH entrenado. Monte Carlo/bootstrap estudian sensibilidad de trayectorias; costes, slippage, funding y escenarios de estrés permanecen explícitos.
