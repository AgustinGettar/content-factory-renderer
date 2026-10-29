# Lumi Trading en AWS — preparación del 29/10/2026

Estado de esta entrega: instalador y comprobaciones preparados en la rama
`lumi-trading-aws`. No se ha creado una VM, iniciado el monitor ni obtenido un
recibo de Telegram desde AWS. La captura del propietario confirma cuenta activa
con Free Plan, 100 USD iniciales y vencimiento el 29/04/2027 o al agotarse los
créditos. El instalador vuelve a comprobar el estado real antes de aprovisionar.
Los 0/100 USD de Explore AWS corresponden a créditos adicionales por actividades.

## Alcance y consumo

Una instancia `t3.micro` en Estocolmo (`eu-north-1`), Amazon Linux 2023 oficial,
8 GiB gp3 cifrados, IPv4 pública y CPU en modo Standard. La instancia, disco,
IPv4 y tráfico pueden consumir crédito promocional. No se afirma coste cero
indefinido ni se estima su duración sin medir el consumo real. La cuenta debe
seguir FREE/ACTIVE, no caducada y con al menos 10 USD de crédito al instalar o
configurar. Ese umbral no es un presupuesto ni limita el consumo posterior.
El programa no cambia el plan, contrata soporte, crea claves AWS, usa Organizations
ni asigna roles IAM. No añadir servicios que conviertan la cuenta a pago.

Se usa la VPC y una subred predeterminadas existentes. Si no están disponibles,
se detiene sin construir otra red. No crea NAT Gateway, balanceador, base de
datos, disco adicional, dominio ni servidor HTTP. El grupo de seguridad propio
no tiene entradas por defecto; solo necesita tráfico saliente. CloudShell se
usa para instalar y administrar; el monitor corre en EC2 y no depende de que
el teléfono o CloudShell sigan abiertos.

Solo PAPER y el Supabase de staging existente. No hay órdenes reales, cartera
ni claves privadas de Kraken. Mini App, panel 148, webhook, menús, callbacks,
transporte audiovisual, main y producción no se modifican. No hay estrategia
aprobada ni probabilidad disponible. Un servidor activo no demuestra rentabilidad.

## Instalación desde CloudShell

Abrir CloudShell (`>_`) en la cuenta de Lumi. Usar el repositorio público
`https://github.com/AgustinGettar/content-factory-renderer.git`, rama
`lumi-trading-aws`, y hacer checkout de la revisión exacta entregada al propietario.
No ejecutar un `pull` automático sobre el proceso activo ni usar CloudShell como
worker. Desde la raíz del checkout:

```sh
python3 scripts/trading-aws-setup.py check
python3 scripts/trading-aws-setup.py provision
python3 scripts/trading-aws-setup.py status
```

`check` solo lee identidad y Free Plan. `provision` verifica además AMI y tipo
elegibles y crea una sola VM. Identifica recursos por etiquetas propias, conserva
la solicitud exacta y un ClientToken en el directorio privado
`~/lumi-trading-cloud-state/eu-north-1/`, y reutiliza la VM al repetir. Si AWS
aceptó una solicitud pero se perdió la respuesta, repite esa misma solicitud.
No borrar ese directorio ni crear otra VM para resolver una respuesta ambigua.
Una VM con revisión distinta o varias VM propias producen un error sin reemplazo.

`status` distingue instancia creada de host preparado. Esperar a `HOST_PREPARED`:
se instala Node 24, dependencias fijadas en package-lock y la revisión exacta.
El servicio todavía no arranca. Si la instalación falla, diagnosticar su log
`/var/log/lumi-trading-install.log`; no recrear recursos a ciegas. Una instalación
sin configurar se apaga a las dos horas para reducir consumo. El disco permanece
y puede consumir crédito. Si se apagó, reanudar la misma instancia desde EC2;
si falló el bootstrap, resolver la causa antes de volver a ejecutarlo.

## Secretos y activación

```sh
python3 scripts/trading-aws-setup.py configure
```

Usar el terminal interactivo. Solicita con entrada oculta únicamente la
`SUPABASE_SERVICE_ROLE_KEY` de staging, `LUMI_TELEGRAM_BOT_TOKEN` existente y el
ID privado ya permitido en `LUMI_TELEGRAM_REVIEW_TEST_USERS`. Obtenerlos de la
configuración existente por un canal seguro. No pegarlos en chat, comandos,
capturas, Git, user-data ni documentos. No crea otro bot o propietario.

La configuración se transmite por stdin de SSH, con clave efímera de EC2 Instance
Connect. La clave pública del host se fija a partir de la salida de consola leída
mediante la API autenticada de AWS. SSH se permite temporalmente desde la IPv4
de ese CloudShell (/32) y la regla se revoca en un bloque finally, incluso ante
un error de conexión. Si la revocación no se confirma, revisar y quitar esa
regla temporal del grupo `lumi-trading-paper-v1`; no abrir el puerto al mundo.

Antes de guardar secretos, el host comprueba IMDSv2 y compara cuenta, instancia
y región con la identidad instalada. Después verifica el bot y el destinatario
privado existente en staging. Los secretos se guardan solo en
`/etc/lumi-trading/worker.env`, root:root 0600, leído por systemd. El worker corre
como usuario sin privilegios `lumitrading`, con memoria acotada y filesystem
protegido. No consulta credenciales IAM ni admite metadata IMDSv1.

