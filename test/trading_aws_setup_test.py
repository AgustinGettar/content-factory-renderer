import base64
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
setup=load('aws_setup','scripts/trading-aws-setup.py')
configure=load('aws_configure','scripts/trading-aws-configure.py')
inspect=load('aws_inspect','scripts/trading-aws-inspect.py')
ACCOUNT='123456789012'
SHA='a'*40
PLAN={'accountId':ACCOUNT,'accountPlanType':'FREE','accountPlanStatus':'ACTIVE',
      'accountPlanRemainingCredits':{'amount':100,'unit':'USD'},'accountPlanExpirationDate':'2099-04-29T00:00:00Z'}
INSTANCE={'InstanceId':'i-1234567890abcdef0','InstanceType':'t3.micro','State':{'Name':'pending'},'Tags':setup.tags(SHA)}


class FakeAWS:
    def __init__(self,plan=None,instances=None,fail_launch=False):
        self.calls=[];self.plan=copy.deepcopy(PLAN if plan is None else plan)
        self.instances=instances or [];self.fail_launch=fail_launch
    def __call__(self,service,operation,params=None,**kwargs):
        self.calls.append((service,operation,copy.deepcopy(params)))
        if operation=='get-caller-identity':return {'Account':ACCOUNT}
        if operation=='get-account-plan-state':return self.plan
        if operation=='describe-instances':return {'Reservations':[{'Instances':self.instances}]}
        if operation=='describe-vpcs':return {'Vpcs':[{'VpcId':'vpc-test'}]}
        if operation=='describe-subnets':return {'Subnets':[{'SubnetId':'subnet-test','AvailabilityZone':'eu-north-1a'}]}
        if operation=='get-parameter':return {'Parameter':{'Value':'ami-test'}}
        if operation=='describe-images':return {'Images':[{'ImageId':'ami-test','RootDeviceName':'/dev/xvda',
            'Architecture':'x86_64','State':'available','BlockDeviceMappings':[{'DeviceName':'/dev/xvda','Ebs':{'VolumeSize':8}}]}]}
        if operation=='describe-instance-types':return {'InstanceTypes':[{'InstanceType':'t3.micro'}]}
        if operation=='describe-security-groups':return {'SecurityGroups':[]}
        if operation=='create-security-group':return {'GroupId':'sg-test'}
        if operation=='run-instances':
            if self.fail_launch:raise setup.SetupError('AMBIGUOUS_RUN_INSTANCES_RESPONSE')
            return {'Instances':[copy.deepcopy(INSTANCE)]}
        raise AssertionError(operation)


