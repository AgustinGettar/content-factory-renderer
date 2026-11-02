# Entrenador neuronal externo — versión 1.0.0

Este componente añade entrenamiento incremental real a la capa neuronal opcional
de la secundaria PAPER. No recibe autorización para cambiar el broker, el filtro
económico, el nominal, el apalancamiento, stops, objetivos ni trailing. Un error de
datos, dependencias o entrenamiento produce un recibo de indisponibilidad; no es
una condición de parada del motor de reglas.

## Separación de responsabilidades

El worker captura una fotografía causal antes de seleccionar, persiste decisiones
y construye etiquetas revisionadas a partir de ejecuciones observadas. La lectura
paginada del registro durable alimenta un dataset privado; no se usa el historial
recortado de la interfaz. El entrenador recibe ese dataset en un runner externo,
actualiza un checkpoint privado y produce, cuando corresponde, un candidato JSON.
El worker sólo carga un artefacto acotado y ejecuta inferencia local.

`scripts/trading-neural-train.py` no abre SQLite, no usa AWS, no descarga datos ni
envía órdenes. Rechaza modo real y su ejecución dentro del worker EC2 conocido,
incluida la presencia de `/var/lib/lumi-trading/trading.sqlite`. Las dependencias
de `requirements-trading-neural.txt` se instalan únicamente en el entorno externo
o CI. No cambian `package.json` ni las dependencias operativas Node.

El repositorio es público: **datasets, checkpoints y pesos derivados de datos
privados no se guardan en Git ni en artefactos públicos de CI**. Las pruebas de CI
usan únicamente ejemplos sintéticos aislados. La conexión del runner y su
disparador se verifica en el despliegue; añadir un archivo `schedule` únicamente
a una rama no acredita que GitHub lo vaya a ejecutar.

## Variables y esquema

`secondary-neural-features-1.0.0` define 33 variables, en el orden exportado por
`secondary-neural-data.js`: patrón, dirección LONG/SHORT, tendencia 5m y 15m
normalizada por sus ATR, eficiencia, volatilidad relativa, volumen relativo,
forma de vela, distancias al stop y objetivo, spread, comisiones, deslizamiento,
financiación prevista, retorno y riesgo netos previstos, mínimo útil, antigüedad
de datos y contexto de posiciones/confirmaciones.

El extractor es propio de `PF_XBTUSD`; no usa `atr1` ni las tarifas spot del
aprendizaje estadístico anterior. Las variables no incluyen el cierre futuro, el
resultado, máximos posteriores ni velas que aún no estaban disponibles.

Fotografía y decisión neuronal son registros distintos. La predicción se une por
`signal_id`/`operation_id`, sin modificar el plan firmado. Para validar una
predicción se exige el identificador del artefacto, el valor registrado antes de
la entrada y equivalencia con los pesos congelados de ese artefacto.

El grupo de entrenamiento contiene versiones de motor, entrada, ejecución,
política económica, salida y sus hashes. Una operación no puede cambiar de grupo.
Los contratos de salida fijos antiguos y el trailing nuevo no se mezclan.

## Etiquetas

El objetivo de regresión es:

`net_return = resultado neto final / suma(precio de cada entrada × cantidad)`.

No se divide por margen ni se vuelve a multiplicar por apalancamiento. Los
depósitos no forman parte del resultado. El neto ya contiene los costes del
contrato efectivo; el entrenador no vuelve a restarlos.

Cada operación completa aporta una etiqueta, aunque tenga varias ejecuciones de
entrada o cierres parciales. Ganancias y pérdidas son igualmente utilizables.
Una señal descartada, `NOT_FILLED` o un valor ausente no es una pérdida ni una
etiqueta cero.

