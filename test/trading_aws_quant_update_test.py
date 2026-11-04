import importlib.util, pathlib, unittest
spec=importlib.util.spec_from_file_location('quant_update',pathlib.Path(__file__).parents[1]/'scripts/trading-aws-quant-update.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class QuantDeploymentTest(unittest.TestCase):
    def test_scope_rejects_dependencies_credentials_audiovisual_and_paths(self):
        for p in ['package.json','server.js','.env','lib/trading/../secret','public/lumi-studio/app.js']:self.assertFalse(module.allowed_path(p))
        for p in ['lib/trading/quant-features.js','docs/trading/QUANT-MASTER-IMPLEMENTATION.md','test/secondary-quant.test.js']:self.assertTrue(module.allowed_path(p))
    def test_flags_only_authorize_secondary_paper_modules(self):
        self.assertEqual(len(module.FLAGS),6)
        self.assertTrue(all(k.startswith('LUMI_TRADING_SECONDARY_') for k in module.FLAGS))
    def test_no_worker_test_backtest_training_or_install_commands(self):
        code=pathlib.Path(module.__file__).read_text()
        for forbidden in ['npm ci','node --test','unittest discover','trading-neural-train','trading-quant-research.mjs --']:self.assertNotIn(forbidden,code)
        self.assertNotIn('verify_migration(',code)
    def test_no_database_restore_or_old_binary_rollback(self):
        code=pathlib.Path(module.__file__).read_text();self.assertNotIn('copyfile(',code);self.assertNotIn('link.symlink_to(old',code)
        self.assertIn('quant=False',code)

    def test_live_verification_requires_nonempty_auxiliary_frames(self):
        data={str(tf):1793793600000 for tf in [1,5,15,30,60,240,1440]}
        self.assertTrue(module.complete_frames(data))
        for invalid in [None,False,0,'1793793600000']:
            self.assertFalse(module.complete_frames({**data,'30':invalid}))
        data.pop('30');self.assertFalse(module.complete_frames(data))
