import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('neural_publish',Path(__file__).parents[1]/'scripts/trading-neural-publish.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
REAL_RUN=module.subprocess.run
REPOSITORY=Path(__file__).parents[1]

class NeuralPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'private';self.stage=Path(self.temp.name)/'stage';self.stage.mkdir()
        self.now=1793622000000;self.sha='a'*40
        self.manifest={'version':module.VERSION,'mode':'PAPER','realTrading':False,'created_at':self.now,'source':{'source_id':'ISOLATED_TEST','revision':4,'cursor':20},'files':[],'model_id':None,'candidate_id':None}
        self.add('DATASET_CHECKPOINT','dataset-checkpoint.json',{'mode':'PAPER','cursor':20})
        self.add('TRAINING_CHECKPOINT','training-checkpoint.json',{'mode':'PAPER','processed':[]})
        self.add('STATUS','status.json',{'version':'secondary-neural-training-status-1.0.0','mode':'PAPER','realTrading':False,'at':self.now,'status':'COLLECTING','revoked_model_ids':[]})
        def commands(args,**kwargs):
            if args[0]=='git':return SimpleNamespace(stdout=self.sha+'\n')
            return REAL_RUN(args,**kwargs)
        self.commit_patch=patch.object(module.subprocess,'run',side_effect=commands);self.commands=self.commit_patch.start();self.addCleanup(self.commit_patch.stop)
    def add(self,role,name,value):
        raw=(json.dumps(value)+'\n').encode();(self.stage/name).write_bytes(raw)
        self.manifest['files']=[f for f in self.manifest['files'] if f['role']!=role]
        self.manifest['files'].append({'role':role,'name':name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
    def save(self):
        (self.stage/'publication-manifest.json').write_text(json.dumps(self.manifest))
    def publish(self,**kwargs):
        self.save();return module.publish(self.stage,expected_commit=self.sha,root=self.root,current=REPOSITORY,owner=None,now=self.now,**kwargs)
    def model(self,*,corrupt=False):
        # Synthetic weights in the real versioned format. The publication path
        # below runs the actual deployed parser, never a mocked Node validator.
        program="import {NEURAL_FEATURE_NAMES,NEURAL_FEATURE_VERSION,NEURAL_FEATURE_SCHEMA_HASH} from './lib/trading/secondary-neural-data.js';console.log(JSON.stringify({names:NEURAL_FEATURE_NAMES,version:NEURAL_FEATURE_VERSION,hash:NEURAL_FEATURE_SCHEMA_HASH}));"
        schema=json.loads(REAL_RUN(['node','--input-type=module','-e',program],cwd=REPOSITORY,capture_output=True,text=True,check=True,timeout=5).stdout)
        n=len(schema['names']);dims=[n,16,8,1]
        domain={'mode':'PAPER','realTrading':False,'symbol':'PF_XBTUSD','ledger':'FREQUENT_PAPER','engine_version':'secondary-futures-1.0.0','entry_revision':'secondary-entry-useful-margin-1.0.0','execution_version':'secondary-exploration-execution-1.0.0','economic_policy_version':'secondary-entry-economics-1.0.0','exit_policy_version':'secondary-net-trailing-1.0.0','execution_policy_hash':'1'*64,'economic_policy_hash':'2'*64,'exit_policy_hash':'3'*64}
        model={'version':'secondary-neural-model-1.0.0','model_id':'nn_isolated_publication','feature_version':schema['version'],'feature_schema_hash':schema['hash'],'feature_names':schema['names'],'domain':domain,'trained_at':self.now-10000,'created_at':self.now-10000,'expires_at':self.now+86400000,'training_cutoff':self.now-20000,'max_label_mature_at':self.now-30000,'architecture':{'input':n,'hidden':[16,8],'output':1,'activation':'tanh','output_activation':'identity'},'normalization':{'mean':[0]*n,'scale':[1]*n},'input_domain':{'min':[-10]*n,'max':[10]*n},'output_transform':{'mean':0,'scale':0.01},'layers':[{'weights':[[0.01]*out for _ in range(dims[k])],'bias':[0]*out} for k,out in enumerate(dims[1:])],'validation':{'status':'PENDING_PROSPECTIVE','criteria_version':'secondary-neural-validation-1.0.0','assistance_authorized':False}}
        if corrupt:model['layers'][0]['weights'][0][0]='CORRUPT_NON_NUMERIC_WEIGHT'
        payload_json=json.dumps(model,separators=(',',':'))
        envelope={'version':'secondary-neural-artifact-1.0.0','payload_json':payload_json,'sha256':hashlib.sha256(payload_json.encode()).hexdigest()}
        self.add('MODEL','isolated-model.json',envelope);self.manifest['model_id']=model['model_id']
        self.add('STATUS','status.json',{'version':'secondary-neural-training-status-1.0.0','mode':'PAPER','realTrading':False,'at':self.now,'status':'MODEL_AVAILABLE','model_id':model['model_id'],'candidate_id':None,'revoked_model_ids':[]})
        return envelope
    def test_private_atomic_receipt_and_exact_retry(self):
        result=self.publish();again=self.publish()
        self.assertFalse(result['replayed']);self.assertTrue(again['replayed'])
        self.assertEqual((self.root/'status.json').stat().st_mode&0o777,0o600)
        generation=Path(result['checkpoint_directory']);self.assertTrue((generation/'dataset-checkpoint.json').exists())
        self.assertEqual(hashlib.sha256((generation/'publication-manifest.json').read_bytes()).hexdigest(),result['publication_id'])
        for item in result['checkpoint_files']:
            body=(generation/item['name']).read_bytes()
            self.assertEqual(len(body),item['bytes']);self.assertEqual(hashlib.sha256(body).hexdigest(),item['sha256'])
        self.assertFalse((self.root/'model.json').exists())
    def test_interrupted_checkpoint_copy_is_retryable_without_partial_generation(self):
        def interrupted(source,target,length):
            target.write(b'PARTIAL_ISOLATED_CHECKPOINT');raise OSError('simulated interruption')
        with patch.object(module.shutil,'copyfileobj',side_effect=interrupted):
            with self.assertRaisesRegex(OSError,'simulated interruption'):self.publish()
        self.assertFalse((self.root/'publication.json').exists())
        self.assertFalse(list((self.root/'external').glob('*/dataset-checkpoint.json')))
        result=self.publish();self.assertFalse(result['replayed'])
        self.assertTrue(Path(result['checkpoint_directory'],'dataset-checkpoint.json').exists())
    def test_hash_failure_makes_no_publication(self):
        (self.stage/'dataset-checkpoint.json').write_text('changed')
        with self.assertRaisesRegex(ValueError,'FILE_INTEGRITY'):self.publish()
        self.assertFalse(self.root.exists())
    def test_valid_versioned_artifact_passes_real_runtime_parser(self):
        artifact=self.model();result=self.publish()
        self.assertEqual(result['models']['MODEL']['model_id'],'nn_isolated_publication')
        self.assertEqual(result['models']['MODEL']['sha256'],artifact['sha256'])
        self.assertEqual(json.loads((self.root/'model.json').read_text()),artifact)
        self.assertEqual(result['status'],'MODEL_AVAILABLE')
        self.assertEqual([call.args[0][0] for call in self.commands.call_args_list],['git','node'])
    def test_correct_checksum_cannot_publish_nonnumeric_weights(self):
        artifact=self.model(corrupt=True)
        self.assertEqual(hashlib.sha256(artifact['payload_json'].encode()).hexdigest(),artifact['sha256'])
        with self.assertRaisesRegex(ValueError,'NEURAL_NUMERIC_INVALID'):self.publish()
        self.assertEqual([call.args[0][0] for call in self.commands.call_args_list],['git','node'])
        self.assertFalse(self.root.exists(),'validation must reject before creating status, weights or a publication receipt')
    def test_no_paths_outside_staging_or_symlinks(self):
        self.manifest['files'][0]['name']='../outside.json'
        with self.assertRaisesRegex(ValueError,'FILE_SCOPE'):self.publish()
    def test_real_modes_and_changed_release_rejected(self):
        with self.assertRaisesRegex(ValueError,'PAPER_ONLY'):self.publish(mode='LIVE')
        with patch.object(module.subprocess,'run',return_value=SimpleNamespace(stdout='b'*40)):
            with self.assertRaisesRegex(ValueError,'RELEASE_CHANGED'):self.publish()
    def test_stale_result_cannot_replace_new_checkpoint(self):
        self.publish();self.manifest['created_at']-=1
        with self.assertRaisesRegex(ValueError,'STALE_RESULT'):self.publish()
    def test_revocations_cannot_disappear_on_a_new_publication(self):
        self.add('STATUS','status.json',{'version':'secondary-neural-training-status-1.0.0','mode':'PAPER','realTrading':False,'at':self.now,'status':'COLLECTING','revoked_model_ids':['withdrawn-v1']})
        first=self.publish();self.now+=1000;self.manifest['created_at']=self.now
        self.add('STATUS','status.json',{'version':'secondary-neural-training-status-1.0.0','mode':'PAPER','realTrading':False,'at':self.now,'status':'COLLECTING','revoked_model_ids':[]})
        with self.assertRaisesRegex(ValueError,'REVOCATION_REGRESSION'):self.publish()
        self.assertEqual(json.loads((self.root/'publication.json').read_text())['publication_id'],first['publication_id'])
        self.assertEqual(json.loads((self.root/'status.json').read_text())['revoked_model_ids'],['withdrawn-v1'])
    def test_atomic_rename_is_synced_before_return(self):
        import os
        real_fsync=module.os.fsync;calls=[]
        def observe(fd):
            calls.append(os.fstat(fd).st_mode);return real_fsync(fd)
        import stat
        with patch.object(module.os,'fsync',side_effect=observe):module.atomic_bytes(self.stage/'durable.json',b'{}')
        self.assertEqual(len(calls),2)
        self.assertTrue(stat.S_ISREG(calls[0]));self.assertTrue(stat.S_ISDIR(calls[1]))
    def test_two_generations_bounded_and_rollback_does_not_touch_ledger(self):
        ledger=Path(self.temp.name)/'trading.sqlite';ledger.write_bytes(b'ISOLATED_UNCHANGED_LEDGER')
        for i in range(4):
            self.now+=1000;self.manifest['created_at']=self.now;self.manifest['source']['cursor']+=1
            self.add('STATUS','status.json',{'version':'secondary-neural-training-status-1.0.0','mode':'PAPER','realTrading':False,'at':self.now,'status':'COLLECTING'})
            self.publish()
        self.assertEqual(len(list((self.root/'external').iterdir())),2)
        self.assertEqual(ledger.read_bytes(),b'ISOLATED_UNCHANGED_LEDGER')

if __name__=='__main__':unittest.main()