Sólo entran etiquetas `MATURE`, con financiación final, cronología consistente,
trayectoria observada y sin modificaciones manuales. Se admite financiación
reconciliada cuando la trayectoria de precios sí fue observada. `PENDING` y
`EXCLUDED` conservan su motivo; no se imputan resultados. Un coste agregado puede
ser negativo cuando existe un abono de financiación válido: eso no se confunde
con una recarga.

La clave de deduplicación es operación + revisión/hash. El checkpoint conserva
la última revisión y el conjunto utilizado por cada candidato. Una corrección de
una etiqueta utilizada invalida el modelo dependiente y obliga a reconstruir
desde las últimas etiquetas válidas. No se aplican dos gradientes contradictorios
como si fueran dos operaciones. La corrección de un período de evaluación también
retira su aprobación previa.

## Red y reproducción

Arquitectura inicial: `33 → 16 tanh → 8 tanh → 1 lineal`.

Entrenador fijado: scikit-learn 1.8.0, NumPy 2.3.5, SciPy 1.17.0, joblib 1.5.3 y
threadpoolctl 3.6.0. Se usa `MLPRegressor.partial_fit`: gradientes por
retropropagación y SGD, no una suma manual de indicadores.

Parámetros de ingeniería versionados en `PROTOCOL`:

| Parámetro | Valor |
|---|---:|
| Semilla | 1729 |
| Learning rate constante | 0,01 |
| Momentum | 0 |
| Regularización L2 | 0,0001 |
| Minibatch | 32 |
| Épocas iniciales o de reconstrucción | 100 |
| Épocas de un lote incremental | 10 |
| Transformación fija de salida | media 0; escala 0,01 |

La transformación de salida permite optimizar retornos fraccionales pequeños:
se entrena sobre `net_return / 0.01` y se devuelve `raw_output × 0.01`. No es una
probabilidad de ganar. La media y escala de las variables se ajustan solamente al
entrenamiento inicial y quedan congeladas durante esa línea de checkpoints.
Corregir una etiqueta no cambia el normalizador bajo una red existente.

El checkpoint es JSON con pesos, normalización, métricas y registros de etiquetas.
No se deserializa pickle. SGD constante, momentum cero y orden determinista hacen
que no haya un historial de optimizador oculto que cambie el siguiente gradiente.
Las pruebas comparan la continuación directa con guardar/restaurar/reanudar.

El artefacto operativo es un envelope con `payload_json` UTF-8 exacto y SHA-256.
El payload contiene pesos input-major, bias, normalización, transformación de
salida, nombres/orden de variables, versiones, dominio, fechas y validación.
Python y JavaScript verifican ese texto exacto, evitando diferencias de escritura
de números entre sus serializadores. El runtime no carga el checkpoint del
entrenador.

El dominio de entrada se obtiene sólo del entrenamiento: mínimo y máximo más tres
desviaciones del normalizador congelado. Para variables constantes, el margen es
`1e-9`; no se extiende artificialmente un patrón o dirección nunca observados.
Fuera de dominio, se conservan las reglas base.

## Lotes incrementales y candidatos congelados

Con menos de 128 etiquetas maduras o 32 movimientos distintos, el estado sigue
`COLLECTING`. Estos mínimos son controles de ingeniería, no pruebas de ventaja.
No se exige una cantidad de operaciones ganadoras para poder aprender pérdidas.

Después del primer entrenamiento, un lote nuevo requiere al menos 64 etiquetas
maduras no procesadas. Un candidato en evaluación conserva sus pesos. Las nuevas
etiquetas se acumulan sin modificarlo. Al terminar o caducar esa evaluación, el
siguiente candidato puede actualizar el entrenador con el lote pendiente. El
modelo validado y el candidato siguiente son registros separados.

Los reintentos del mismo lote no actualizan pesos. Los archivos se escriben con
permiso `0600`, reemplazo atómico y `fsync`; un lock impide dos entrenadores sobre
el mismo checkpoint. Si falla la entrega después de guardar, un reintento vuelve
a enumerar los artefactos disponibles sin reentrenar.