class FreePlanTests(unittest.TestCase):
    def test_active_plan_is_required_before_any_write(self):
        for field,value in [('accountPlanType','PAID'),('accountPlanStatus','EXPIRED'),('accountPlanStatus','NOT_STARTED'),('accountId','999999999999')]:
            plan=copy.deepcopy(PLAN);plan[field]=value;aws=FakeAWS(plan)
            with self.subTest(field=field,value=value),tempfile.TemporaryDirectory() as temp:
                with self.assertRaises(setup.SetupError):setup.provision(aws,Path(temp),SHA)
                self.assertEqual([c[1] for c in aws.calls],['get-caller-identity','get-account-plan-state'])
    def test_credit_and_expiration_validation(self):
        for credit in [{},{'amount':0,'unit':'USD'},{'amount':100,'unit':'EUR'},{'amount':'100','unit':'USD'},{'amount':float('nan'),'unit':'USD'}]:
            plan={**PLAN,'accountPlanRemainingCredits':credit}
            with self.subTest(credit=credit),self.assertRaises(setup.SetupError):setup.validate_plan(plan,ACCOUNT)
        for expiry in [None,'not-a-date','2000-01-01T00:00:00Z','2099-01-01']:
            with self.subTest(expiry=expiry),self.assertRaises(setup.SetupError):
                setup.validate_plan({**PLAN,'accountPlanExpirationDate':expiry},ACCOUNT)
        self.assertEqual(setup.validate_plan(PLAN,ACCOUNT)['credits_usd'],100)
    def test_provision_uses_one_small_instance_no_role_or_secret(self):
        aws=FakeAWS()
        with tempfile.TemporaryDirectory() as temp,patch('sys.stdout',new_callable=io.StringIO):
            self.assertEqual(setup.provision(aws,Path(temp),SHA)['InstanceId'],INSTANCE['InstanceId'])
            req=json.loads((Path(temp)/'launch-request.json').read_text())
        self.assertEqual(req['MinCount'],1);self.assertEqual(req['MaxCount'],1)
        self.assertEqual(req['InstanceType'],'t3.micro');self.assertNotIn('IamInstanceProfile',req)
        self.assertNotIn('KeyName',req);self.assertEqual(req['CreditSpecification']['CpuCredits'],'standard')
        self.assertEqual(req['MetadataOptions']['HttpTokens'],'required')
        self.assertEqual(req['BlockDeviceMappings'][0]['Ebs']['VolumeSize'],8)
        text=base64.b64decode(req['UserData']).decode()
        self.assertNotIn('SUPABASE_SERVICE_ROLE_KEY',text);self.assertNotIn('LUMI_TELEGRAM_BOT_TOKEN',text)
        self.assertNotIn('__SOURCE_SHA__',text);self.assertIn(SHA,text)
        self.assertFalse(any(c[1].startswith(('attach','upgrade','authorize')) for c in aws.calls))
    def test_repeated_provision_reuses_existing_and_never_launches(self):
        aws=FakeAWS(instances=[INSTANCE])
        with tempfile.TemporaryDirectory() as temp,patch('sys.stdout',new_callable=io.StringIO):
            setup.provision(aws,Path(temp),SHA)
        self.assertNotIn('run-instances',[c[1] for c in aws.calls])
    def test_ambiguous_launch_replays_identical_saved_request(self):
        first=FakeAWS(fail_launch=True);second=FakeAWS()
        with tempfile.TemporaryDirectory() as temp,patch('sys.stdout',new_callable=io.StringIO):
            path=Path(temp)
            with self.assertRaises(setup.SetupError):setup.provision(first,path,SHA)
            setup.provision(second,path,SHA)
        a=next(c[2] for c in first.calls if c[1]=='run-instances')
        b=next(c[2] for c in second.calls if c[1]=='run-instances')
        self.assertEqual(a,b)
        self.assertNotIn('create-security-group',[c[1] for c in second.calls])
    def test_existing_duplicates_or_unexpected_revision_stop(self):
        for instances in [[INSTANCE,INSTANCE],[{**INSTANCE,'InstanceType':'t3.small'}],[{**INSTANCE,'Tags':setup.tags('b'*40)}]]:
            aws=FakeAWS(instances=instances)
            with self.subTest(instances=instances),self.assertRaises(setup.SetupError):setup.existing_instance(aws,SHA)
    def test_saved_request_cannot_move_to_another_account(self):
        aws=FakeAWS()
        with tempfile.TemporaryDirectory() as temp,patch('sys.stdout',new_callable=io.StringIO):
            path=Path(temp);setup.atomic_json(path/'launch-request.json',{'ClientToken':'another-account'})
            with self.assertRaises(setup.SetupError):setup.provision(aws,path,SHA)
        self.assertNotIn('run-instances',[c[1] for c in aws.calls])


