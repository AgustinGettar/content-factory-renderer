# Capa neuronal opcional de Lumi Trading PAPER

## Alcance y contratos conservados

Esta integración pertenece exclusivamente a `FREQUENT_PAPER`,
`secondary-futures-1.0.0` y `PF_XBTUSD`. No reemplaza el motor ni crea una cartera,
un feed, un escritor de SQLite o un servicio de trading adicional. `learning.js`
y sus grupos históricos permanecen intactos. Los datos nuevos se guardan en
eventos asociados a `signal_id`/`operation_id`, fuera de los planes firmados.

Se conservan las políticas de exploración, margen útil y trailing existentes:
nominal 100 USD, apalancamiento simulado 2, mínimo neto previsto 0,002 de exposición,
retroceso 25 %, plazo base 30 minutos, extensión 15 minutos y estancamiento
10 minutos. La red no tiene métodos para editar estos parámetros ni posiciones.

Los únicos puntos operativos añadidos son captura previa a `broker.choose`,
registro posterior de la decisión, observación de eventos de ejecución/cierre,
una carga local asíncrona cada 60 segundos y una proyección del monitor. No se
entrena ni se descarga un modelo en el bucle de precios o renovación de lease.

## Estados y autoridad

| Modo | Comportamiento |
| --- | --- |
| OFF | Reglas base; no captura ni inferencia nueva. Conserva historia y posiciones. |
| COLLECTING | Fotografía previa y etiquetas; no influye en órdenes. |
| ADVISORY | Predicciones experimentales previas; mismo orden y selección base. Sin modelo pasa efectivamente a COLLECTING. |
| ASSISTED | Sólo una versión con validación autorizada puede priorizar los mismos candidatos. No veta candidatos ni cambia planes. |
| DEGRADED | Fallo opcional visible; reglas base. Los controles de mercado, contabilidad y PAPER siguen siendo obligatorios. |

El despliegue inicial solicita ADVISORY. Si todavía no existe un artefacto real
entrenado, el estado efectivo es COLLECTING, no «prediciendo» ni «aprendizaje
demostrado». La ausencia de etiquetas suficientes pertenece al modelo, nunca al
estado operativo del motor.

Puede observarse un candidato nuevo mientras un modelo validado sigue operativo.
Su predicción queda en `candidate_predictions`, con autoridad `NONE`, sobre la
misma señal. No hay otra cartera. Se limita a un candidato y se evita duplicar
inferencia si tiene el mismo identificador que el modelo principal.

## Evidencia y etiquetas

`secondary-neural-data.js` define 33 variables causales: patrón, dirección,
tendencia 5m/15m, volatilidad ATR, volumen relativo, forma de vela, distancias
estructurales, spread, costes de futuros, margen neto previsto, antigüedad y
contexto de posiciones/confirmación compartida. No incluye resultados, máximos
posteriores o velas futuras. Cada fotografía tiene versiones y hashes propios.
Una señal detectada y rechazada conserva la fotografía y su decisión; una vela
sin patrón no se convierte en una señal artificial.

La etiqueta principal es `net_final / executed_exposure`, donde la exposición
es la suma de precio por cantidad de las ejecuciones reales de entrada PAPER.
No se divide por margen ni se multiplica otra vez por apalancamiento. Comisiones,
deslizamiento y financiación proceden de la contabilidad efectiva de futuros.
Cada operación completa produce una etiqueta; sus fragmentos no son ejemplos
independientes. Una corrección de financiación revisa la etiqueta, retira los
modelos afectados y reconstruye su linaje con las últimas versiones.

Ganancias y pérdidas resueltas son utilizables. Señales no ejecutadas no son
pérdidas. Datos incompletos, financiación pendiente y modificaciones manuales
tienen estados/exclusiones explícitos. No se reconstruyen variables históricas
cuando falta una fotografía inmutable anterior. Los ejemplos de salida fija y
de trailing pertenecen a dominios diferentes.

