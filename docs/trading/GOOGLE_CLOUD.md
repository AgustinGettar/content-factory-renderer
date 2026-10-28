# Lumi Trading en Google Cloud — preparación, 29/10/2026

Estado: adaptación de arranque y unidad systemd preparadas. No hay VM creada,
cuenta de facturación verificada, proceso persistente ni recibo real de Telegram
verificado por esta entrega. El acceso a la consola desde el navegador disponible
devolvió `Site Unavailable`. Estos archivos no aprovisionan ni contratan recursos.

## Condición económica previa

Confirmar en la consola el **ID del proyecto**, que su cuenta de facturación siga
en **Free Trial**, el crédito restante y su fecha de vencimiento. Tener una cuenta
de Google Cloud o ver crédito no demuestra por sí solo que no se haya convertido
a pago. No pulsar Upgrade/Activar cuenta de pago. No crear recursos si está en
modalidad de pago sin un presupuesto nuevo autorizado.

La prueba elegible ofrece 300 USD hasta 90 días; sin conversión a pago, al agotarse
el crédito o plazo se detienen los recursos. La VM, disco, IPv4 y tráfico pueden
consumir crédito: no se promete alojamiento gratuito indefinido. Una alerta de
presupuesto informa del consumo, no es un límite duro de gasto. Registrar estos
datos antes del aprovisionamiento y revisar consumo durante la prueba.

## Diseño de instalación

Un proyecto dedicado y una sola VM Linux Compute Engine para este monitor.
Configuración inicial propuesta: e2-micro, us-central1, Debian 12, disco estándar
20 GB, Node 24. Confirmar disponibilidad y estimación completa en esa cuenta
antes de crearla. No usar Spot, GPU, balanceador, Cloud SQL ni Cloud Shell como
servidor permanente. Cloud Shell puede servir únicamente para instalar/administrar.
Medir carga real; este tamaño es una hipótesis de partida, no una garantía.

El proceso necesita conexiones salientes hacia Kraken, Telegram y el Supabase
de staging existente. No necesita servidor HTTP, dominio, puertos web entrantes
ni credenciales de exchange. No asignar una cuenta de servicio con acceso general
al proyecto. Mantener SSH restringido; preferir acceso administrado por IAP/OS Login
según los permisos existentes. No abrir SSH a todo Internet.

El guard de arranque consulta exclusivamente tres claves de metadata de la VM
(`project/project-id`, `instance/id`, `instance/zone`) y compara los valores con
la configuración aprobada. Tiene timeout de dos segundos, no sigue redirecciones
y exige la cabecera de respuesta `Metadata-Flavor: Google`. No consulta tokens
de cuentas de servicio. Una identidad distinta o metadata no accesible impide
arrancar antes de abrir Supabase o iniciar el feed.

Se conservan los límites PAPER/staging, la prohibición de claves privadas Kraken,
el lease y fencing en Supabase, la cola durable, los controles de frescura y el
destinatario privado. Render conserva su guard anterior por defecto. No se
falsifican variables de Render para arrancar en otra plataforma. Estos controles
evitan errores de despliegue; no constituyen una atestación criptográfica del host.

## Preparación del host, una vez verificada la cuenta

1. Registrar identidad numérica de la VM, proyecto y zona. Crear usuario de sistema
   `lumitrading`, sin privilegios administrativos ni inicio de sesión interactivo.
2. Instalar Node 24 desde su distribución oficial, verificando checksum, en
   `/usr/local/bin/node`; comprobar la versión. La unidad fija un PATH de directorios
   administrados por root. Instalar una revisión exacta y revisada de esta
   rama en `/opt/lumi-trading/releases/<SHA>`; comprobar `git rev-parse HEAD`.
   No ejecutar `server.js`. Usar `npm ci --omit=dev --ignore-scripts` y conservar
   código/dependencias propiedad de root, legibles pero no modificables por el worker.
3. Enlazar `/opt/lumi-trading/current` a esa revisión. No hacer pulls automáticos.
4. Copiar `deploy/trading/worker.env.example` a `/etc/lumi-trading/worker.env` con
   dueño root y permisos 0600. Completar las identidades y transferir las variables
   existentes de staging por un canal seguro. No guardar secretos en Git, historial
   del shell, metadata de la VM, capturas, documentos o chat. No crear/copiar claves
   privadas de Google Cloud ni de Kraken. No inventar bot, propietario ni token.
5. Instalar `deploy/trading/lumi-trading.service` en `/etc/systemd/system/`.
   La unidad supervisa el proceso, limita memoria y escribe los logs en journald.
   Configurar retención acotada de logs del host y sincronización de reloj.
6. Comprobar acceso a las tablas/RPC ya existentes de staging; no volver a aplicar
   migraciones a ciegas. Confirmar que no existe otro worker activo. Mantener
   `LUMI_TRADING_ALERTS=false` en la primera comprobación.

Comandos de operación una vez completados los pasos anteriores:

```sh
sudo systemd-analyze verify /etc/systemd/system/lumi-trading.service
sudo systemctl daemon-reload
sudo systemctl enable --now lumi-trading.service
sudo systemctl status lumi-trading.service --no-pager
sudo journalctl -u lumi-trading.service --since '10 minutes ago' --no-pager
```

El archivo de entorno lo lee systemd; no debe hacerse `source` ni imprimir su
contenido. Para parar sin borrar historial: `sudo systemctl stop lumi-trading`.
Cinco fallos en diez minutos frenan reinicios repetidos; investigar el error antes
de `systemctl reset-failed`. Un proceso activo todavía no prueba un feed sano.

## Verificación de activación pendiente

- Observar feed conectado, reloj válido, reconciliación y cotizaciones/trades
  frescos. Nunca usar el bootstrap como precio actual ni reenviar señales viejas.
- Confirmar escrituras/checkpoints/lease de staging y recuperación tras reinicio.
  El segundo proceso debe rechazar el lease; no se eliminan leases para forzarlo.
- Habilitar `LUMI_TRADING_ALERTS=true` mediante edición segura y reinicio controlado.
  Exigir el recibo real de la prueba técnica (message_id y estado DELIVERED), sin
  duplicarla si el envío quedó UNKNOWN. No confundir recepción API con lectura.
- Conservar métricas de CPU, RSS, latencia y errores durante observación sostenida.
  Revisar consumo de crédito. Si no aparece setup válido, informar SIN OPORTUNIDAD
  VÁLIDA; nunca forzar una entrada para demostrar funcionamiento.
- Registrar revisión desplegada, identidad de la VM, evidencia de reinicio y estado
  de Telegram. Probabilidad sigue NO DISPONIBLE; no hay estrategia validada.

Nada de esta instalación cambia Mini App, panel 148, webhook, menús, callbacks,
transporte audiovisual, main o producción. Las operaciones continúan simuladas.

## Validación local de esta preparación

Node 24: 83 pruebas aprobadas (54 existentes y 29 de aislamiento/identidad del
runtime), con `node --test test/trading-*.test.js test/lumi-direct-telegram.test.js
test/lumi-mini-app-auth.test.js`. Metadata, Telegram y operaciones son fixtures
en estas pruebas; no son evidencia de despliegue ni de una operación de mercado.
También se comprueban sintaxis JavaScript, whitespace del diff y sintaxis de la
unidad con `systemd-analyze verify`. No se presenta la suite general de Lumi
como aprobada ni se ha arrancado el servicio systemd en una VM real.

Fuentes oficiales consultadas: [prueba gratuita](https://docs.cloud.google.com/free/docs/free-cloud-features),
[metadata de Compute Engine](https://docs.cloud.google.com/compute/docs/metadata/querying-metadata).