## Validación temporal y autoridad

Los parámetros anteriores se declaran antes de observar la evaluación. No hay
búsqueda automática de arquitectura, umbral, salida o apalancamiento.

1. El entrenamiento utiliza sólo etiquetas ya maduras al congelar el candidato.
2. Las primeras 64 predicciones prospectivas elegibles forman la ventana de
   calibración/selección. No ajustan los parámetros de esta versión.
3. La ventana final empieza después de la maduración de esa ventana y una purga
   de 45 minutos. Excluye movimientos compartidos con entrenamiento o calibración.
4. El primer período final suficiente requiere 128 operaciones, 32 movimientos y
   14 días distintos. Se evalúa una vez. Un candidato rechazado no vuelve a elegir
   sobre ese mismo período; el siguiente necesita predicciones futuras propias.

Se exige reducción de MSE de al menos 5 % frente a la media de retorno del
entrenamiento, MAE no mayor, intervalo positivo de mejora y estabilidad por
patrón/período. El intervalo usa bootstrap de bloques diarios de tres días,
2.000 repeticiones, semilla fija y nivel familiar 0,05 dividido entre seis intentos
por ventana de 90 días. La incertidumbre sigue siendo real con estos mínimos.

También se registran retorno neto, costes, exposición, frecuencia, peor operación,
retroceso adverso observado y curva de resultados cerrados normalizados a 100 USD
nominales. El drawdown de esa curva **no se presenta como el drawdown intradía de
una cartera mark-to-market**.

Mejorar el error de predicción no basta para influir en entradas. La autorización
de priorización requiere además cohortes completas ADVISORY: todos los candidatos
base de la misma evaluación fueron realmente ejecutados, tienen resultados
maduros y exposiciones comparables dentro de 1 %. La decisión previa debe registrar
`cohort_id`, `base_rank`, `base_candidate_count` y `base_eligible`.

Se comparan la primera prioridad base y la primera prioridad neuronal mediante
sus resultados observados, sin inventar etiquetas para candidatos no ejecutados.
Los criterios son al menos 64 cohortes, 14 días, cobertura del 80 %, intervalo
positivo de ventaja y peor operación/drawdown no peores salvo tolerancia fijada
de 0,0001 de retorno. El denominador de cobertura incluye **todas las cohortes
base prospectivas observadas** de esa ventana y dominio, también cuando la red
no produjo ninguna predicción o las órdenes no se ejecutaron. Sólo el numerador
requiere predicción previa del candidato, ejecuciones completas y etiquetas
maduras de todos los integrantes. Una ausencia no recibe un retorno ficticio:
reduce cobertura y conserva su estado sin etiqueta. Los metadatos de decisión
se persisten aparte, de forma idempotente. Un dominio ausente en una captura
fallida se cuenta conservadoramente, sin reconstruir sus variables.

El export debe acreditar `opportunities_complete=true`; los datasets antiguos
sin ese manifiesto pueden aportar etiquetas al entrenamiento, pero no autorizar
ASSISTED. Si ya hay 64 cohortes completas y 14 días de evidencia, una cobertura
inferior al 80 % rechaza el candidato, aunque ajuste muy bien el subconjunto donde
sí predice. Es un **diagnóstico de ranking con ejecuciones observadas**;
no prueba qué precio habría conseguido un orden alternativo ni garantiza un P&L
causal mayor. El conjunto de entradas permanece igual.

Si la predicción supera sus criterios pero faltan cohortes, el estado es
`FORECAST_VALIDATED_PRIORITIZATION_PENDING` con `assistance_authorized=false`.
La ventana final de error queda congelada mientras se reúnen las cohortes
prospectivas faltantes. El criterio de ranking se decide una vez cuando su mínimo
de evidencia se cumple. No se prueba repetidamente hasta que salga positivo.