La configuración habilita las alertas de PAPER autorizadas. El aviso técnico
usa la cola durable existente: si ya está entregado o UNKNOWN, no se fuerza
otro envío. No se inventa una señal para comprobar Telegram.

Si se perdió la respuesta después de configurar:

```sh
python3 scripts/trading-aws-setup.py resume
```

Reutiliza el archivo existente y solicita iniciar el servicio sin sustituir
secretos ni reiniciar un proceso ya activo. Sin configuración válida se detiene.

## Evidencia de funcionamiento

```sh
python3 scripts/trading-aws-setup.py verify
```

Lee por SSH el estado systemd, la última muestra de salud con su timestamp y los
campos de estado/recibo de las tablas de trading. No muestra secretos, chat_id
ni logs arbitrarios. Esta inspección no envía mensajes ni modifica la base.
Para afirmar activación, verificar conjuntamente:

- Servicio activo y muestra de salud reciente; connected y reconciled verdaderos,
  contador de cotizaciones/trades avanzando y cotizaciones dentro de 5 segundos.
- Estado de staging actualizado, lease vigente y revisión avanzando. El lease y
  fencing existentes impiden que dos workers gestionen la misma simulación.
- Aviso técnico DELIVERED con message_id real y fecha. Es aceptación de la API,
  no confirmación de lectura. Si falta, es antiguo o está UNKNOWN, no afirmar
  entrega nueva ni reenviarlo automáticamente.
- Observación sostenida de CPU, memoria, desconexiones y consumo de crédito; un
  chequeo instantáneo no prueba operación persistente. Comprobar recuperación
  con un reinicio controlado, sin borrar estado ni forzar un segundo worker.

Se conserva el feed oficial Kraken y los controles de cotizaciones <=5 s y
trades <=30 s. Los datos históricos solo calientan indicadores. Ante falta de
frescura, reconciliación o setup válido, no hay entrada. Las estrategias y el
simulador no se han cambiado en esta adaptación de hosting.

## Operación y límites pendientes

systemd reinicia en fallos con espera de 60 s; cinco fallos en diez minutos
detienen los intentos. Investigar antes de resetear ese límite. Los logs tienen
retención acotada. Para pausar sin perder el historial, detener la instancia
identificada en EC2; el disco sigue existiendo y consumiendo crédito. No borrar
ni detener recursos ajenos a las etiquetas de este instalador.

Los permisos de CloudShell, disponibilidad EC2, bootstrap real, identidad del
bot y recuperación real se validarán en esa cuenta; las pruebas locales no
sustituyen esas verificaciones. Si la API Free Tier o un permiso necesario no
está disponible, el instalador se detiene y muestra un código sin secretos.
Al agotarse la prueba será necesaria otra decisión de alojamiento; no hay
conversión a pago autorizada ni promesa de ingresos para sostener el servicio.

## Pruebas de esta entrega

93 pruebas Node de trading/transporte/aislamiento y 11 pruebas Python del
instalador; pruebas con fixtures, sin crear VM ni enviar Telegram. Incluyen
rechazo de plan de pago/caducado, recuperación de respuesta de creación ambigua,
no duplicación de VM, IMDSv2, identidad incorrecta, validación de secretos,
clave pública del host, filtrado de logs y revocación de SSH tras un fallo.
Sintaxis Bash y whitespace revisados. La suite general de Lumi no se presenta
como aprobada: conserva los fallos previos ya documentados.

Fuentes oficiales:
[estado Free Plan](https://docs.aws.amazon.com/cli/latest/reference/freetier/get-account-plan-state.html),
[condiciones Free Tier](https://aws.amazon.com/free/free-tier-faqs/),
[EC2 Free Tier](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html),
[Node en AL2023](https://docs.aws.amazon.com/linux/al2023/ug/nodejs.html),
[EC2 Instance Connect](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-connect-methods.html),
[IMDSv2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html).

## Cambio solicitado a 100 USD — 29/10/2026

La instancia i-0ae2ad0bb886f3d7f arrancó el monitor PAPER y entregó el aviso
técnico 163. El usuario confirmó recepción. El registro de arranque mezcla
las copias de tee/cloud-init; los asistentes móviles recuperan una clave
Ed25519 completa del registro EC2 autenticado y comprueban la huella cuando
consta. Se mantiene StrictHostKeyChecking y el acceso temporal /32.

El propietario pidió reducir el capital inicial de 10.000 a 100 USD.
`trading-aws-update.py` prepara una revisión exacta, con dependencias idénticas,
comprueba que la cartera siga sin fills y reinicia solo el servicio de trading.
El worker migra bajo lease y registra estado anterior, motivo, política y aviso
durable en el mismo commit de estado. Si encuentra una operación abierta o
resultados anteriores, rechaza la migración; no elimina pérdidas para reiniciar.
Tras un checkpoint de 100 USD nunca vuelve automáticamente a la política vieja.
Un error ambiguo de lectura tampoco autoriza ese rollback.

El riesgo inicial sigue siendo 0,25 %: presupuesto de 0,25 USD por entrada.
No se aumentan cantidades para superar mínimos, costes o liquidez. Los mensajes
usan el capital de la política, sin textos fijos de 10.000 USD. La señal técnica
original no se repite; el cambio de capital tiene su propio aviso deduplicado.

El código no constituye evidencia de despliegue: comprobar `state.capital`,
ambas carteras, el evento PAPER_INITIAL_CAPITAL_CHANGED y el nuevo recibo.
