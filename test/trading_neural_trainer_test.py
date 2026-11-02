"""Isolated synthetic MLP/data tests. Never reads the operational SQLite file."""
import copy
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('lumi_neural_trainer', ROOT / 'scripts/trading-neural-train.py')
trainer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trainer)
T = 1_770_000_000_000
SCHEMA = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {NEURAL_FEATURE_NAMES,NEURAL_FEATURE_SCHEMA_HASH} from './lib/trading/secondary-neural-data.js';"
    "console.log(JSON.stringify({names:NEURAL_FEATURE_NAMES,hash:NEURAL_FEATURE_SCHEMA_HASH}));"], cwd=ROOT, text=True))
DOMAIN = {'mode': 'PAPER', 'realTrading': False, 'symbol': 'PF_XBTUSD', 'ledger': 'FREQUENT_PAPER',
    'engine_version': 'secondary-futures-1.0.0', 'entry_revision': 'secondary-entry-useful-margin-1.0.0',
    'execution_version': 'secondary-exploration-execution-1.0.0',
    'economic_policy_version': 'secondary-entry-economics-1.0.0', 'exit_policy_version': 'secondary-net-trailing-1.0.0',
    'execution_policy_hash': '1' * 64, 'economic_policy_hash': '2' * 64, 'exit_policy_hash': '3' * 64}