El dataset usa eventos durables paginados y checkpoints. El pequeño historial
del monitor no es su fuente. La caché del worker está acotada; un caso que salga
de ella solicita reconciliación externa en lugar de crecer indefinidamente.

## Ciclo externo privado

El repositorio es público. Nunca guardar exports, checkpoints, pesos operativos,
credenciales o la base privada en GitHub ni en artefactos públicos de CI.

1. Verificar la release activa y leer
   `/var/lib/lumi-trading/neural/publication.json`, si existe. Descargar sus dos
   checkpoints de la generación privada indicada, comprobando sus hashes.
2. En EC2 ejecutar únicamente el exportador ligero:

   ```sh
   python3 /opt/lumi-trading/current/scripts/trading-neural-export.py \
     --database /var/lib/lumi-trading/trading.sqlite \
     --output /var/lib/lumi-trading/neural/export.jsonl.gz \
     --after CURSOR_DEL_CHECKPOINT --max-events 10000 --mode PAPER
   ```

   Usa una transacción de lectura SQLite que incluye el WAL, páginas de 100 y
   límites de 10.000 eventos/32 MB. No copia la base viva ni cambia su estado.
   El archivo privado contiene sólo evidencia necesaria de la secundaria.
3. Transferir el export a un runner externo autorizado. En el entorno externo,
   usar el código de la release activa y las dependencias fijadas en
   `requirements-trading-neural.txt`. Ejecutar:

   ```sh
   node scripts/trading-neural-cycle.mjs \
     --export /ruta/privada/export.jsonl.gz \
     --dataset-checkpoint /ruta/privada/dataset-checkpoint.json \
     --training-checkpoint /ruta/privada/training-checkpoint.json \
     --output-dir /ruta/privada/resultados --mode PAPER
   ```

   El ciclo rechaza la EC2 operativa. Con una página incompleta sólo conserva
   progreso, sin ajustar pesos. Con export completo reconcilia etiquetas y llama
   al entrenador; éste sólo cambia pesos cuando hay un lote maduro suficiente.
   Un bootstrap vacío crea un checkpoint compatible, no una red entrenada.
   `last_training_at` sólo cambia con un ajuste real y se distingue de `at`, la
   fecha de revisión del ciclo.
4. Transferir exclusivamente los archivos enumerados por
   `publication-manifest.json` a un directorio privado de staging en EC2. Verificar
   tamaño y SHA-256. Publicar con la misma release que originó el export:

   ```sh
   python3 /opt/lumi-trading/current/scripts/trading-neural-publish.py \
     --stage /var/lib/lumi-trading/neural/staging/ID_DE_CICLO \
     --expected-commit COMMIT_COMPLETO --mode PAPER
   ```

   El publicador tiene un lock, rechaza resultados antiguos y cursores que
   retroceden, y conserva dos generaciones completas de checkpoints. Publica
   revocaciones antes de reemplazar pesos y termina con un puntero durable.
   Reintentar el mismo manifiesto no aplica otra actualización.
5. Confirmar en el monitor/estado persistido el recibo importado y el avance de
   evaluaciones. Un ciclo sin muestras informa COLLECTING; no atribuirle un
   entrenamiento ni una mejora.

La cadencia prevista es diaria, condicionada a nuevas etiquetas maduras. El
disparador debe ejecutarse en un runner externo realmente disponible y comprobarse
con un recibo de ejecución. La tarea programada autorizada puede orquestar el
export privado, el ciclo externo y la publicación mediante los conectores
existentes. Si su entorno no ofrece ejecución externa, debe informar esa
capacidad faltante; queda prohibido trasladar el entrenamiento a EC2. Un archivo
de workflow en una rama distinta de la predeterminada no constituye un scheduler.
El workflow de esta rama prueba únicamente datos sintéticos aislados.

## Red y validación

