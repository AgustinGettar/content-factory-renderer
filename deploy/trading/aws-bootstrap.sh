#!/bin/bash
# EC2 user data contains public code and deployment identity, never secrets.
set -Eeuo pipefail
umask 022
exec > >(tee -a /var/log/lumi-trading-install.log /dev/console) 2>&1
trap 'echo LUMI_TRADING_HOST_INSTALL_FAILED' ERR

# Stop an unfinished installation after two hours. Disk persists and consumes
# a small amount of credit; this is not a billing cap for the AWS account.
cat >/etc/systemd/system/lumi-trading-install-expiry.service <<'UNIT'
[Unit]
Description=Stop an unconfigured Lumi trial host
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'test -f /etc/lumi-trading/worker.env || /usr/sbin/shutdown -h now'
UNIT
cat >/etc/systemd/system/lumi-trading-install-expiry.timer <<'UNIT'
[Unit]
Description=Limit idle time before Lumi configuration
[Timer]
OnBootSec=2h
Unit=lumi-trading-install-expiry.service
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now lumi-trading-install-expiry.timer

dnf install -y nodejs24 nodejs24-npm nodejs24-full-i18n git python3
alternatives --set node /usr/bin/node-24
id lumitrading >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin lumitrading
install -d -m 0755 /opt/lumi-trading/releases
install -d -m 0700 /etc/lumi-trading
git clone --single-branch --branch lumi-trading-aws --no-checkout \
  https://github.com/AgustinGettar/content-factory-renderer.git /opt/lumi-trading/releases/__SOURCE_SHA__
git -C /opt/lumi-trading/releases/__SOURCE_SHA__ checkout --detach __SOURCE_SHA__
cd /opt/lumi-trading/releases/__SOURCE_SHA__
test "$(git rev-parse HEAD)" = __SOURCE_SHA__
npm-24 ci --omit=dev --ignore-scripts
ln -s /opt/lumi-trading/releases/__SOURCE_SHA__ /opt/lumi-trading/current
install -m 0644 deploy/trading/lumi-trading.service /etc/systemd/system/lumi-trading.service
install -d -m 0755 /etc/systemd/system/lumi-trading.service.d
cat >/etc/systemd/system/lumi-trading.service.d/node24.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/bin/node-24 --max-old-space-size=192 scripts/trading-worker.mjs
UNIT
install -d -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/lumi-trading.conf <<'CONF'
[Journal]
SystemMaxUse=50M
RuntimeMaxUse=20M
CONF
systemctl restart systemd-journald

python3 - <<'PY'
import json, os, urllib.request
base='http://169.254.169.254/latest/'
req=urllib.request.Request(base+'api/token',method='PUT',headers={'X-aws-ec2-metadata-token-ttl-seconds':'60'})
with urllib.request.urlopen(req,timeout=3) as r: token=r.read().decode()
req=urllib.request.Request(base+'dynamic/instance-identity/document',headers={'X-aws-ec2-metadata-token':token})
with urllib.request.urlopen(req,timeout=3) as r: identity=json.load(r)
assert identity['accountId']=='__ACCOUNT_ID__' and identity['region']=='__REGION__'
values={'LUMI_TRADING_PLATFORM':'EC2','LUMI_RUNTIME_ENV':'staging','LUMI_TRADING_MODE':'PAPER',
  'LUMI_TRADING_SOURCE_BRANCH':'lumi-trading-aws','LUMI_TRADING_AWS_ACCOUNT_ID':identity['accountId'],
  'LUMI_TRADING_AWS_INSTANCE_ID':identity['instanceId'],'LUMI_TRADING_AWS_REGION':identity['region'],
  'SUPABASE_URL':'https://mofjhwathxzfnjapvvst.supabase.co','LUMI_TELEGRAM_TRANSPORT_AUTHORITY':'DIRECT'}
os.umask(0o077)
with open('/etc/lumi-trading/worker.identity','x') as f:
  f.write(''.join(k+'='+v+'\n' for k,v in values.items()))
PY
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/lumi-trading.service
printf 'LUMI_SSH_HOST_ED25519='
cat /etc/ssh/ssh_host_ed25519_key.pub
echo LUMI_TRADING_HOST_PREPARED
# Service remains off until the existing private staging credentials are checked.