Un resultado `PASSED` sólo autoriza **priorización**, nunca veto, cambio de tamaño,
objetivo, stop o trailing. El runtime exige además compatibilidad, integridad,
vigencia y controles operativos. El modelo caduca a los 90 días desde su
entrenamiento; revisar su metadata no renueva esa fecha.

## Ejecución externa

```sh
python3 scripts/trading-neural-train.py \
  --dataset /ruta/privada/dataset.json \
  --checkpoint /ruta/privada/trainer-checkpoint.json \
  --output-dir /ruta/privada/modelos \
  --mode PAPER
```

El caller suministra un dataset `secondary-neural-dataset-1.0.0` con `mode=PAPER`,
`as_of`, `rows:[{snapshot,label,decision?}]`, `opportunities`,
`opportunities_complete` y checkpoint del lector de eventos. `opportunities`
contiene sólo identidad, momento, esquema/dominio y decisión previa, sin resultado;
incluye las operaciones pendientes, no ejecutadas y excluidas que no aparecen
entre las etiquetas maduras. Su presencia no las convierte en muestras de ajuste.
Se aceptan entregas incrementales: el entrenador mantiene la última etiqueta de
cada operación. No necesita exportar toda la SQLite ni copiarla ignorando el WAL.

`last-receipt.json` distingue etiquetas cambiadas, duplicados, exclusiones,
entrenamientos, candidatos, modelo validado y revocaciones. `artifact_files`
enumera artefactos disponibles con rol `CANDIDATE` o `VALIDATED`. Ninguna salida
de este script implica por sí sola publicar un modelo en el worker.

Límites: 64 MiB por JSON privado, 20.000 operaciones por checkpoint, 16 grupos,
64 variables, 256 candidatos registrados por grupo y 128 KiB por artefacto
operativo. Si se alcanza un límite, la continuación requiere archivo/versionado
del dataset externo; se devuelve un motivo visible y el motor de trading sigue
independiente. No se eliminan registros antiguos silenciosamente.

## Desactivar y revertir la capa opcional

`scripts/trading-aws-exploration-update.py` acepta `--neural-mode OFF`,
`COLLECTING`, `ADVISORY` o `ASSISTED`. En una intervención neuronal conserva los
valores efectivos de exploración, nominal y todos los parámetros de margen y
trailing. Rechaza combinaciones que intenten modificarlos simultáneamente.

Los únicos ajustes propios son el modo y los paths privados fijos de `model.json`,
`candidate.json`, `last-good.json` y `status.json` en
`/var/lib/lumi-trading/neural/`. La revisión previa es exacta y la migración se
comprueba sobre una copia en memoria, con Node limitado a 96 MiB y SQLite de sólo
lectura. En EC2 no se ejecutan entrenamiento, instalaciones ni suites de pruebas.

Para revertir sobre el **mismo commit compatible ya desplegado**, usar ese mismo
SHA como destino y `--expected-current`, junto con `--neural-mode OFF`. Ese camino
guarda un respaldo privado de configuración y verifica contratos, pero no copia
de nuevo toda la SQLite, cambia binario ni restaura una base anterior. Puede
desactivar la capa aunque no quede espacio para otro respaldo completo de la DB.
Una actualización a un commit distinto conserva la exigencia de respaldo SQLite
consistente y el control de espacio previo.

Si una intervención neuronal falla después del cambio de release, la recuperación
mantiene el código compatible y desactiva **solamente** la capa neuronal. El filtro
de margen útil, la exploración y los contratos de trailing permanecen activos.

## Fuentes del entrenador

- [MLPRegressor 1.8.0](https://scikit-learn.org/1.8/modules/generated/sklearn.neural_network.MLPRegressor.html)
- [Modelos neuronales supervisados 1.8.0](https://scikit-learn.org/1.8/modules/neural_networks_supervised.html)

La arquitectura y los parámetros elegidos son un inicio de ingeniería, no una
superioridad demostrada sobre las reglas de Lumi.
