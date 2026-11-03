# Entradas independientes PF_XBTUSD — secundaria PAPER

Versión: `secondary-timeframes-1.0.0`. Parámetros fijados antes de observar resultados.

## Alcance

La secundaria operativa anterior evaluaba **5 minutos**, usando **15 minutos**
como contexto. Las tarjetas históricas de 1 minuto, 1 hora y 4 horas provenían
del motor spot anterior; no acreditaban nuevas entradas del contrato de futuros.
Esta versión añade entradas independientes de 15 minutos, 1 hora y 4 horas al
mismo worker, broker, ledger `FREQUENT_PAPER`, SQLite y outbox. No activa entradas
nuevas de 1 minuto ni cambia la principal.

Activación explícita, conjuntamente con contratos de protección v2:

```
LUMI_TRADING_SECONDARY_TIMEFRAMES=secondary-timeframes-1.0.0
```

La instalación es aditiva e idempotente. No cambia saldos, aportes, contratos
pendientes ni posiciones. `OFF` detiene solamente estas nuevas entradas; las
posiciones siguen su contrato y las reglas de 5 minutos permanecen disponibles.
Los períodos históricos se usan para indicadores; nunca generan ejecuciones
retrospectivas. Al activar se espera el siguiente cierre natural. En un reinicio,
los cursores persistidos impiden duplicar una evaluación consumida.

## Fuentes y horizontes

Se usa el endpoint público **trade** del contrato **PF_XBTUSD**:
`https://futures.kraken.com/api/charts/v1/trade/PF_XBTUSD/{resolution}?count=256`.
Las resoluciones de horas son `1h` y `4h`, y el contexto diario es `1d`; no son
`60m`/`240m`. El endpoint y sus resoluciones están documentados en
[Kraken Market Candles](https://docs.kraken.com/api/docs/futures-api/charts/candles).
No se sustituyen series ausentes por BTC/USD spot.

| Entrada | Contexto cerrado | Horizonte base | Extensión máxima | Estancamiento | Límite total |
| --- | --- | --- | --- | --- | --- |
| 5 m | 15 m | 30 min | 15 min | 10 min | 45 min |
| 15 m | 1 h | 90 min | 45 min | 30 min | 135 min |
| 1 h | 4 h | 6 h | 3 h | 2 h | 9 h |
| 4 h | 1 día | 24 h | 12 h | 8 h | 36 h |

El horizonte base corresponde a seis velas de entrada; la extensión máxima,
a tres; el estancamiento, a dos. Es una política de investigación con duración
acotada, no un óptimo estimado. Los contratos de salida firman estos valores y
la economía reserva financiación para el horizonte máximo. La extensión sigue
las condiciones de progreso/protección de la política de salida; no se renueva
por no alcanzar una ganancia deseada.

Cada serie requiere al menos 64 velas cerradas contiguas, conserva como máximo
256, valida OHLC/volumen, corte temporal y disponibilidad previa a decidir. El
historial se obtiene al iniciar y se refresca cuando corresponde un nuevo cierre;
no se descarga el historial de 4 horas cada vez que cierra una vela de 5 minutos.
Cada respuesta registra `available_at`. Una vela abierta o recibida después del
momento de evaluación no puede cambiar esa decisión.

## Cursores y recuperación

Cada plazo conserva `last_cutoff`, decisiones por patrón, última evaluación,
última evaluación completa, último bloqueo y contadores propios. La ventana
permite decidir entre 2 y 30 segundos después del cierre, igual que la operativa
anterior. Un problema técnico se puede reintentar dentro de esa ventana:

- `TRANSIENT_BLOCKED`: todavía no se consumió el cierre; registra el motivo.
- `RECOVERED`: el mismo cierre obtuvo los datos necesarios y se evaluó una vez.
- `COMPLETE`: evaluación completa; puede no existir patrón u oportunidad admisible.
- `MISSED`: la ventana terminó sin evaluación válida; no se fabrica una entrada.

Los contadores separan intentos bloqueados, cierres recuperados y cierres perdidos.
Los motivos no se reinterpretan como pérdidas monetarias. Una vela de 5 minutos
no consume el cursor de 1 hora o 4 horas. En cierres simultáneos el orden fijo es
4 h → 1 h → 15 m → 5 m. Todas las admisiones reservan capital en el mismo broker;
la política de riesgo agrupa exposiciones correlacionadas, sin fingir cuatro
carteras independientes.

Los fallos de una serie permanecen en `frame_errors[tf]`: un error del contexto
diario impide evaluar la entrada de 4 horas, pero permite las entradas de 5/15
minutos que tengan sus propios datos completos. Instrumento, financiación actual
y cotización ejecutable siguen siendo controles comunes. Las salidas se revisan
**en cada tick del worker con cotizaciones recientes**, antes de cualquier reloj
de entrada; nunca esperan al próximo cierre de 4 horas.

## Identidad, ampliaciones y aprendizaje

Las nuevas identidades incluyen versión, plazo, patrón y corte; las confirmaciones
causales incorporan el plazo y su versión. Leer dos veces el mismo evento o
simplemente avanzar una vela no crea una nueva confirmación. Las ampliaciones
se someten además a la política de riesgo/movimiento: este módulo no elimina
`DUPLICATE_SIGNAL`, no aumenta la cantidad de un contrato previo y no financia
otra entrada con un beneficio no realizado.

La red de entradas actual conserva su dominio 5 m/15 m. Los demás plazos declaran
`TIMEFRAME_NOT_IN_NEURAL_DOMAIN`; no ejecutan sus pesos ni se presentan como
entrenados. Una validación independiente es necesaria antes de extender autoridad.
La captura causal de salidas, cuando esté activa, queda vinculada a cada contrato
versionado y separada de esa red de entrada.

## Proyección y pruebas

`secondary_activity.frames[tf]` ofrece entrada habilitada, series completas,
última evaluación, motivo, bloqueo, recuperación, horizonte y estado neuronal.
`timeframes.entry_frames` contiene `[5,15,60,240]`; el diario es contexto. Los datos
de 1 minuto anteriores conservan `KRAKEN_SPOT_LEGACY`, `entry_enabled=false` y
`NOT_AN_OPERATIONAL_ENTRY_FRAME`. Los recuentos son comprobaciones de patrones,
no operaciones. Los eventos llevan el plazo real.

`test/secondary-independent-timeframes.test.js` prueba fuera de EC2: migración
aditiva, hashes/cursores, causalidad, horizontes/financiación, identidades distintas,
cuatro relojes simultáneos, falta de datos lentos, recuperación versus pérdida,
reinicio/deduplicación, resoluciones públicas, selección y ejecución posterior a
latencia mediante el broker real en escenarios aislados y proyección honesta.
Estos casos sintéticos no se insertan en SQLite operativa ni acreditan una
entrada natural o una ventaja de mercado.
