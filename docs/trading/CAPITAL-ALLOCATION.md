# Capital finito y prioridad de entradas PAPER

## Cambio solicitado el 2 de noviembre de 2026

`secondary-capital-allocation-1.0.0` es una política aditiva de la cartera
secundaria existente. El worker conserva el motor, el escritor SQLite y los
contratos anteriores. No modifica la principal ni añade órdenes reales.

La solicitud `user-capital-20261102-1000` aporta una sola vez la diferencia
positiva hasta un patrimonio de 1.000 USD ficticios. En cartera plana equivale
a llevar el efectivo a 1.000 USD. Con posiciones abiertas espera una valoración
ejecutable reciente y financiación resuelta. Usa `PAPER_CAPITAL_TOPUP`, el ledger
y el outbox existentes. Conserva pérdidas, comisiones, estadísticas e historia.
El recibo durable queda `APPLIED` incluso si no hace falta aportar: una pérdida,
un reinicio o una nueva evaluación nunca repone ese dinero automáticamente.

## Tamaño y prioridad

El nominal base de nuevas señales es 300 USD, tres veces el nominal anterior.
El apalancamiento permanece en 2×. Cantidades, margen y costes se calculan con
la cantidad redondeada al incremento real del instrumento.

La evaluación comprueba primero datos, contrato, duplicados, economía y contexto.
Entre las candidatas admisibles ordena por retorno neto previsto al objetivo
dividido por exposición; después por RR neto. El identificador desempata el orden
de forma reproducible, pero no concede una prima monetaria a un empate económico.

Sólo si existen al menos dos candidatas admisibles y una es estrictamente mejor,
la primera puede recibir hasta 450 USD nominales (factor experimental fijo 1,5).
Una señal única y las candidatas empatadas mantienen 300 USD. Esta clasificación
no es una probabilidad de ganar ni evidencia de superioridad validada.

La asignación descuenta reservas de pendientes y financiación de posiciones.
El margen de posiciones abiertas ya está descontado del efectivo y no se resta
otra vez. La candidata prioritaria obtiene capital primero; su prima puede
reducirse si el efectivo sólo permite un nominal entre la cantidad base y la
preferente. Si ni siquiera alcanza para la cantidad base redondeada, registra
`PAPER_CAPITAL_INSUFFICIENT` y mantiene la evaluación. No hay una cuota ni una
meta de diez operaciones. El capital se vuelve a usar cuando se libera.

El tamaño no aumenta después de pérdidas ni por recargas. No se añade dinero
a una posición abierta ni se cambia su stop, objetivo, plazo o trailing.

## Ejecución y costes

La selección reserva margen, comisión de entrada y financiación. La ejecución
revalida con la cotización posterior a la latencia; también comprueba capital
sin consumir reservas de otras órdenes. Si sólo puede financiar parte de la
cantidad, el recibo informa la ejecución parcial y la liquidez consumida coincide
con la cantidad ejecutada. Un remanente sin financiación se cancela explícitamente.
La liquidez limitada continúa produciendo ejecuciones parciales o falta de fill.

Las nuevas entradas conservan el mínimo neto previsto de 0,002 de exposición.
Sobre 300 USD efectivos son 0,60 USD; sobre 450 USD, 0,90 USD. Aumentar tamaño no
convierte una entrada de margen proporcional insuficiente en una entrada válida.
El stop y la protección neta por retroceso del 25 % conservan su política original.

## Compatibilidad y aprendizaje

El perfil histórico de exploración y su nominal de 100 USD no se reescriben.
Los nuevos contratos incluyen la política de asignación, su hash, el hash base
y un hash compuesto de políticas. El monitor muestra el nominal efectivo.
La reanudación valida el contrato embebido de cada orden, sin exigir que coincida
con una política posterior. Las órdenes anteriores conservan su tamaño y salida.

El orden base y la asignación se fijan antes de capturar variables neuronales.
OFF, ADVISORY y fallo neuronal conservan ese orden. Las nuevas muestras pertenecen
a un dominio distinto del perfil anterior. La validación de asistencia conserva
el requisito de exposiciones comparables: cohortes de 300 y 450 USD no se consideran
automáticamente comparables. El entrenamiento puede recoger resultados normalizados,
pero esta actualización no relaja criterios ni autoriza un modelo sin evidencia.

## Despliegue y reversión

El helper existente instala únicamente la política aditiva; la prueba de migración
no modifica la cuenta. El aporte lo aplica el worker y persiste el recibo junto con
el saldo y los eventos. Se exige backup SQLite consistente previo al despliegue.

```sh
python3 scripts/trading-aws-exploration-update.py NUEVO_COMMIT \
  --expected-current COMMIT_ACTUAL \
  --capital-allocation secondary-capital-allocation-1.0.0 \
  --allocation-base-usd 300 --preferred-multiplier 1.5 \
  --target-equity-usd 1000 --capital-request-id user-capital-20261102-1000
```

No utilizar `--nominal 300`: ese parámetro pertenece al perfil histórico.
La reversión compatible usa la misma release con `--capital-allocation OFF`.
Desactiva la nueva preferencia y vuelve al nominal histórico para nuevas señales,
pero mantiene el presupuesto finito, el aporte aplicado y todos los contratos.
Nunca restaura una base antigua ni un binario que ignore esta política persistida.

Las pruebas y datos sintéticos se ejecutan fuera de la EC2 operativa. Una orden
natural no se fuerza para acreditar la publicación.
