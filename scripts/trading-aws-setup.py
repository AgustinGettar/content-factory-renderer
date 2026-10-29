#!/usr/bin/env python3
"""CloudShell installer. No AWS keys, IAM changes, plan upgrades or real orders."""
import argparse
import base64
import datetime as dt
import fcntl
import getpass
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request

REGION = 'eu-north-1'
MANAGER = 'lumi-trading-aws-v1'
NAME = 'lumi-trading-paper-v1'
ROOT = Path(__file__).resolve().parents[1]


class SetupError(Exception):
    pass


class AWS:
    def __call__(self, service, operation, params=None, region=REGION):
        cmd = ['aws', service, operation, '--region', region, '--output', 'json',
               '--no-cli-pager', '--cli-input-json', json.dumps(params or {})]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90,
                                env={**os.environ, 'AWS_PAGER': '', 'AWS_CLI_AUTO_PROMPT': 'off'})
        if result.returncode:
            code = re.search(r'An error occurred \(([^)]+)\)', result.stderr)
            raise SetupError(f'AWS_{service}_{operation}: {code.group(1) if code else "COMMAND_FAILED"}')
        return json.loads(result.stdout or '{}')


def validate_plan(plan, account, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    if plan.get('accountId') != account or plan.get('accountPlanType') != 'FREE' or plan.get('accountPlanStatus') != 'ACTIVE':
        raise SetupError('ACTIVE_FREE_PLAN_REQUIRED: no se crearon recursos ni se cambió el plan.')
    credit = plan.get('accountPlanRemainingCredits', {})
    amount = credit.get('amount')
    if credit.get('unit') != 'USD' or isinstance(amount, bool) or not isinstance(amount, (int, float)) or not 10 <= amount <= 100000:
        raise SetupError('AT_LEAST_10_USD_CREDIT_REQUIRED')
    try:
        expiry = dt.datetime.fromisoformat(plan['accountPlanExpirationDate'].replace('Z', '+00:00'))
        if expiry.tzinfo is None or expiry <= now:
            raise ValueError()
    except (KeyError, TypeError, ValueError, AttributeError):
        raise SetupError('VALID_FREE_PLAN_EXPIRY_REQUIRED') from None
    return {'plan': 'FREE', 'credits_usd': amount, 'expires_at': expiry.isoformat(), 'region': REGION}


def preflight(aws):
    account = aws('sts', 'get-caller-identity')['Account']
    if not re.fullmatch(r'\d{12}', account):
        raise SetupError('INVALID_ACCOUNT_ID')
    plan = aws('freetier', 'get-account-plan-state', region='us-east-1')
    return account, validate_plan(plan, account)


def tags(revision):
    return [{'Key': 'Name', 'Value': NAME}, {'Key': 'ManagedBy', 'Value': MANAGER},
            {'Key': 'TradingMode', 'Value': 'PAPER'}, {'Key': 'SourceSHA', 'Value': revision}]


def existing_instance(aws, revision):
    result = aws('ec2', 'describe-instances', {'Filters': [
        {'Name': 'tag:ManagedBy', 'Values': [MANAGER]},
        {'Name': 'instance-state-name', 'Values': ['pending', 'running', 'stopping', 'stopped', 'shutting-down']} ]})
    items = [i for r in result.get('Reservations', []) for i in r['Instances']]
    if len(items) > 1:
        raise SetupError('MULTIPLE_WORKERS_FOUND: no se modifica ninguno.')
    if not items:
        return None
    i = items[0]
    labels = {t['Key']: t['Value'] for t in i.get('Tags', [])}
    if i.get('InstanceType') != 't3.micro' or labels.get('SourceSHA') != revision or labels.get('TradingMode') != 'PAPER':
        raise SetupError('EXISTING_WORKER_CONFIGURATION_DIFFERS: no se reemplaza.')
    return i


def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)


