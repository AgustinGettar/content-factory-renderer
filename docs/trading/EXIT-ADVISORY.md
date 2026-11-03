# Evidencia causal de salidas — asesor sin autoridad

`secondary-exit-advisory.js` prepara investigación separada de la red de entradas.
No cambia el significado de aquel predictor ni le concede autoridad sobre
posiciones. El estado es `COLLECTING`, autoridad `NONE`, modelo ausente y cero
actualizaciones de gradiente. No entrena ni carga dependencias ML en el worker.

## Captura y recursos

El broker llama el observador después de su decisión determinista y antes de
intentar cerrar. Cada evento `SECONDARY_EXIT_ADVISORY_SNAPSHOT` identifica la
operación, movimiento, contrato, revisión de entrada/salida y plazo. El registro
usa el escritor y los eventos existentes. No utiliza la vista recortada del
monitor como dataset ni introduce una segunda base.

Cada fotografía incluye neto de liquidación del broker, cantidad, neto por BTC,
máximo causal, retroceso conocido, resultado realizado y remanente, tiempo de
vida y horizonte restante, momentum y volatilidad EWMA de cotizaciones ya vistas,
spread, capacidad compartida de salida, financiación, costes ya contabilizados,
piso/protección y acción adoptada. Su SHA-256 cubre el contenido. El máximo nunca
proviene del futuro ni de un orden intravela supuesto a partir de OHLC.

La cadencia base es un intervalo por plazo, con mínimo 1 minuto y máximo 15
minutos. Los cambios de acción/estado/cantidad permiten hasta 32 muestras
adicionales. El límite total es 256 fotografías por operación, 8 KiB cada una.
Las estadísticas EWMA y el cursor por posición tienen tamaño constante. Ticks
repetidos o fuera de orden no generan fotografías. El cursor persiste con la
posición y evita repeticiones después de reinicio.

Una cantidad nueva o un coste medio distinto abre un segmento causal para las
variables de excursión. El piso firmado por BTC se conserva. La reducción de
cantidad por un cierre parcial no se etiqueta como un retroceso de precio. Neto
sin financiación final y capacidad insuficiente conservan sus motivos explícitos.
Un cierre manual puede conservarse como evidencia, con
`MANUAL_MANAGEMENT_OVERRIDE`, sin atribuir su acción a un algoritmo autónomo.

## Estudio fijado antes de observar resultados

Tres acciones candidatas se registran como hipótesis:

1. Conservar con stop y vencimiento firmados.
2. Proteger con la regla determinista firmada.
3. Solicitar cierre después de la latencia del contrato.

No hay puntuaciones entrenadas ni etiquetas contrafactuales en el worker. La
evaluación externa debe reconstruir sólo ejecuciones respaldadas por cotizaciones,
liquidez compartida y financiación. Una trayectoria posterior a la salida real
es evidencia de mercado separada, nunca otra posición ni una modificación del
saldo. Cuando esa evidencia falta, la comparación queda sin etiqueta.

Los conjuntos se separan por versión de entrada, política económica, salida,
ejecución y plazo; se agrupan por movimiento y se purgan solapamientos temporales
hasta el horizonte máximo pertinente. Varios tramos no son varias observaciones
independientes. Las etiquetas futuras no pueden entrar en las variables previas.
No se entrena un modelo de 4h con los pesos de 5m mediante un cambio de nombre.

Los mínimos del entrenador de entradas continúan en 128 etiquetas maduras y 32
movimientos para arranque, 64 etiquetas nuevas para un lote posterior; estas
fotografías de salida no se cuentan como operaciones ni satisfacen esos mínimos.
Cualquier entrenador de salidas necesita su propio protocolo temporal y de
etiquetado, dependencias fijadas y datos privados verificables.

## Transferencia y futura autoridad

El exportador compatible debe incluir este tipo de evento de forma explícita,
con sus límites y lectura transaccional que incluye WAL. La exportación no copia
SQLite. Exports, checkpoints y pesos derivados permanecen privados. Se comprueba
SHA-256 antes de publicar; si la transferencia no está disponible, la captura
permanece en COLLECTING y el gestor determinista sigue funcionando.

Futura autoridad neuronal de salida exige un contrato nuevo, validación temporal
propia y pruebas operativas. No puede bajar pisos, ampliar pérdidas, modificar
posiciones firmadas ni exceder presupuestos. La autorización actual de la red de
entradas sólo permite priorización compatible; no cambia por añadir este
observador. Sus fallos opcionales degradan la investigación, nunca desactivan
controles obligatorios de PAPER, mercado, contrato o contabilidad.