class SecretTransportTests(unittest.TestCase):
    def test_health_output_filters_arbitrary_logs_and_preserves_sample_time(self):
        rows='not json\n'+json.dumps({'MESSAGE':json.dumps({'event':'lumi_trading_health','connected':True,'revision':4,'SECRET':'never print'}),'__REALTIME_TIMESTAMP':'1000000'})
        self.assertEqual(inspect.sanitize_health(rows),{'event':'lumi_trading_health','connected':True,'revision':4,'logged_at_ms':1000})
    def test_ssh_failure_revokes_only_temporary_rule_and_never_sends_secrets_in_aws_requests(self):
        instance={**INSTANCE,'State':{'Name':'running'},'PublicIpAddress':'198.51.100.2',
                  'SecurityGroups':[{'GroupId':'sg-test','GroupName':setup.NAME}],'Placement':{'AvailabilityZone':'eu-north-1a'}}
        aws=FakeAWS(instances=[instance]);calls=[]
        def invoke(service,operation,params=None,**kwargs):
            if operation in ['get-console-output','authorize-security-group-ingress','send-ssh-public-key','revoke-security-group-ingress']:
                calls.append((operation,params))
                return {'get-console-output':{'Output':'LUMI_SSH_HOST_ED25519=ssh-ed25519 AAAATEST\nLUMI_TRADING_HOST_PREPARED'},
                        'authorize-security-group-ingress':{'SecurityGroupRules':[{'SecurityGroupRuleId':'sgr-temp'}]},
                        'send-ssh-public-key':{'Success':True},'revoke-security-group-ingress':{}}[operation]
            return aws(service,operation,params,**kwargs)
        secret='OFFLINE_SECRET_VALUE'
        def run(cmd,**kwargs):
            self.assertNotIn(secret,json.dumps(cmd))
            if cmd[0]=='ssh-keygen':
                Path(cmd[-1]+'.pub').write_text('ssh-ed25519 AAAAOFFLINE');return subprocess_result(0)
            self.assertIn('StrictHostKeyChecking=yes',cmd)
            self.assertIn(secret,kwargs['input'])
            return subprocess_result(255)
        def subprocess_result(code):
            return type('Result',(),{'returncode':code})()
        with patch.object(setup.sys.stdin,'isatty',return_value=True),patch.object(setup.sys.stderr,'isatty',return_value=True),\
             patch.object(setup.urllib.request,'urlopen',return_value=io.BytesIO(b'203.0.113.4')),\
             patch.object(setup.getpass,'getpass',return_value=secret),patch.object(setup.subprocess,'run',side_effect=run),\
             patch('sys.stdout',new_callable=io.StringIO):
            with self.assertRaises(setup.SetupError):setup.configure(invoke,SHA)
        self.assertNotIn(secret,json.dumps(calls))
        self.assertEqual(calls[-1],('revoke-security-group-ingress',{'GroupId':'sg-test','SecurityGroupRuleIds':['sgr-temp']}))
    def test_ssh_host_key_requires_authenticated_console_evidence(self):
        key='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOfflineFixture'
        self.assertEqual(setup.host_key_from_console('LUMI_SSH_HOST_ED25519='+key+' host\n'),key)
        for output in ['', 'INSTALL_FAILED', 'LUMI_SSH_HOST_ED25519='+key+'\nLUMI_SSH_HOST_ED25519=ssh-ed25519 OTHER\n']:
            with self.assertRaises(setup.SetupError):setup.host_key_from_console(output)
    def test_secret_input_is_narrow_and_rejects_env_injection(self):
        data={'SUPABASE_SERVICE_ROLE_KEY':'a'*80,'LUMI_TELEGRAM_BOT_TOKEN':'123456789:'+('b'*35),'LUMI_TELEGRAM_REVIEW_TEST_USERS':'12345678'}
        self.assertEqual(configure.validate_secrets(data)['LUMI_TELEGRAM_BOT_ID'],'123456789')
        for patch_value in [{'SUPABASE_SERVICE_ROLE_KEY':'abc\nLUMI_TRADING_MODE=REAL'},
                            {'LUMI_TELEGRAM_REVIEW_TEST_USERS':'123,456'}, {'KRAKEN_API_KEY':'unexpected'}]:
            with self.subTest(patch=patch_value),self.assertRaises(ValueError):configure.validate_secrets({**data,**patch_value})


if __name__=='__main__':unittest.main()