def build_launch(account, revision, image, subnet, group, bootstrap):
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise SetupError('EXACT_GIT_REVISION_REQUIRED')
    script = bootstrap.replace('__SOURCE_SHA__', revision).replace('__ACCOUNT_ID__', account).replace('__REGION__', REGION)
    if '__SOURCE_SHA__' in script or len(script.encode()) > 16384:
        raise SetupError('INVALID_BOOTSTRAP')
    return {
        'ImageId': image['ImageId'], 'InstanceType': 't3.micro', 'MinCount': 1, 'MaxCount': 1,
        'ClientToken': f'{MANAGER}-{account}-{REGION}',
        'NetworkInterfaces': [{'DeviceIndex': 0, 'SubnetId': subnet, 'Groups': [group],
                               'AssociatePublicIpAddress': True, 'DeleteOnTermination': True}],
        'BlockDeviceMappings': [{'DeviceName': image['RootDeviceName'], 'Ebs': {
            'VolumeSize': 8, 'VolumeType': 'gp3', 'Encrypted': True, 'DeleteOnTermination': True}}],
        'CreditSpecification': {'CpuCredits': 'standard'},
        'MetadataOptions': {'HttpTokens': 'required', 'HttpEndpoint': 'enabled', 'HttpPutResponseHopLimit': 1},
        'Monitoring': {'Enabled': False}, 'InstanceInitiatedShutdownBehavior': 'stop',
        'TagSpecifications': [{'ResourceType': kind, 'Tags': tags(revision)} for kind in ['instance', 'volume']],
        'UserData': base64.b64encode(script.encode()).decode(),
    }


def provision(aws, state, revision):
    account, summary = preflight(aws)
    print(json.dumps(summary, ensure_ascii=False))
    previous = existing_instance(aws, revision)
    if previous:
        return previous
    request_path = state / 'launch-request.json'
    if request_path.exists():
        request = json.loads(request_path.read_text())
        if request.get('ClientToken') != f'{MANAGER}-{account}-{REGION}' or request.get('TagSpecifications', [{}])[0].get('Tags') != tags(revision):
            raise SetupError('SAVED_LAUNCH_MISMATCH')
    else:
        vpcs = aws('ec2', 'describe-vpcs', {'Filters': [{'Name': 'is-default', 'Values': ['true']}]})['Vpcs']
        if len(vpcs) != 1:
            raise SetupError('DEFAULT_VPC_REQUIRED: no se crean ni modifican redes existentes.')
        vpc = vpcs[0]['VpcId']
        subnets = aws('ec2', 'describe-subnets', {'Filters': [{'Name': 'vpc-id', 'Values': [vpc]},
                    {'Name': 'default-for-az', 'Values': ['true']}, {'Name': 'state', 'Values': ['available']}]})['Subnets']
        if not subnets:
            raise SetupError('DEFAULT_SUBNET_REQUIRED')
        subnet = sorted(subnets, key=lambda s: s['AvailabilityZone'])[0]['SubnetId']
        ami = aws('ssm', 'get-parameter', {'Name': '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64'})['Parameter']['Value']
        images = aws('ec2', 'describe-images', {'ImageIds': [ami], 'Owners': ['amazon'],
                     'Filters': [{'Name': 'free-tier-eligible', 'Values': ['true']}]})['Images']
        if len(images) != 1 or images[0].get('Architecture') != 'x86_64' or images[0].get('State') != 'available':
            raise SetupError('OFFICIAL_FREE_TIER_AMI_REQUIRED')
        image = images[0]
        root = next((b.get('Ebs', {}).get('VolumeSize', 0) for b in image.get('BlockDeviceMappings', []) if b['DeviceName'] == image['RootDeviceName']), 0)
        if not 0 < root <= 8:
            raise SetupError('AMI_ROOT_VOLUME_EXCEEDS_8_GIB')
        kinds = aws('ec2', 'describe-instance-types', {'InstanceTypes': ['t3.micro'],
                    'Filters': [{'Name': 'free-tier-eligible', 'Values': ['true']}]})['InstanceTypes']
        if len(kinds) != 1:
            raise SetupError('FREE_TIER_T3_MICRO_REQUIRED')
        groups = aws('ec2', 'describe-security-groups', {'Filters': [{'Name': 'group-name', 'Values': [NAME]},
                    {'Name': 'vpc-id', 'Values': [vpc]}]})['SecurityGroups']
        if groups:
            if len(groups) != 1 or {t['Key']: t['Value'] for t in groups[0].get('Tags', [])}.get('ManagedBy') != MANAGER or groups[0].get('IpPermissions'):
                raise SetupError('SECURITY_GROUP_NAME_CONFLICT')
            group = groups[0]['GroupId']
        else:
            group = aws('ec2', 'create-security-group', {'GroupName': NAME,
                'Description': 'Lumi paper monitor; no inbound access by default', 'VpcId': vpc,
                'TagSpecifications': [{'ResourceType': 'security-group', 'Tags': tags(revision)}]})['GroupId']
        request = build_launch(account, revision, image, subnet, group,
                               (ROOT / 'deploy/trading/aws-bootstrap.sh').read_text())
        atomic_json(request_path, request)
    # The exact request and client token survive an ambiguous RunInstances reply.
    instance = aws('ec2', 'run-instances', request)['Instances'][0]
    atomic_json(state / 'instance.json', {'instance_id': instance['InstanceId'], 'region': REGION,
                                       'account_id': account, 'revision': revision})
    return instance