def row(index, *, at=None, value=None, x=None, prefix='train', movement=None, domain=None):
    rng = random.Random(1729 + index)
    x = x or [rng.uniform(-1, 1) for _ in SCHEMA['names']]
    y = .003 * math.tanh(x[0]) - .002 * x[1] + .0004 if value is None else value
    at = T - 7 * trainer.DAY + index * 60_000 if at is None else at
    op = prefix + '-' + str(index)
    snapshot = {'mode': 'PAPER', 'realTrading': False, 'synthetic': True,
        'feature_version': trainer.FEATURE_VERSION, 'feature_schema_hash': SCHEMA['hash'],
        'feature_names': SCHEMA['names'], 'x': x, 'input_hash': trainer.digest(['ISOLATED', x]),
        'signal_id': op, 'operation_id': op, 'decision_at': at, 'signal_at': at - 1000,
        'domain': domain or copy.deepcopy(DOMAIN), 'pattern': 'PULLBACK',
        'stage': 'PRE_SELECTION', 'data_quality': 'PRE_DECISION_OBSERVED', 'exclusion': None,
        'context': {'movement_key': movement or prefix + '-movement-' + str(index // 2),
                    'confirmation_key': op}}
    snapshot['snapshot_hash'] = trainer.digest(snapshot)
    label = {'mode': 'PAPER', 'realTrading': False, 'version': 'secondary-neural-label-1.0.0',
        'status': 'MATURE', 'operation_id': op, 'snapshot_hash': snapshot['snapshot_hash'],
        'label_revision': 1, 'net_return': str(y),
        'exposure': '100', 'net': str(y * 100), 'costs': '.1', 'entered_at': at + 1000,
        'closed_at': at + 30_000, 'mature_at': at + 30_000, 'quality': 'OBSERVED',
        'manual_override': False, 'funding_final': True, 'full_fill': True,
        'adverse_return': str(-abs(y))}
    label['label_hash'] = trainer.digest(label)
    return {'snapshot': snapshot, 'label': label, 'synthetic': True}


def dataset(rows, at=T):
    opportunities = [trainer.opportunity_from_row(r) for r in rows if isinstance(r, dict)]
    return {'version': trainer.DATASET_VERSION, 'mode': 'PAPER', 'as_of': at,
            'rows': rows, 'opportunities': [r for r in opportunities if r is not None],
            'opportunities_complete': True, 'checkpoint': {'last_event_seq': len(rows)}}


def run(rows, old=None, at=T):
    return trainer.run_training(dataset(rows, at), old, now=at, allow_synthetic=True)


def only_group(state):
    return next(iter(state['groups'].values()))


def prospective_rows(payload, *, good=True, priority=False):
    examples = [row(i)['snapshot']['x'] for i in range(128)]
    examples.sort(key=lambda x: trainer.predict_payload(payload, x))
    low, high = examples[10], examples[-10]
    result = []
    for i in range(trainer.PROTOCOL['calibration_n']):
        x = examples[i]
        r = row(i, prefix='calibration', at=T + trainer.PROTOCOL['purge_ms'] + 1000 + i * 1000,
                x=x, value=trainer.predict_payload(payload, x))
        r['decision'] = {'at': r['snapshot']['decision_at'], 'model_id': payload['model_id'],
            'prediction': {'status': 'PREDICTED', 'estimated_net_return': trainer.predict_payload(payload, x)}}
        result.append(r)
    for i in range(128):
        cohort, rank = i // 2, i % 2
        at = T + trainer.DAY * (1 + cohort % 14) + (cohort // 14) * 100_000 + rank * 1000
        x = high if rank else low
        estimate = trainer.predict_payload(payload, x)
        y = estimate if good else payload['baseline_mean_return']
        r = row(i, prefix='final', at=at, x=x, value=y)
        r['decision'] = {'at': at, 'model_id': payload['model_id'],
            'prediction': {'status': 'PREDICTED', 'estimated_net_return': estimate}}
        if priority:
            r['decision'].update(cohort_id='cohort-' + str(cohort), base_rank=rank,
                                  base_candidate_count=2, base_eligible=True)
        result.append(r)
    return result


class NeuralTrainerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.initial_rows = [row(i) for i in range(128)]
        cls.initial, cls.receipt, cls.artifacts = run(cls.initial_rows)
        cls.payload = json.loads(cls.artifacts[0]['payload_json'])

    def test_collects_without_a_model_or_fake_counters(self):
        state, receipt, artifacts = run([])
        self.assertEqual(receipt['status'], 'COLLECTING')
        self.assertEqual(receipt['changed_labels'], 0)
        self.assertEqual(state['groups'], {})
        self.assertEqual(artifacts, [])

    def test_genuine_gradient_training_creates_small_reproducible_mlp(self):
        state, receipt, artifacts = run(self.initial_rows)
        self.assertEqual(artifacts, self.artifacts)
        group = only_group(state)
        self.assertEqual(group['trainer'], only_group(self.initial)['trainer'])
        self.assertEqual(len(group['processed']), 128)
        self.assertEqual(group['trainer']['metrics']['t_'], 128 * 100)
        self.assertEqual(len(self.payload['layers']), 3)
        self.assertEqual(self.payload['architecture']['hidden'], [16, 8])
        self.assertFalse(self.payload['validation']['assistance_authorized'])
        self.assertLess(len(trainer.canonical(artifacts[0]).encode()), trainer.MAX_ARTIFACT_BYTES)
        self.assertEqual(next(iter(receipt['groups'].values()))['new_labels_waiting'], 0)

    def test_dataset_retry_does_not_duplicate_training_or_labels(self):
        state, receipt, artifacts = run(self.initial_rows * 2, self.initial, T + 1000)
        self.assertEqual(artifacts, [])
        self.assertEqual(receipt['changed_labels'], 0)
        self.assertEqual(receipt['skipped']['DUPLICATE_LABEL'], 256)
        self.assertEqual(only_group(state)['trainer'], only_group(self.initial)['trainer'])
        self.assertEqual(len(only_group(state)['rows']), 128)

    def test_sgd_checkpoint_resume_matches_uninterrupted_update_exactly(self):
        np, _, _ = trainer.libraries()
        old = only_group(self.initial)
        model_a = trainer.restore_model(old['trainer'], len(SCHEMA['names']))
        model_b = trainer.restore_model(json.loads(trainer.canonical(old['trainer'])), len(SCHEMA['names']))
        x = np.asarray([r['snapshot']['x'] for r in self.initial_rows[:64]])
        norm = old['normalization']
        x = (x - norm['mean']) / norm['scale']
        y = np.asarray([float(r['label']['net_return']) for r in self.initial_rows[:64]]) / .01
        model_a.partial_fit(x, y); model_b.partial_fit(x, y)
        for a, b in zip(model_a.coefs_, model_b.coefs_):
            np.testing.assert_array_equal(a, b)
        self.assertNotEqual(trainer.save_model(model_a)['weights'], old['trainer']['weights'])

    def test_signed_losses_are_usable_not_binary_wins(self):
        values = [row(i, value=-.001 - i * .00001) for i in range(128)]
        state, _, _ = run(values)
        g = only_group(state)
        self.assertEqual(len(g['processed']), 128)
        self.assertTrue(all(r['y'] < 0 for r in g['rows'].values()))
        self.assertLess(g['candidate']['payload']['baseline_mean_return'], 0)

    def test_few_or_correlated_samples_remain_collecting(self):
        for values in [self.initial_rows[:127], [row(i, movement='one-movement') for i in range(128)]]:
            state, receipt, artifacts = run(values)
            self.assertEqual(receipt['status'], 'COLLECTING')
            self.assertIsNone(only_group(state)['trainer'])
            self.assertEqual(artifacts, [])

    def test_candidate_and_normalizer_are_frozen_during_prospective_observation(self):
        new = [row(i, prefix='future', at=T + 100_000 + i * 1000, x=[100.0] * len(SCHEMA['names'])) for i in range(64)]
        state, receipt, artifacts = run(new, self.initial, T + 200_000)
        g, old = only_group(state), only_group(self.initial)
        self.assertEqual(g['trainer'], old['trainer'])
        self.assertEqual(g['normalization'], old['normalization'])
        self.assertEqual(g['candidate']['payload'], old['candidate']['payload'])
        self.assertEqual(artifacts, [])
        self.assertEqual(next(iter(receipt['groups'].values()))['new_labels_waiting'], 64)

    def test_funding_revision_rebuilds_once_and_revokes_old_candidate(self):
        revised = copy.deepcopy(self.initial_rows[0])
        revised['label'].update(label_revision=2, net_return='-.01', net='-1', costs='.2',
                                mature_at=T + 1, quality='OBSERVED_PRICE_RECONCILED_FUNDING')
        revised['label']['label_hash'] = trainer.digest({k: v for k, v in revised['label'].items() if k != 'label_hash'})
        state, receipt, artifacts = run([revised], self.initial, T + 1000)
        self.assertEqual(receipt['revoked_model_ids'], [self.payload['model_id']])
        g = only_group(state)
        self.assertEqual(len(g['processed']), 128)
        self.assertEqual(len(g['rows']), 128)
        self.assertEqual(g['rows']['train-0']['y'], -.01)
        self.assertEqual(g['normalization'], only_group(self.initial)['normalization'])
        self.assertNotEqual(g['candidate']['payload']['model_id'], self.payload['model_id'])
        self.assertEqual(len(artifacts), 1)
        again, repeat, created = run([revised], state, T + 2000)
        self.assertEqual(repeat['changed_labels'], 0)
        self.assertIn(self.payload['model_id'], repeat['revoked_model_ids'])
        self.assertEqual(created, [])
        self.assertEqual(only_group(again)['trainer'], g['trainer'])

    def test_excluded_and_pending_are_not_zero_or_loss_labels(self):
        pending = row(0)
        pending['label'].update(status='PENDING', net_return=None, funding_final=False, reason='FUNDING_UNRESOLVED')
        excluded = row(1)
        excluded['label'].update(status='EXCLUDED', net_return=None, exclusion='INCOMPLETE_MARKET_DATA')
        no_snapshot = row(2); no_snapshot['snapshot'] = None
        unavailable = row(3); unavailable['label'].update(status='EXCLUDED', exclusion='NEURAL_CAPTURE_FAILED')
        unavailable['snapshot'].pop('domain'); unavailable['snapshot']['x'] = None
        state, receipt, artifacts = run([pending, excluded, no_snapshot, unavailable, {'snapshot': None}])
        g = only_group(state)
        self.assertEqual(len(g['processed']), 0)
        self.assertEqual(next(iter(receipt['groups'].values()))['usable'], 0)
        self.assertEqual(receipt['unassigned_excluded'], 2)
        self.assertEqual(receipt['skipped']['NO_LABEL'], 1)
        self.assertEqual(artifacts, [])

    def test_partial_execution_is_one_label_and_negative_funding_costs_can_be_valid(self):
        partial = row(0)
        partial['label'].update(full_fill=False, costs='-.01')
        state, receipt, _ = run([partial, copy.deepcopy(partial)])
        self.assertEqual(len(only_group(state)['rows']), 1)
        self.assertFalse(only_group(state)['rows']['train-0']['full_fill'])
        self.assertEqual(next(iter(receipt['groups'].values()))['usable'], 1)

    def test_old_fixed_and_new_trailing_are_not_pooled(self):
        old_domain = {**DOMAIN, 'exit_policy_version': 'LEGACY_FIXED_EXIT', 'exit_policy_hash': '9' * 64}
        values = [row(i) for i in range(64)] + [row(i, prefix='legacy', domain=old_domain) for i in range(64)]
        state, _, artifacts = run(values)
        self.assertEqual(len(state['groups']), 2)
        self.assertTrue(all(g['trainer'] is None for g in state['groups'].values()))
        self.assertEqual(artifacts, [])

    def test_operation_contract_cannot_change_domain_after_capture(self):
        altered = copy.deepcopy(self.initial_rows[0])
        altered['snapshot']['domain']['exit_policy_version'] = 'LEGACY_FIXED_EXIT'
        with self.assertRaisesRegex(ValueError, 'OPERATION_DOMAIN_CHANGED'):
            run([altered], self.initial)

    def test_no_future_data_and_no_post_entry_predictions(self):
        mutations = [
            lambda r: r['snapshot'].update(signal_at=T + 1),
            lambda r: r['snapshot'].update(max_input_available_at=T + 1),
            lambda r: r['label'].update(mature_at=T + 1),
            lambda r: r.update(decision={'at': T, 'model_id': 'old', 'prediction': {'status': 'PREDICTED', 'estimated_net_return': .1}}),
            lambda r: r['label'].update(funding_final=False),
            lambda r: r['label'].update(manual_override=True),
            lambda r: r['label'].update(quality='UNRESOLVED_MARKET_GAP'),
        ]
        for mutate in mutations:
            value = row(0); mutate(value)
            with self.assertRaises(ValueError):
                run([value])

    def test_schema_nan_accounting_and_conflicting_revision_rejected(self):
        for mutate in [lambda r: r['snapshot']['x'].__setitem__(0, math.nan),
                       lambda r: r['snapshot'].update(feature_schema_hash='0' * 64),
                       lambda r: r['label'].update(net_return='1'),
                       lambda r: r['label'].update(exposure='0')]:
            value = row(0); mutate(value)
            with self.assertRaises(ValueError):
                run([value])
        value = copy.deepcopy(self.initial_rows[0]); value['label']['label_hash'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'CONFLICTING_LABEL_REVISION'):
            run([value], self.initial)

    def test_real_modes_and_active_worker_are_rejected(self):
        for target in ['domain', 'snapshot', 'label']:
            value = row(0)
            (value['snapshot']['domain'] if target == 'domain' else value[target])['mode'] = 'LIVE'
            with self.assertRaisesRegex(ValueError, 'PAPER_ONLY'):
                run([value])
        with patch.dict(os.environ, {'LUMI_TRADING_PLATFORM': 'EC2'}):
            with self.assertRaisesRegex(ValueError, 'FORBIDDEN_ON_ACTIVE_WORKER'):
                run([])
        with self.assertRaisesRegex(ValueError, 'PAPER_ONLY'):
            trainer.guard_environment('LIVE')

    def test_synthetic_data_cannot_enter_production_trainer(self):
        with self.assertRaisesRegex(ValueError, 'SYNTHETIC_DATA_FORBIDDEN'):
            trainer.run_training(dataset([row(0)]), now=T)

    def test_worse_candidate_is_rejected_without_retrying_same_final_period(self):
        future = prospective_rows(self.payload, good=False)
        state, receipt, artifacts = run(future, self.initial, T + 15 * trainer.DAY)
        g = only_group(state)
        self.assertEqual(g['candidate']['status'], 'REJECTED')
        self.assertFalse(g['candidate']['review']['assistance_authorized'])
        self.assertEqual(g['candidate']['review']['final_n'], 128)
        self.assertEqual(artifacts, [])
        original_final = g['candidate']['review']['final_label_hash']
        next_state, _, new_artifacts = run([], state, T + 15 * trainer.DAY + 1000)
        next_g = only_group(next_state)
        self.assertEqual(len(new_artifacts), 1)
        self.assertNotEqual(next_g['candidate']['payload']['model_id'], self.payload['model_id'])
        self.assertEqual(next_g['history'][0]['final_label_hash'], original_final)
        self.assertEqual(next_g['normalization'], g['normalization'])
        self.assertEqual(len(next_g['processed']), 320)
        self.assertEqual(next_g['candidate']['status'], 'PENDING_PROSPECTIVE')

    def test_forecast_accuracy_alone_has_no_assistance_authority(self):
        future = prospective_rows(self.payload, good=True, priority=False)
        state, _, _ = run(future, self.initial, T + 15 * trainer.DAY)
        report = only_group(state)['candidate']['review']
        self.assertEqual(report['status'], 'FORECAST_VALIDATED_PRIORITIZATION_PENDING')
        self.assertFalse(report['assistance_authorized'])
        self.assertEqual(report['mse'], 0)
        self.assertEqual(report['priority']['cohorts'], 0)

    def test_prospective_complete_cohorts_can_pass_predeclared_ranking_gates(self):
        future = prospective_rows(self.payload, good=True, priority=True)
        state, _, artifacts = run(future, self.initial, T + 15 * trainer.DAY)
        g = only_group(state); report = g['candidate']['review']
        self.assertEqual(report['status'], 'PASSED')
        self.assertTrue(report['assistance_authorized'])
        self.assertEqual(report['priority']['cohorts'], 64)
        self.assertEqual(report['priority']['eligible_cohorts'], 64)
        self.assertEqual(report['priority']['coverage'], 1)
        self.assertTrue(report['priority']['coverage_manifest_complete'])
        self.assertGreater(report['priority']['advantage_interval']['lower'], 0)
        self.assertEqual(g['active']['payload']['model_id'], self.payload['model_id'])
        promoted = json.loads(artifacts[0]['payload_json'])
        self.assertEqual(promoted['layers'], self.payload['layers'])
        self.assertNotIn('final_operation_ids', promoted['validation'])
        self.assertEqual(promoted['validation']['status'], 'PASSED')

    def test_cohorts_without_any_model_prediction_reduce_real_coverage(self):
        future = prospective_rows(self.payload, priority=True)
        for i in range(72):
            at = T + trainer.DAY * (1 + (i // 2) % 14) + 700_000 + i * 1000
            r = row(i, prefix='unpredicted', at=at)
            r['decision'] = {'at': at, 'model_id': self.payload['model_id'],
                'prediction': {'status': 'UNAVAILABLE', 'reason': 'NEURAL_INPUT_OUT_OF_DOMAIN'},
                'cohort_id': 'unpredicted-' + str(i // 2), 'base_rank': i % 2,
                'base_candidate_count': 2, 'base_eligible': True}
            future.append(r)
        state, _, artifacts = run(future, self.initial, T + 15 * trainer.DAY)
        review = only_group(state)['candidate']['review']
        self.assertEqual(review['mse'], 0)
        self.assertEqual(review['priority']['cohorts'], 64)
        self.assertEqual(review['priority']['eligible_cohorts'], 100)
        self.assertEqual(review['priority']['coverage'], .64)
        self.assertEqual(review['priority']['reason'], 'PRIORITY_COVERAGE_BELOW_MINIMUM')
        self.assertEqual(review['status'], 'REJECTED')
        self.assertFalse(review['assistance_authorized'])
        self.assertEqual(artifacts, [])

    def test_unfilled_opportunities_count_toward_coverage_without_becoming_losses(self):
        future = prospective_rows(self.payload, priority=True)
        unfilled = []
        for i in range(72):
            at = T + trainer.DAY * (1 + (i // 2) % 14) + 700_000 + i * 1000
            r = row(i, prefix='unfilled', at=at)
            r['label'] = None
            r['snapshot']['domain'] = None  # Failed capture has no invented feature domain.
            r['decision'] = {'at': at, 'prediction': {'status': 'UNAVAILABLE'},
                'cohort_id': 'unfilled-' + str(i // 2), 'base_rank': i % 2,
                'base_candidate_count': 2, 'base_eligible': True}
            unfilled.append(r)
        source = dataset(future, T + 15 * trainer.DAY)
        source['opportunities'].extend(trainer.opportunity_from_row(r) for r in unfilled)
        state, receipt, _ = trainer.run_training(source, self.initial,
            now=T + 15 * trainer.DAY, allow_synthetic=True)
        review = only_group(state)['candidate']['review']
        self.assertEqual(review['priority']['eligible_cohorts'], 100)
        self.assertEqual(review['priority']['coverage'], .64)
        self.assertEqual(review['status'], 'REJECTED')
        self.assertEqual(len(only_group(state)['rows']), 320)
        self.assertFalse(any(key.startswith('unfilled-') for key in only_group(state)['rows']))
        self.assertEqual(receipt['opportunities'], 200)
        self.assertTrue(receipt['opportunities_complete'])

    def test_legacy_export_without_opportunity_manifest_cannot_authorize_assistance(self):
        source = dataset(prospective_rows(self.payload, priority=True), T + 15 * trainer.DAY)
        source.pop('opportunities'); source.pop('opportunities_complete')
        state, receipt, artifacts = trainer.run_training(source, self.initial,
            now=T + 15 * trainer.DAY, allow_synthetic=True)
        review = only_group(state)['candidate']['review']
        self.assertEqual(review['mse'], 0)
        self.assertEqual(review['priority']['cohorts'], 64)
        self.assertFalse(review['priority']['coverage_manifest_complete'])
        self.assertEqual(review['priority']['reason'], 'COMPLETE_OPPORTUNITY_MANIFEST_REQUIRED')
        self.assertEqual(review['status'], 'FORECAST_VALIDATED_PRIORITIZATION_PENDING')
        self.assertFalse(review['assistance_authorized'])
        self.assertEqual(artifacts, [])
        self.assertFalse(receipt['opportunities_complete'])
        complete = dataset(prospective_rows(self.payload, priority=True), T + 15 * trainer.DAY + 1000)
        recovered, _, promoted = trainer.run_training(complete, state,
            now=complete['as_of'], allow_synthetic=True)
        recovered_review = only_group(recovered)['candidate']['review']
        self.assertEqual(recovered_review['status'], 'PASSED')
        self.assertEqual(recovered_review['final_label_hash'], review['final_label_hash'])
        self.assertEqual(only_group(recovered)['trainer'], only_group(state)['trainer'])
        self.assertEqual(len(promoted), 1)

    def test_opportunity_retries_are_idempotent_and_cannot_rewrite_prior_decisions(self):
        source = dataset(prospective_rows(self.payload, priority=True), T + 15 * trainer.DAY)
        state, _, _ = trainer.run_training(source, self.initial,
            now=T + 15 * trainer.DAY, allow_synthetic=True)
        repeated = copy.deepcopy(state)
        trainer.ingest_opportunities(repeated, source, source['rows'], source['as_of'], True)
        self.assertEqual(repeated['opportunities'], state['opportunities'])
        modified = copy.deepcopy(source)
        modified['opportunities'][-1]['decision']['base_eligible'] = False
        with self.assertRaisesRegex(ValueError, 'IMMUTABLE_OPPORTUNITY_CONFLICT'):
            trainer.ingest_opportunities(repeated, modified, [], source['as_of'], True)
        future = copy.deepcopy(source['opportunities'][-1])
        future['decision']['at'] = source['as_of'] + 1
        with self.assertRaisesRegex(ValueError, 'NONCAUSAL_OPPORTUNITY'):
            trainer.compact_opportunity(future, source['as_of'], True)
        real = copy.deepcopy(source['opportunities'][-1]); real['domain']['mode'] = 'REAL'
        with self.assertRaisesRegex(ValueError, 'PAPER_ONLY'):
            trainer.compact_opportunity(real, source['as_of'], True)

    def test_candidate_prediction_is_evaluated_separately_from_active_model(self):
        future = prospective_rows(self.payload, good=True, priority=True)
        for r in future:
            d = r['decision']
            d['candidate_predictions'] = [{**d['prediction'], 'model_id': self.payload['model_id']}]
            d['model_id'] = 'nn_previous_active'
            d['prediction'] = {'status': 'PREDICTED', 'model_id': 'nn_previous_active', 'estimated_net_return': -.5}
        state, _, _ = run(future, self.initial, T + 15 * trainer.DAY)
        review = only_group(state)['candidate']['review']
        self.assertEqual(review['status'], 'PASSED')
        self.assertEqual(review['mse'], 0)

    def test_training_movements_and_result_window_overlap_are_purged(self):
        future = prospective_rows(self.payload)
        future[0]['snapshot']['context']['movement_key'] = 'train-movement-1'
        future[1]['snapshot']['decision_at'] = T - 1000
        future[1]['snapshot']['signal_at'] = T - 2000
        future[1]['decision']['at'] = T - 1000
        state, _, _ = run(future, self.initial, T + 15 * trainer.DAY)
        report = only_group(state)['candidate']['review']
        self.assertEqual(report['exclusions']['TRAINING_MOVEMENT_OVERLAP'], 1)
        self.assertEqual(report['exclusions']['TRAINING_RESULT_WINDOW_OVERLAP'], 1)
        self.assertLess(report['final_n'], 128)
        self.assertFalse(report['assistance_authorized'])

    def test_incomplete_priority_cohorts_do_not_get_hypothetical_returns(self):
        future = prospective_rows(self.payload, priority=True)
        future[-1]['label']['full_fill'] = False
        state, _, _ = run(future, self.initial, T + 15 * trainer.DAY)
        report = only_group(state)['candidate']['review']
        self.assertEqual(report['priority']['cohorts'], 63)
        self.assertEqual(report['priority']['status'], 'PENDING_EVIDENCE')
        self.assertFalse(report['assistance_authorized'])

    def test_funding_correction_invalidates_already_validated_model(self):
        future = prospective_rows(self.payload, priority=True)
        state, _, _ = run(future, self.initial, T + 15 * trainer.DAY)
        revised = copy.deepcopy(future[-1]); label = revised['label']
        label.update(label_revision=2, net_return='-.02', net='-2', mature_at=T + 16 * trainer.DAY)
        label['label_hash'] = trainer.digest({k: v for k, v in label.items() if k != 'label_hash'})
        next_state, receipt, _ = run([revised], state, T + 16 * trainer.DAY)
        self.assertIn(self.payload['model_id'], receipt['revoked_model_ids'])
        self.assertIsNone(only_group(next_state)['active'])

    def test_resource_limits_and_atomic_checkpoint_permissions(self):
        with self.assertRaisesRegex(ValueError, 'ROW_LIMIT'):
            trainer.run_training(dataset([None] * (trainer.MAX_ROWS + 1)), now=T)
        with tempfile.TemporaryDirectory(prefix='lumi-neural-isolated-') as directory:
            path = Path(directory) / 'checkpoint.json'
            trainer.atomic_json(path, self.initial)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(trainer.read_json(path), self.initial)
            self.assertEqual(list(Path(directory).glob('.*')), [])

    def test_python_forward_matches_sklearn_estimator(self):
        np, _, _ = trainer.libraries()
        group = only_group(self.initial)
        model = trainer.restore_model(group['trainer'], len(SCHEMA['names']))
        raw = np.asarray([r['snapshot']['x'] for r in self.initial_rows[:16]])
        values = model.predict((raw - group['normalization']['mean']) / group['normalization']['scale']) * .01
        for x, expected in zip(raw, values):
            self.assertAlmostEqual(trainer.predict_payload(self.payload, x), expected, places=14)

    def test_javascript_runtime_matches_trained_sklearn_with_frozen_transforms(self):
        np, _, _ = trainer.libraries()
        group = only_group(self.initial)
        sklearn_model = trainer.restore_model(group['trainer'], len(SCHEMA['names']))
        vectors = [r['snapshot']['x'] for r in self.initial_rows[:16]]
        raw = np.asarray(vectors)
        expected = sklearn_model.predict((raw - group['normalization']['mean']) / group['normalization']['scale']) * .01
        program = """
import {readFileSync} from 'node:fs';
import {hash} from './lib/trading/core.js';
import {SecondaryNeuralRuntime} from './lib/trading/secondary-neural-runtime.js';
import {NEURAL_SIGNAL_VERSION,NEURAL_FEATURE_VERSION,NEURAL_FEATURE_NAMES,NEURAL_FEATURE_SCHEMA_HASH} from './lib/trading/secondary-neural-data.js';
const {artifact,vectors,at}=JSON.parse(readFileSync(0,'utf8')),p=JSON.parse(artifact.payload_json);
const runtime=new SecondaryNeuralRuntime({mode:'ADVISORY',now:()=>at,clock:()=>0});
const load=runtime.loadArtifactText(JSON.stringify(artifact));if(!load.ok)throw Error(load.reason);
const predictions=vectors.map((x,i)=>{
 const id='isolated-parity-'+i,inputs={fixture:'ISOLATED_SYNTHETIC_DO_NOT_DEPLOY',at};
 const s={version:NEURAL_SIGNAL_VERSION,feature_version:NEURAL_FEATURE_VERSION,feature_schema_hash:NEURAL_FEATURE_SCHEMA_HASH,
 feature_names:[...NEURAL_FEATURE_NAMES],snapshot_id:hash(id),signal_id:id,operation_id:id,at,decision_at:at,signal_at:at-500,
 stage:'PRE_SELECTION',mode:'PAPER',realTrading:false,domain:p.domain,group_key:hash({feature_version:NEURAL_FEATURE_VERSION,domain:p.domain}),
 context:{movement_key:id,confirmation_key:id},inputs,input_hash:hash(inputs),x,exclusion:null,data_quality:'PRE_DECISION_OBSERVED'};
 s.snapshot_hash=hash(s);return runtime.predict(s);
});
console.log(JSON.stringify(predictions));
"""
        process = subprocess.run(['node', '--input-type=module', '-e', program], cwd=ROOT,
            input=json.dumps({'artifact': self.artifacts[0], 'vectors': vectors, 'at': T + 1000}),
            text=True, capture_output=True, timeout=15)
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        for prediction, value in zip(result, expected):
            self.assertEqual(prediction['status'], 'PREDICTED')
            self.assertAlmostEqual(prediction['estimated_net_return'], value, places=12)

    def test_cli_collection_is_external_private_and_paper_only(self):
        with tempfile.TemporaryDirectory(prefix='lumi-neural-isolated-') as directory:
            path = Path(directory); (path / 'dataset.json').write_text(json.dumps(dataset([])))
            args = ['python3', str(ROOT / 'scripts/trading-neural-train.py'), '--dataset', str(path / 'dataset.json'),
                    '--checkpoint', str(path / 'checkpoint.json'), '--output-dir', str(path / 'out'), '--now', str(T)]
            result = subprocess.run(args, text=True, capture_output=True, cwd=ROOT)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)['status'], 'COLLECTING')
            self.assertTrue((path / 'out/last-receipt.json').exists())
            denied = subprocess.run(args + ['--mode', 'LIVE'], text=True, capture_output=True, cwd=ROOT)
            self.assertNotEqual(denied.returncode, 0)
            self.assertIn('PAPER_ONLY', denied.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