La arquitectura es un MLP 33 → 16 → 8 → 1, activación tanh y salida lineal,
entrenado mediante gradientes con sklearn fijado. La salida estima retorno neto;
no es una probabilidad de ganar. Pesos, normalización congelada, orden de variables,
dominio y metadatos viajan juntos en una envoltura con SHA-256 del JSON exacto.

Los criterios, ventanas cronológicas, grupos de movimiento, purga de solapamientos,
referencias y mínimos de ingeniería están definidos antes del resultado en
[NEURAL-TRAINER.md](NEURAL-TRAINER.md). Un mínimo de muestras no prueba ventaja.
Se evalúan predicciones hechas antes de sus etiquetas; entrenamiento, calibración
y evaluación final tienen funciones distintas. Las decisiones del candidato se
guardan incluso cuando otro modelo está operativo. Una mejora de error por sí
sola no autoriza asistencia: también se exige utilidad de priorización con
cobertura, exposición comparable y control de pérdidas.

## Límites y recuperación

El runtime admite artefactos de hasta 128 KiB y trabajo matemático acotado por
dimensiones/elementos antes de ejecutarlo. La inferencia tiene un presupuesto de
5 ms y mediciones p95/p99; el presupuesto temporal no sustituye esos límites.
Las lecturas son asíncronas y limitadas; no hay `Promise.race` sobre un cálculo
síncrono sin límites. NaN, esquema incorrecto, futuro, expiración, fuera de dominio,
archivo ausente/corrupto o lentitud producen retorno visible a reglas.

La última versión compatible puede recuperarse, salvo que esté revocada. Las
revocaciones persisten, se aplican antes de leer los modelos y sobreviven al
reinicio. El candidato no reutiliza silenciosamente otro candidato antiguo.
Errores de integridad de SQLite o del contrato PAPER nunca se convierten en un
fallo neuronal ignorado.

## Despliegue y reversión

Antes del primer despliegue: comparar HEAD/release, probar migración aditiva e
idempotente sobre una lectura del estado actual, comprobar contratos abiertos,
crear backup consistente con SQLite y reutilizar dependencias Node. No ejecutar
tests, backtests, pip ni entrenamiento en la EC2 activa. El helper exige la release
esperada y un diff limitado a Trading.

Activación inicial:

```sh
python3 scripts/trading-aws-exploration-update.py NUEVO_COMMIT \
  --expected-current COMMIT_ACTUAL --neural-mode ADVISORY
```

Reversión preferida, sobre la misma release compatible:

```sh
python3 /opt/lumi-trading/current/scripts/trading-aws-exploration-update.py COMMIT_ACTUAL \
  --expected-current COMMIT_ACTUAL --neural-mode OFF
```

OFF modifica sólo configuración neuronal, respalda esa configuración y conserva
SQLite, eventos nuevos, pérdidas, aportes, pendientes y contratos. No descarga
otro código ni necesita otra copia completa de la base para desactivar una capa
opcional. Nunca restaurar una base antigua sobre operaciones posteriores. Un fallo
de esta actualización revierte sólo la capa neuronal, sin desactivar margen útil,
trailing o exploración. Los archivos privados pueden conservarse para investigación.

## Verificación honesta

Las pruebas aisladas verifican equivalencia operativa, causalidad, revisiones de
financiación, cuatro posiciones independientes con trailing/cierre pendiente,
persistencia, fallos opcionales, inferencia Python/JavaScript y entrenamiento
incremental reproducible. Sus operaciones sintéticas nunca se insertan en vivo.

Después del despliegue verificar por separado: release exacta, perfil efectivo,
un escritor, feed, evaluaciones naturales, captura y decisiones reales, etiquetas
maduras, recibo externo, modelo/candidato, monitor y outbox existente. Registrar
las limitaciones de observación: integración funcionando, modelo entrenado y
mejora demostrada son tres afirmaciones diferentes.