def host_key_from_console(output):
    keys = re.findall(r'^LUMI_SSH_HOST_ED25519=(ssh-ed25519 [A-Za-z0-9+/=]+)', output, re.M)
    if not keys:
        raise SetupError('HOST_STILL_PREPARING: espere y vuelva a ejecutar status/configure.')
    if len(set(keys)) != 1:
        raise SetupError('AMBIGUOUS_SSH_HOST_KEY')
    return keys[0]


def configure(aws, revision, action='configure'):
    _, summary = preflight(aws)
    print(json.dumps(summary, ensure_ascii=False))
    i = existing_instance(aws, revision)
    if not i or i['State']['Name'] != 'running':
        raise SetupError('RUNNING_WORKER_REQUIRED')
    output = aws('ec2', 'get-console-output', {'InstanceId': i['InstanceId'], 'Latest': True}).get('Output', '')
    host_key = host_key_from_console(output)
    if 'LUMI_TRADING_HOST_PREPARED' not in output:
        raise SetupError('HOST_STILL_PREPARING')
    public_ip = str(ipaddress.IPv4Address(i['PublicIpAddress']))
    if len(i.get('SecurityGroups', [])) != 1 or i['SecurityGroups'][0]['GroupName'] != NAME:
        raise SetupError('DEDICATED_SECURITY_GROUP_REQUIRED')
    group = i['SecurityGroups'][0]['GroupId']
    with urllib.request.urlopen('https://checkip.amazonaws.com/', timeout=10) as response:
        caller_ip = str(ipaddress.IPv4Address(response.read(100).decode().strip()))
    secrets = {}
    if action == 'configure':
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise SetupError('INTERACTIVE_TERMINAL_REQUIRED: no se permite entrada con eco visible.')
        print('Pegue los valores existentes de staging SOLO aquí. Entrada oculta; no se guardan en CloudShell.')
        secrets = {key: getpass.getpass(label + ': ') for key, label in [
            ('SUPABASE_SERVICE_ROLE_KEY', 'Supabase service_role de staging'),
            ('LUMI_TELEGRAM_BOT_TOKEN', 'Token del bot existente de Lumi'),
            ('LUMI_TELEGRAM_REVIEW_TEST_USERS', 'ID privado permitido existente (número)') ]}
        if any(not value for value in secrets.values()):
            raise SetupError('CONFIGURATION_CANCELLED')
    rule_ids = []
    attempted_grant = False
    with tempfile.TemporaryDirectory(prefix='lumi-ssh-') as temp:
        temp = Path(temp)
        key = temp / 'key'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True)
        known = temp / 'known_hosts'
        known.write_text(i['InstanceId'] + ' ' + host_key + '\n')
        try:
            permission = {'IpProtocol': 'tcp', 'FromPort': 22, 'ToPort': 22,
                          'IpRanges': [{'CidrIp': caller_ip + '/32', 'Description': 'lumi-trading-temporary-configure'}]}
            attempted_grant = True
            grant = aws('ec2', 'authorize-security-group-ingress', {'GroupId': group, 'IpPermissions': [permission]})
            rule_ids = [r['SecurityGroupRuleId'] for r in grant.get('SecurityGroupRules', [])]
            if not rule_ids:
                raise SetupError('TEMPORARY_SSH_RULE_RECEIPT_REQUIRED')
            result = aws('ec2-instance-connect', 'send-ssh-public-key', {
                'InstanceId': i['InstanceId'], 'InstanceOSUser': 'ec2-user',
                'AvailabilityZone': i['Placement']['AvailabilityZone'], 'SSHPublicKey': key.with_suffix('.pub').read_text()})
            if not result.get('Success'):
                raise SetupError('EPHEMERAL_SSH_KEY_REJECTED')
            remote_script = 'trading-aws-inspect.py' if action == 'verify' else 'trading-aws-configure.py'
            cmd = ['ssh', '-i', str(key), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                   '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known),
                   '-o', 'HostKeyAlias=' + i['InstanceId'], '-o', 'ConnectTimeout=15',
                   'ec2-user@' + public_ip, 'sudo /usr/bin/python3 /opt/lumi-trading/current/scripts/' + remote_script]
            completed = subprocess.run(cmd, input=json.dumps(secrets), text=True, timeout=180)
            if completed.returncode:
                raise SetupError('CONFIGURATION_NOT_CONFIRMED: revise status; no se reenvían alertas a ciegas.')
        finally:
            secrets.clear()
            if rule_ids:
                aws('ec2', 'revoke-security-group-ingress', {'GroupId': group, 'SecurityGroupRuleIds': rule_ids})
            elif attempted_grant:
                # Also close a possibly accepted rule if its API response was lost.
                try:
                    aws('ec2', 'revoke-security-group-ingress', {'GroupId': group, 'IpPermissions': [permission]})
                except SetupError as error:
                    if 'InvalidPermission.NotFound' not in str(error):
                        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['check', 'provision', 'status', 'configure', 'resume', 'verify'])
    args = parser.parse_args()
    os.umask(0o077)
    aws = AWS()
    if args.action == 'check':
        print(json.dumps(preflight(aws)[1], ensure_ascii=False, indent=2))
        return
    revision = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise SetupError('EXACT_GIT_REVISION_REQUIRED')
    state = Path.home() / 'lumi-trading-cloud-state' / REGION
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'setup.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.action in ['configure', 'resume', 'verify']:
            configure(aws, revision, args.action)
            return
        if args.action == 'provision':
            i = provision(aws, state, revision)
        else:
            i = existing_instance(aws, revision)
        if not i:
            print('NO_WORKER_CREATED')
            return
        print(json.dumps({'instance_id': i['InstanceId'], 'state': i['State']['Name'], 'region': REGION,
                          'revision': revision, 'trading_active_verified': False}, indent=2))
        if args.action == 'status' and i['State']['Name'] == 'running':
            output = aws('ec2', 'get-console-output', {'InstanceId': i['InstanceId'], 'Latest': True}).get('Output', '')
            print('HOST_PREPARED' if 'LUMI_TRADING_HOST_PREPARED' in output else 'HOST_PREPARING_OR_INSTALL_FAILED')
        print('La VM consume crédito. Tras prepararse, ejecute configure; hasta entonces el bot no está activo.')


if __name__ == '__main__':
    try:
        main()
    except (SetupError, subprocess.SubprocessError, KeyError, ValueError, OSError) as error:
        print(str(error) if isinstance(error, SetupError) else 'SETUP_FAILED: no se ha confirmado la operación. No cree otra VM.')
        raise SystemExit(1)
