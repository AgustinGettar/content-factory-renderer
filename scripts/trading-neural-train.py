#!/usr/bin/env python3
"""Bounded external PAPER MLP trainer. No AWS, network, broker or live DB access.

The caller exports durable neuronal events and atomically stores this private
checkpoint/receipt. Runtime receives only a bounded, checksummed JSON artifact.
Every fitted artifact is immutable while its future observations are reviewed.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import copy
import fcntl
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

TRAINER_VERSION = 'secondary-neural-trainer-1.0.0'
CHECKPOINT_VERSION = 'secondary-neural-checkpoint-1.0.0'
DATASET_VERSION = 'secondary-neural-dataset-1.0.0'
FEATURE_VERSION = 'secondary-neural-features-1.0.0'
FEATURE_NAMES = [
    'pattern_breakout', 'pattern_pullback', 'pattern_range_reentry', 'direction',
    'trend_5_atr', 'trend_15_atr', 'efficiency_15', 'atr_5_fraction', 'atr_15_fraction',
    'relative_volume', 'candle_body_fraction', 'candle_signed_body_fraction',
    'upper_wick_fraction', 'lower_wick_fraction', 'stop_distance_fraction',
    'target_distance_fraction', 'spread_fraction', 'entry_fee_fraction',
    'exit_fee_fraction', 'slippage_fraction', 'expected_funding_fraction',
    'expected_net_target_fraction', 'expected_net_risk_fraction', 'min_expected_net_fraction',
    'quote_age_seconds', 'candle_age_seconds', 'open_position_count', 'pending_order_count',
    'related_structure_count', 'shared_target_count', 'same_direction_exposure_nominals',
    'same_confirmation_count', 'confirmation_age_seconds',
]
MODEL_VERSION = 'secondary-neural-model-1.0.0'
ARTIFACT_VERSION = 'secondary-neural-artifact-1.0.0'
CRITERIA_VERSION = 'secondary-neural-validation-1.0.0'
DAY = 86_400_000
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_ARTIFACT_BYTES = 128 * 1024
MAX_ROWS = 20_000
MAX_GROUPS = 16
MAX_FEATURES = 64
MAX_CANDIDATES_PER_GROUP = 256
DEPENDENCIES = {'numpy': '2.3.5', 'scipy': '1.17.0', 'scikit-learn': '1.8.0',
                'joblib': '1.5.3', 'threadpoolctl': '3.6.0'}
PROTOCOL = {
    'version': TRAINER_VERSION, 'criteria_version': CRITERIA_VERSION,
    'architecture': [16, 8], 'activation': 'tanh', 'solver': 'sgd',
    'learning_rate': 0.01, 'momentum': 0, 'l2': 0.0001,
    'seed': 1729, 'batch_size': 32, 'initial_epochs': 100,
    'incremental_epochs': 10, 'output_mean': 0, 'output_scale': 0.01,
    'min_training': 128, 'min_training_movements': 32,
    'min_new_labels': 64, 'calibration_n': 64,
    'min_final': 128, 'min_final_movements': 32, 'min_final_days': 14,
    'purge_ms': 2_700_000, 'candidate_age_ms': 90 * DAY,
    'max_attempts_per_epoch': 6, 'attempt_epoch_ms': 90 * DAY,
    'mse_improvement': 0.05, 'mae_improvement': 0.0,
    'bootstrap_reps': 2000, 'bootstrap_block_days': 3,
    'family_alpha': 0.05, 'min_priority_cohorts': 64,
    'min_priority_coverage': 0.8, 'comparable_exposure_fraction': 0.01,
    'priority_coverage': 'ALL_OBSERVED_PROSPECTIVE_BASE_COHORTS_WITH_COMPLETE_MANIFEST',
    'risk_tolerance_return': 0.0001,
    'assistance_action': 'PRIORITIZE_ONLY_NO_SUPPRESSION',
    'selection_policy': 'PREDECLARED_NO_HYPERPARAMETER_SEARCH',
    'normalizer_policy': 'FIT_INITIAL_TRAINING_ONLY_FROZEN_PER_LINEAGE',
    'label_correction': 'INVALIDATE_DEPENDENT_MODEL_AND_REBUILD',
    'real_trading': False,
}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def finite(value, name='number'):
    if isinstance(value, bool):
        raise ValueError('INVALID_' + name)
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('NONFINITE_' + name)
    return result


def stamp(value, name='timestamp'):
    result = finite(value, name)
    if result < 0 or result != int(result) or result > 9_007_199_254_740_991:
        raise ValueError('INVALID_' + name)
    return int(result)


def guard_environment(mode='PAPER'):
    if mode != 'PAPER':
        raise ValueError('PAPER_ONLY')
    if (os.environ.get('LUMI_TRADING_PLATFORM') == 'EC2'
            or os.environ.get('LUMI_TRADING_AWS_INSTANCE_ID') == 'i-0ae2ad0bb886f3d7f'
            or Path('/var/lib/lumi-trading/trading.sqlite').exists()):
        raise ValueError('TRAINING_FORBIDDEN_ON_ACTIVE_WORKER')


def libraries():
    # Import only when a mature training batch exists. COLLECTING needs stdlib.
    for name, expected in DEPENDENCIES.items():
        if importlib.metadata.version(name) != expected:
            raise ValueError('PINNED_TRAINER_DEPENDENCY_MISMATCH:' + name)
    import numpy as np
    from sklearn.neural_network import MLPRegressor
    from threadpoolctl import threadpool_limits
    return np, MLPRegressor, threadpool_limits


def read_json(path):
    source = Path(path)
    if source.stat().st_size > MAX_JSON_BYTES:
        raise ValueError('JSON_SIZE_LIMIT')
    return json.loads(source.read_text(), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_JSON')))


def atomic_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = canonical(value) + '\n'
    if len(payload.encode()) > MAX_JSON_BYTES:
        raise ValueError('JSON_SIZE_LIMIT')
    fd, temp = tempfile.mkstemp(prefix='.' + target.name + '.', dir=target.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, target)
        directory = os.open(target.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def new_checkpoint(now):
    return {'version': CHECKPOINT_VERSION, 'mode': 'PAPER', 'protocol': copy.deepcopy(PROTOCOL),
            'protocol_hash': digest(PROTOCOL), 'created_at': now, 'groups': {},
            'unassigned_exclusions': {}, 'operation_groups': {}, 'revoked_models': {},
            'opportunities': {}, 'opportunities_manifest': {'complete': False},
            'runs': 0, 'last_run': None}


def validate_domain(domain):
    if not isinstance(domain, dict) or domain.get('mode') != 'PAPER' or domain.get('realTrading') is not False:
        raise ValueError('PAPER_ONLY')
    if domain.get('symbol') != 'PF_XBTUSD' or domain.get('ledger') != 'FREQUENT_PAPER':
        raise ValueError('SECONDARY_FUTURES_ONLY')
    for key in ['engine_version', 'entry_revision', 'execution_version',
                'economic_policy_version', 'exit_policy_version']:
        if not isinstance(domain.get(key), str) or not domain[key] or len(domain[key]) > 128:
            raise ValueError('MISSING_DOMAIN_VERSION:' + key)
    return copy.deepcopy(domain)


def opportunity_from_row(row):
    """Decision evidence is separate from outcomes, including rows without one."""
    snapshot, decision = row.get('snapshot'), row.get('decision')
    if not isinstance(snapshot, dict) or not isinstance(decision, dict):
        return None
    return {'operation_id': snapshot.get('operation_id'),
            'signal_id': snapshot.get('signal_id'), 'snapshot_hash': snapshot.get('snapshot_hash'),
            'decision_at': snapshot.get('decision_at'),
            'movement_key': (snapshot.get('context') or {}).get('movement_key'),
            'feature_version': snapshot.get('feature_version'),
            'feature_schema_hash': snapshot.get('feature_schema_hash'),
            'domain': snapshot.get('domain'), 'decision': decision,
            'synthetic': bool(snapshot.get('synthetic') or row.get('synthetic'))}


def compact_opportunity(value, as_of, allow_synthetic=False):
    """No label or return is inferred from an unfilled/rejected opportunity."""
    if not isinstance(value, dict):
        raise ValueError('INVALID_OPPORTUNITY')
    decision = value.get('decision')
    if not isinstance(decision, dict) or not decision.get('cohort_id'):
        return None
    if value.get('synthetic') and not allow_synthetic:
        raise ValueError('SYNTHETIC_DATA_FORBIDDEN')
    operation_id, signal_id = value.get('operation_id'), value.get('signal_id')
    if (not isinstance(operation_id, str) or not 1 <= len(operation_id) <= 128
            or not isinstance(signal_id, str) or not 1 <= len(signal_id) <= 128
            or not isinstance(value.get('snapshot_hash'), str) or len(value['snapshot_hash']) != 64):
        raise ValueError('INVALID_OPPORTUNITY_ID')
    decision_at, recorded_at = stamp(value.get('decision_at')), stamp(decision.get('at'))
    if not decision_at <= recorded_at <= as_of:
        raise ValueError('NONCAUSAL_OPPORTUNITY')
    if (decision.get('operation_id', operation_id) != operation_id
            or decision.get('signal_id', signal_id) != signal_id
            or decision.get('snapshot_hash', value['snapshot_hash']) != value['snapshot_hash']):
        raise ValueError('OPPORTUNITY_SNAPSHOT_MISMATCH')
    count, rank, cohort = (decision.get('base_candidate_count'), decision.get('base_rank'),
                           decision.get('cohort_id'))
    if (type(count) is not int or not 1 <= count <= 8 or type(rank) is not int or not 0 <= rank < count
            or type(decision.get('base_eligible')) is not bool
            or not isinstance(cohort, str) or not 1 <= len(cohort) <= 128):
        raise ValueError('INVALID_OPPORTUNITY_COHORT')
    domain = validate_domain(value['domain']) if value.get('domain') is not None else None
    movement = value.get('movement_key')
    if movement is not None and (not isinstance(movement, str) or not 1 <= len(movement) <= 256):
        raise ValueError('INVALID_OPPORTUNITY_MOVEMENT')
    return {'operation_id': operation_id, 'signal_id': signal_id,
            'snapshot_hash': value['snapshot_hash'], 'decision_at': decision_at,
            'recorded_at': recorded_at, 'movement_key': movement,
            'feature_version': value.get('feature_version'),
            'feature_schema_hash': value.get('feature_schema_hash'), 'domain': domain,
            'cohort_id': cohort, 'base_rank': rank, 'base_candidate_count': count,
            'base_eligible': decision['base_eligible']}


def ingest_opportunities(checkpoint, dataset, rows, as_of, allow_synthetic):
    explicit = dataset.get('opportunities')
    if explicit is not None and (not isinstance(explicit, list) or len(explicit) > MAX_ROWS):
        raise ValueError('OPPORTUNITY_MANIFEST_LIMIT')
    complete = dataset.get('opportunities_complete') is True
    if complete and explicit is None:
        raise ValueError('COMPLETE_OPPORTUNITY_MANIFEST_REQUIRED')
    target = checkpoint.setdefault('opportunities', {})
    # Older exports can be ingested and trained, but cannot establish coverage.
    # The current exporter adds every captured decision, including NO_LABEL rows.
    inferred = [opportunity_from_row(row) for row in rows if isinstance(row, dict)]
    for raw in [*(explicit or []), *(row for row in inferred if row is not None)]:
        row = compact_opportunity(raw, as_of, allow_synthetic)
        if row is None:
            continue
        prior = target.get(row['operation_id'])
        if prior is not None and prior != row:
            raise ValueError('IMMUTABLE_OPPORTUNITY_CONFLICT')
        target[row['operation_id']] = row
    if len(target) > MAX_ROWS:
        raise ValueError('OPPORTUNITY_CHECKPOINT_LIMIT')
    checkpoint['opportunities_manifest'] = {'complete': complete, 'as_of': as_of,
        'received': len(explicit or []), 'observed': len(target),
        'source_checkpoint': copy.deepcopy(dataset.get('checkpoint'))}


def compact_row(row, as_of, allow_synthetic=False):
    if not isinstance(row, dict):
        raise ValueError('INVALID_DATASET_ROW')
    snapshot, label = row.get('snapshot'), row.get('label')
    if not isinstance(label, dict):
        return None, 'NO_LABEL'
    if label.get('mode') != 'PAPER' or label.get('realTrading') is not False:
        raise ValueError('PAPER_ONLY')
    operation_id = label.get('operation_id')
    if not isinstance(operation_id, str) or not 1 <= len(operation_id) <= 128:
        raise ValueError('INVALID_OPERATION_ID')
    revision = stamp(label.get('label_revision', label.get('revision', 1)), 'LABEL_REVISION')
    if revision < 1:
        raise ValueError('INVALID_LABEL_REVISION')
    label_hash = label.get('label_hash')
    if not isinstance(label_hash, str) or len(label_hash) != 64:
        raise ValueError('INVALID_LABEL_HASH')
    status = label.get('status')
    if status not in ['MATURE', 'PENDING', 'EXCLUDED']:
        raise ValueError('INVALID_LABEL_STATUS')
    stub = {'operation_id': operation_id, 'label_revision': revision,
            'label_hash': label_hash, 'status': status,
            'reason': label.get('exclusion') or label.get('reason')}
    if not isinstance(snapshot, dict):
        stub.update(status='EXCLUDED', reason='NO_PRE_ENTRY_SNAPSHOT')
        return {'key': None, 'row': stub}, None
    if snapshot.get('mode') != 'PAPER' or snapshot.get('realTrading') is not False:
        raise ValueError('PAPER_ONLY')
    if status != 'MATURE' and not isinstance(snapshot.get('domain'), dict):
        stub['reason'] = stub['reason'] or 'NO_PRE_ENTRY_FEATURES'
        return {'key': None, 'row': stub}, None
    if snapshot.get('synthetic') or label.get('synthetic') or row.get('synthetic'):
        if not allow_synthetic:
            raise ValueError('SYNTHETIC_DATA_FORBIDDEN')
    domain = validate_domain(snapshot.get('domain'))
    names = snapshot.get('feature_names')
    if (snapshot.get('feature_version') != FEATURE_VERSION or names != FEATURE_NAMES or not isinstance(names, list)
            or not 1 <= len(names) <= MAX_FEATURES or len(set(names)) != len(names)
            or any(not isinstance(n, str) or not n or len(n) > 96 for n in names)):
        raise ValueError('FEATURE_SCHEMA_MISMATCH')
    schema_hash = digest({'version': FEATURE_VERSION, 'names': names})
    if snapshot.get('feature_schema_hash', snapshot.get('schema_hash')) != schema_hash:
        raise ValueError('FEATURE_SCHEMA_HASH_MISMATCH')
    schema = {'feature_version': FEATURE_VERSION, 'feature_schema_hash': schema_hash,
              'feature_names': names, 'domain': domain}
    key = digest(schema)
    if status != 'MATURE':
        return {'key': key, 'schema': schema, 'row': stub}, None
    if (snapshot.get('operation_id') != operation_id
            or snapshot.get('stage') != 'PRE_SELECTION'
            or snapshot.get('data_quality') != 'PRE_DECISION_OBSERVED'
            or snapshot.get('exclusion') is not None
            or not isinstance(snapshot.get('input_hash'), str)
            or len(snapshot['input_hash']) != 64
            or label.get('snapshot_hash') != snapshot.get('snapshot_hash')
            or not isinstance(snapshot.get('snapshot_hash'), str)):
        raise ValueError('MISSING_IMMUTABLE_PRE_ENTRY_SNAPSHOT')
    x = snapshot.get('x')
    if not isinstance(x, list) or len(x) != len(names):
        raise ValueError('FEATURE_VECTOR_MISMATCH')
    x = [finite(v, 'FEATURE') for v in x]
    if any(abs(v) > 1e12 for v in x):
        raise ValueError('FEATURE_MAGNITUDE_LIMIT')
    signal_at = stamp(snapshot.get('signal_at'), 'SIGNAL_AT')
    decision_at = stamp(snapshot.get('decision_at'), 'DECISION_AT')
    entered_at = stamp(label.get('entered_at'), 'ENTERED_AT')
    closed_at = stamp(label.get('closed_at'), 'CLOSED_AT')
    mature_at = stamp(label.get('mature_at'), 'MATURE_AT')
    if not signal_at <= decision_at <= entered_at < closed_at <= mature_at <= as_of:
        raise ValueError('NONCAUSAL_OR_IMMATURE_LABEL')
    if stamp(snapshot.get('cutoff', signal_at), 'CUTOFF') > decision_at:
        raise ValueError('FUTURE_FEATURES')
    for key_at in ['max_input_available_at', 'max_market_event_at']:
        if snapshot.get(key_at) is not None and stamp(snapshot[key_at]) > decision_at:
            raise ValueError('FUTURE_FEATURES')
    if (label.get('quality') not in ['OBSERVED', 'OBSERVED_PRICE_RECONCILED_FUNDING']
            or label.get('manual_override') is not False or label.get('funding_final') is not True):
        raise ValueError('UNRESOLVED_OR_MANUAL_MATURE_LABEL')
    exposure, net = finite(label.get('exposure'), 'EXPOSURE'), finite(label.get('net'), 'NET')
    costs, y = finite(label.get('costs'), 'COSTS'), finite(label.get('net_return'), 'NET_RETURN')
    if exposure <= 0 or abs(y - net / exposure) > 1e-10 * max(1, abs(y)):
        raise ValueError('LABEL_ACCOUNTING_MISMATCH')
    context = snapshot.get('context') or {}
    movement = context.get('movement_key')
    if not isinstance(movement, str) or not movement or len(movement) > 256:
        raise ValueError('MISSING_MOVEMENT_GROUP')
    decision = row.get('decision') or {}
    candidate_predictions = decision.get('candidate_predictions') or []
    if not isinstance(candidate_predictions, list) or len(candidate_predictions) > 1:
        raise ValueError('CANDIDATE_PREDICTION_LIMIT')
    predictions = []
    for prediction in [decision.get('prediction') or {}, *candidate_predictions]:
        if prediction.get('status') not in ['PREDICTED', 'AVAILABLE']:
            continue
        prediction_at = stamp(decision.get('at'), 'PREDICTION_AT')
        if not decision_at <= prediction_at <= entered_at:
            raise ValueError('POST_ENTRY_PREDICTION')
        generated_at = stamp(prediction.get('generated_at', prediction_at), 'PREDICTION_GENERATED_AT')
        if not decision_at <= generated_at <= entered_at:
            raise ValueError('POST_ENTRY_PREDICTION')
        pred = {'model_id': prediction.get('model_id') or decision.get('model_id'),
                'at': prediction_at,
                'estimate': finite(prediction.get('estimated_net_return'), 'PREDICTION'),
                'cohort_id': decision.get('cohort_id'), 'base_rank': decision.get('base_rank'),
                'base_candidate_count': decision.get('base_candidate_count'),
                'base_eligible': decision.get('base_eligible') is True}
        previous = next((p for p in predictions if p['model_id'] == pred['model_id']), None)
        if previous and previous != pred:
            raise ValueError('CONFLICTING_MODEL_PREDICTION')
        if not previous:
            predictions.append(pred)
    stub.update(x=x, y=y, exposure=exposure, net=net, costs=costs,
                signal_at=signal_at, decision_at=decision_at, entered_at=entered_at,
                closed_at=closed_at, mature_at=mature_at, movement_key=movement,
                confirmation_key=context.get('confirmation_key'),
                pattern=snapshot.get('pattern') or context.get('pattern') or 'UNKNOWN',
                input_hash=snapshot.get('input_hash'), prediction=predictions[0] if predictions else None,
                predictions=predictions,
                full_fill=label.get('full_fill') is True,
                adverse_return=(None if label.get('adverse_return') is None else finite(label['adverse_return'])))
    return {'key': key, 'schema': schema, 'row': stub}, None


def ingest(checkpoint, dataset, now, allow_synthetic=False):
    if dataset.get('version') != DATASET_VERSION or dataset.get('mode') != 'PAPER' or dataset.get('realTrading', False) is not False:
        raise ValueError('PAPER_DATASET_VERSION_REQUIRED')
    as_of = stamp(dataset.get('as_of'), 'DATASET_AS_OF')
    if as_of > now:
        raise ValueError('FUTURE_DATASET')
    rows = dataset.get('rows')
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        raise ValueError('DATASET_ROW_LIMIT')
    ingest_opportunities(checkpoint, dataset, rows, as_of, allow_synthetic)
    changes, skips = [], Counter()
    for value in rows:
        result, skip = compact_row(value, as_of, allow_synthetic)
        if skip:
            skips[skip] += 1
            continue
        row, key = result['row'], result['key']
        previous_key = checkpoint.setdefault('operation_groups', {}).get(row['operation_id'])
        if previous_key is not None and key is not None and previous_key != key:
            raise ValueError('OPERATION_DOMAIN_CHANGED')
        if previous_key is not None and key is None:
            key = previous_key
        if key is not None:
            checkpoint['operation_groups'][row['operation_id']] = key
        if key is None:
            target = checkpoint['unassigned_exclusions']
        else:
            if key not in checkpoint['groups']:
                if len(checkpoint['groups']) >= MAX_GROUPS:
                    raise ValueError('DOMAIN_GROUP_LIMIT')
                checkpoint['groups'][key] = {**result['schema'], 'rows': {}, 'processed': {},
                    'normalization': None, 'trainer': None, 'candidate': None, 'active': None,
                    'history': [], 'attempts': 0, 'attempt_epoch_at': now,
                    'lineage': 1, 'status': 'COLLECTING', 'last_training_at': None}
            target = checkpoint['groups'][key]['rows']
        prior = target.get(row['operation_id']) or checkpoint['unassigned_exclusions'].get(row['operation_id'])
        if prior:
            if row['label_revision'] < prior['label_revision']:
                skips['OLDER_LABEL_REVISION'] += 1
                continue
            if row['label_revision'] == prior['label_revision'] and row['label_hash'] != prior['label_hash']:
                raise ValueError('CONFLICTING_LABEL_REVISION')
            if row['label_hash'] == prior['label_hash']:
                skips['DUPLICATE_LABEL'] += 1
                continue
        target[row['operation_id']] = row
        if key is not None:
            checkpoint['unassigned_exclusions'].pop(row['operation_id'], None)
        changes.append({'group': key, 'operation_id': row['operation_id'],
                        'old_hash': prior['label_hash'] if prior else None,
                        'new_hash': row['label_hash']})
    if (sum(len(g['rows']) for g in checkpoint['groups'].values())
            + len(checkpoint['unassigned_exclusions']) > MAX_ROWS):
        raise ValueError('CHECKPOINT_ROW_LIMIT')
    checkpoint['source_checkpoint'] = copy.deepcopy(dataset.get('checkpoint'))
    return changes, dict(skips)


def model_config():
    return dict(hidden_layer_sizes=(16, 8), activation='tanh', solver='sgd',
                learning_rate='constant', learning_rate_init=PROTOCOL['learning_rate'],
                momentum=0, nesterovs_momentum=False, alpha=PROTOCOL['l2'],
                shuffle=False, batch_size=PROTOCOL['batch_size'], max_iter=1,
                random_state=PROTOCOL['seed'], tol=0, n_iter_no_change=1_000_000)


def restore_model(saved, dimension):
    np, MLPRegressor, _ = libraries()
    model = MLPRegressor(**model_config())
    if saved is None:
        return model
    if saved.get('dependency_versions') != DEPENDENCIES or saved.get('config') != json.loads(canonical(model_config())):
        raise ValueError('TRAINER_CHECKPOINT_INCOMPATIBLE')
    # Initialize sklearn's fitted bookkeeping through its public API, then
    # replace weights/metrics. The dummy update is discarded. Constant SGD with
    # momentum=0 has no optimizer history that can influence the next gradient.
    model.partial_fit(np.zeros((32, dimension)), np.zeros(32))
    model.coefs_ = [np.asarray(v, dtype=np.float64) for v in saved['weights']]
    model.intercepts_ = [np.asarray(v, dtype=np.float64) for v in saved['biases']]
    for key in ['t_', 'n_iter_', 'loss_', 'best_loss_', '_no_improvement_count']:
        setattr(model, key, saved['metrics'][key])
    model.loss_curve_ = list(saved['metrics']['loss_curve_'])
    expected = [(dimension, 16), (16, 8), (8, 1)]
    if ([a.shape for a in model.coefs_] != expected
            or [a.shape for a in model.intercepts_] != [(16,), (8,), (1,)]
            or not all(np.isfinite(a).all() for a in model.coefs_ + model.intercepts_)):
        raise ValueError('INVALID_TRAINER_CHECKPOINT_SHAPES')
    return model


def save_model(model):
    return {'dependency_versions': dict(DEPENDENCIES),
            'config': json.loads(canonical(model_config())),
            'weights': [a.tolist() for a in model.coefs_],
            'biases': [a.tolist() for a in model.intercepts_],
            'metrics': {key: (list(model.loss_curve_[-1000:]) if key == 'loss_curve_' else getattr(model, key))
                        for key in ['t_', 'n_iter_', 'loss_', 'best_loss_',
                                    '_no_improvement_count', 'loss_curve_']}}


def fit_increment(group, rows, now):
    np, _, limits = libraries()
    x = np.asarray([r['x'] for r in rows], dtype=np.float64)
    y = np.asarray([r['y'] for r in rows], dtype=np.float64) / PROTOCOL['output_scale']
    initial = group['trainer'] is None
    if group['normalization'] is None:
        mean, scale = x.mean(axis=0), x.std(axis=0)
        scale[scale < 1e-12] = 1.0
        group['normalization'] = {'mean': mean.tolist(), 'scale': scale.tolist()}
    norm = group['normalization']
    transformed = (x - np.asarray(norm['mean'])) / np.asarray(norm['scale'])
    if not np.isfinite(transformed).all() or float(np.max(np.abs(transformed))) > 1e6:
        raise ValueError('NORMALIZED_TRAINING_RANGE_EXCEEDED')
    model = restore_model(group['trainer'], x.shape[1])
    epochs = PROTOCOL['initial_epochs'] if initial else PROTOCOL['incremental_epochs']
    if len(rows) < model.batch_size:
        model.batch_size = len(rows)
    with limits(limits=1):
        for _ in range(epochs):
            model.partial_fit(transformed, y)
    group['trainer'] = save_model(model)
    for row in rows:
        group['processed'][row['operation_id']] = row['label_hash']
    group['last_training_at'] = now
    return {'count': len(rows), 'epochs': epochs, 'batch_hash': digest([
        [r['operation_id'], r['label_hash']] for r in rows]), 'initial_or_rebuild': initial}


def predict_payload(payload, values):
    x = [(finite(v) - m) / s for v, m, s in zip(values,
         payload['normalization']['mean'], payload['normalization']['scale'])]
    if len(x) != payload['architecture']['input']:
        raise ValueError('INFERENCE_DIMENSION_MISMATCH')
    for index, layer in enumerate(payload['layers']):
        next_x = [b + sum(v * layer['weights'][i][j] for i, v in enumerate(x))
                  for j, b in enumerate(layer['bias'])]
        x = [math.tanh(v) for v in next_x] if index < 2 else next_x
    return finite(x[0] * payload['output_transform']['scale'] + payload['output_transform']['mean'])


def create_candidate(group, now, batch):
    if len(group['history']) >= MAX_CANDIDATES_PER_GROUP:
        raise ValueError('CANDIDATE_REGISTRY_ARCHIVAL_REQUIRED')
    used = [r for r in group['rows'].values() if r['status'] == 'MATURE'
            and group['processed'].get(r['operation_id']) == r['label_hash']]
    model = group['trainer']
    dimension = len(group['feature_names'])
    train_min = [min(r['x'][i] for r in used) for i in range(dimension)]
    train_max = [max(r['x'][i] for r in used) for i in range(dimension)]
    margins = [1e-9 if train_max[i] - train_min[i] < 1e-12
               else 3 * group['normalization']['scale'][i] for i in range(dimension)]
    min_x = [value - margins[i] for i, value in enumerate(train_min)]
    max_x = [value + margins[i] for i, value in enumerate(train_max)]
    training_hash = digest(sorted(group['processed'].items()))
    model_id = 'nn_' + digest([TRAINER_VERSION, group['domain'], group['lineage'],
                              group['attempts'], training_hash, model['weights']])[:32]
    payload = {
        'version': MODEL_VERSION, 'model_id': model_id,
        'mode': 'PAPER', 'symbol': 'PF_XBTUSD', 'ledger': 'FREQUENT_PAPER',
        'schema_version': FEATURE_VERSION, 'feature_version': FEATURE_VERSION,
        'feature_schema_hash': group['feature_schema_hash'],
        'feature_names': group['feature_names'], 'domain': group['domain'],
        'architecture': {'input': dimension, 'hidden': [16, 8], 'output': 1,
                         'activation': 'tanh', 'output_activation': 'identity'},
        'normalization': copy.deepcopy(group['normalization']),
        'output_transform': {'mean': 0, 'scale': PROTOCOL['output_scale']},
        'input_domain': {'min': min_x, 'max': max_x},
        'training_input_domain': {'min': train_min, 'max': train_max,
                                  'margin_policy': 'THREE_FROZEN_TRAIN_STD_CONSTANT_FEATURE_1E_MINUS9'},
        'layers': [{'weights': w, 'bias': b} for w, b in zip(model['weights'], model['biases'])],
        'trained_at': now, 'created_at': now, 'expires_at': now + PROTOCOL['candidate_age_ms'],
        'training_cutoff': max(r['mature_at'] for r in used),
        'last_training_signal_at': max(r['decision_at'] for r in used),
        'max_label_mature_at': max(r['mature_at'] for r in used),
        'seed': PROTOCOL['seed'], 'trainer_version': TRAINER_VERSION,
        'trainer_dependencies': dict(DEPENDENCIES), 'training_labels': len(used),
        'training_dataset_hash': training_hash, 'checkpoint_id': digest(model),
        'training_movements': len({r['movement_key'] for r in used}),
        'baseline_mean_return': statistics.fmean(r['y'] for r in used),
        'protocol_hash': digest(PROTOCOL),
        'validation': {'status': 'PENDING_PROSPECTIVE', 'criteria_version': CRITERIA_VERSION,
                       'assistance_authorized': False, 'reason': 'FUTURE_OUTCOMES_REQUIRED'},
    }
    candidate = {'payload': payload, 'training_label_hashes': dict(group['processed']),
                 'training_movements': sorted({r['movement_key'] for r in used}),
                 'created_at': now, 'batch': batch, 'review': None,
                 'status': 'PENDING_PROSPECTIVE'}
    group['candidate'] = candidate
    group['history'].append({'model_id': model_id, 'created_at': now,
        'training_dataset_hash': training_hash, 'training_labels': len(used),
        'status': 'PENDING_PROSPECTIVE', 'batch': batch})
    return candidate


def envelope(payload):
    raw = canonical(payload)
    artifact = {'version': ARTIFACT_VERSION, 'payload_json': raw,
                'sha256': hashlib.sha256(raw.encode()).hexdigest()}
    if len(canonical(artifact).encode()) > MAX_ARTIFACT_BYTES:
        raise ValueError('ARTIFACT_SIZE_LIMIT')
    return artifact


def outcome_metrics(rows):
    if not rows:
        return {'n': 0, 'net_per_100': 0, 'drawdown_per_100': 0, 'worst_return': None}
    ordered = sorted(rows, key=lambda r: (r['closed_at'], r['operation_id']))
    net, peak, dd = 0.0, 0.0, 0.0
    for row in ordered:
        net += row['y']
        peak = max(peak, net)
        dd = max(dd, peak - net)
    dates = {r['decision_at'] // DAY for r in rows}
    adverse = [r['adverse_return'] for r in rows if r.get('adverse_return') is not None]
    return {'n': len(rows), 'net_per_100': 100 * net, 'drawdown_per_100': 100 * dd,
            'drawdown_basis': 'CLOSED_TRADE_RETURN_CURVE_AT_EQUAL_100_NOMINAL',
            'worst_return': min(r['y'] for r in rows),
            'worst_observed_adverse_return': min(adverse) if adverse else None,
            'observed_adverse_n': len(adverse),
            'mean_return': statistics.fmean(r['y'] for r in rows),
            'costs_per_100': 100 * sum(r['costs'] / r['exposure'] for r in rows),
            'total_exposure': sum(r['exposure'] for r in rows),
            'observed_net': sum(r['net'] for r in rows),
            'days': len(dates), 'entries_per_day': len(rows) / max(1, len(dates)),
            'mean_duration_ms': statistics.fmean(r['closed_at'] - r['entered_at'] for r in rows)}


def block_interval(values_by_day, seed=1729):
    import random
    values = [statistics.fmean(values_by_day[day]) for day in sorted(values_by_day)]
    if len(values) < PROTOCOL['min_final_days']:
        return {'lower': None, 'upper': None, 'days': len(values), 'reason': 'MORE_DAYS_REQUIRED'}
    rng, means, n = random.Random(seed), [], len(values)
    block = PROTOCOL['bootstrap_block_days']
    for _ in range(PROTOCOL['bootstrap_reps']):
        sample = []
        while len(sample) < n:
            start = rng.randrange(n)
            sample.extend(values[(start + j) % n] for j in range(block))
        means.append(statistics.fmean(sample[:n]))
    means.sort()
    alpha = PROTOCOL['family_alpha'] / PROTOCOL['max_attempts_per_epoch']
    return {'lower': means[int(len(means) * alpha / 2)],
            'upper': means[min(len(means) - 1, int(len(means) * (1 - alpha / 2)))],
            'days': n, 'block_days': block, 'reps': len(means), 'alpha': alpha,
            'unit': 'DAILY_BLOCK_NOT_INDEPENDENT_TRADES'}


def priority_report(rows, opportunities, *, complete):
    # No result is fabricated for unfilled/discarded candidates. Complete cohorts
    # must contain every base-eligible candidate, all actually filled and mature.
    # This measures ranking on observed executions, not a counterfactual price.
    # The denominator comes from all observed base decisions, not only rows
    # on which this model happened to predict or which eventually filled.
    observed = defaultdict(list)
    for opportunity in opportunities:
        if opportunity['base_candidate_count'] >= 2:
            observed[opportunity['cohort_id']].append(opportunity)
    groups = {key: values for key, values in observed.items()
              if any(r['base_eligible'] for r in values)}
    outcomes = {r['operation_id']: r for r in rows}
    base, model, by_day, exclusions = [], [], defaultdict(list), Counter()
    for evidence in groups.values():
        count = evidence[0]['base_candidate_count']
        if (len(evidence) != count
                or any(r['base_candidate_count'] != count for r in evidence)
                or sorted(r['base_rank'] for r in evidence) != list(range(count))
                or any(not r['base_eligible'] for r in evidence)):
            exclusions['INCOMPLETE_OBSERVED_BASE_COHORT'] += 1
            continue
        cohort = [outcomes[r['operation_id']] for r in evidence if r['operation_id'] in outcomes]
        if (len(cohort) != count
                or any(r['prediction'].get('base_candidate_count') != count for r in cohort)
                or sorted(r['prediction'].get('base_rank', -1) for r in cohort) != list(range(count))
                or any(not r['prediction'].get('base_eligible') or not r['full_fill'] for r in cohort)):
            exclusions['INCOMPLETE_OBSERVED_BASE_COHORT'] += 1
            continue
        amounts = [r['exposure'] for r in cohort]
        if max(amounts) / min(amounts) - 1 > PROTOCOL['comparable_exposure_fraction']:
            exclusions['NONCOMPARABLE_EXPOSURE'] += 1
            continue
        b = min(cohort, key=lambda r: r['prediction']['base_rank'])
        m = min(cohort, key=lambda r: (-r['prediction']['estimate'], r['prediction']['base_rank']))
        base.append(b); model.append(m)
        by_day[b['decision_at'] // DAY].append(m['y'] - b['y'])
    coverage = len(base) / len(groups) if groups else 0
    bm, mm, ci = outcome_metrics(base), outcome_metrics(model), block_interval(by_day)
    enough = (len(base) >= PROTOCOL['min_priority_cohorts']
              and ci['days'] >= PROTOCOL['min_final_days'])
    tolerance = PROTOCOL['risk_tolerance_return']
    passed = (complete and enough and coverage >= PROTOCOL['min_priority_coverage']
        and ci['lower'] is not None and ci['lower'] > 0
        and mm['drawdown_per_100'] <= bm['drawdown_per_100'] + 100 * tolerance
        and mm['worst_return'] >= bm['worst_return'] - tolerance)
    return {'status': 'PASSED' if passed else 'PENDING_EVIDENCE' if not complete or not enough else 'REJECTED',
            'interpretation': 'OBSERVED_OUTCOME_RANKING_NOT_EXECUTION_COUNTERFACTUAL',
            'cohorts': len(base), 'eligible_cohorts': len(groups), 'coverage': coverage,
            'coverage_basis': 'ALL_OBSERVED_PROSPECTIVE_BASE_COHORTS',
            'coverage_manifest_complete': complete,
            'reason': 'COMPLETE_OPPORTUNITY_MANIFEST_REQUIRED' if not complete else
                      'PRIORITY_COVERAGE_BELOW_MINIMUM' if enough and coverage < PROTOCOL['min_priority_coverage'] else
                      'OBSERVED_RANKING_GATES_PASSED' if passed else 'MORE_OR_BETTER_PROSPECTIVE_EVIDENCE_REQUIRED',
            'baseline': bm, 'prioritized': mm, 'advantage_interval': ci,
            'exclusions': dict(exclusions)}


def prospective_opportunities(candidate, calibration, opportunities, now):
    if len(calibration) < PROTOCOL['calibration_n']:
        return []
    payload = candidate['payload']
    boundary = max(payload['trained_at'], payload['max_label_mature_at'] + PROTOCOL['purge_ms'],
                   max(r['mature_at'] for r in calibration) + PROTOCOL['purge_ms'])
    excluded_movements = set(candidate['training_movements']) | {r['movement_key'] for r in calibration}
    return [row for row in opportunities
            if boundary <= row['decision_at'] <= row['recorded_at'] <= now
            and row['movement_key'] not in excluded_movements
            and row['feature_version'] == payload['feature_version']
            and row['feature_schema_hash'] == payload['feature_schema_hash']
            and (row['domain'] is None or row['domain'] == payload['domain'])]


def prospective_windows(candidate, rows, now):
    payload = candidate['payload']
    train_groups = set(candidate['training_movements'])
    eligible, excluded = [], Counter()
    for r in rows:
        p = next((p for p in r.get('predictions', [r.get('prediction')])
                  if p and p.get('model_id') == payload['model_id']), None)
        if not p or p.get('model_id') != payload['model_id']:
            excluded['NO_PROSPECTIVE_MODEL_PREDICTION'] += 1
            continue
        if r['movement_key'] in train_groups:
            excluded['TRAINING_MOVEMENT_OVERLAP'] += 1
            continue
        if r['decision_at'] < max(payload['trained_at'], payload['max_label_mature_at'] + PROTOCOL['purge_ms']):
            excluded['TRAINING_RESULT_WINDOW_OVERLAP'] += 1
            continue
        if not payload['trained_at'] <= p['at'] <= r['entered_at'] < r['closed_at'] <= r['mature_at'] <= now:
            excluded['NONPROSPECTIVE_PREDICTION'] += 1
            continue
        expected = predict_payload(payload, r['x'])
        if abs(expected - p['estimate']) > 1e-10 * max(1, abs(expected)):
            excluded['PREDICTION_ARTIFACT_MISMATCH'] += 1
            continue
        eligible.append({**r, 'prediction': p})
    eligible.sort(key=lambda r: (r['decision_at'], r['operation_id']))
    calibration = eligible[:PROTOCOL['calibration_n']]
    if len(calibration) < PROTOCOL['calibration_n']:
        return calibration, [], dict(excluded)
    calibration_groups = {r['movement_key'] for r in calibration}
    boundary = max(r['mature_at'] for r in calibration) + PROTOCOL['purge_ms']
    final = []
    for r in eligible[PROTOCOL['calibration_n']:]:
        if r['movement_key'] in calibration_groups or r['decision_at'] < boundary:
            excluded['CALIBRATION_RESULT_OR_MOVEMENT_OVERLAP'] += 1
        else:
            final.append(r)
    return calibration, final, dict(excluded)


def prospective_review(candidate, rows, now, opportunities, *, opportunities_complete):
    payload = candidate['payload']
    calibration, final, excluded = prospective_windows(candidate, rows, now)
    if len(calibration) < PROTOCOL['calibration_n']:
        return {'status': 'PENDING_PROSPECTIVE', 'criteria_version': CRITERIA_VERSION,
                'assistance_authorized': False, 'reason': 'MORE_CALIBRATION_OUTCOMES',
                'calibration_n': len(calibration), 'final_n': 0, 'exclusions': excluded}
    days = len({r['decision_at'] // DAY for r in final})
    movements = len({r['movement_key'] for r in final})
    report = {'criteria_version': CRITERIA_VERSION, 'assistance_authorized': False,
        'calibration_n': len(calibration), 'final_n': len(final), 'final_days': days,
        'final_movements': movements, 'exclusions': excluded,
        'parameter_choice': 'PREDECLARED_NOT_TUNED_ON_CALIBRATION_OR_FINAL',
        'calibration_label_hash': digest([(r['operation_id'], r['label_hash']) for r in calibration]),
        'calibration_operation_ids': [r['operation_id'] for r in calibration],
        'final_label_hash': digest([(r['operation_id'], r['label_hash']) for r in final])}
    if len(final) < PROTOCOL['min_final'] or days < PROTOCOL['min_final_days'] or movements < PROTOCOL['min_final_movements']:
        return {**report, 'status': 'PENDING_PROSPECTIVE', 'reason': 'MORE_FINAL_PROSPECTIVE_OUTCOMES'}
    baseline = payload['baseline_mean_return']
    squared = lambda r: (r['prediction']['estimate'] - r['y']) ** 2
    base_squared = lambda r: (baseline - r['y']) ** 2
    mse = statistics.fmean(squared(r) for r in final)
    base_mse = statistics.fmean(base_squared(r) for r in final)
    mae = statistics.fmean(abs(r['prediction']['estimate'] - r['y']) for r in final)
    base_mae = statistics.fmean(abs(baseline - r['y']) for r in final)
    by_day, by_pattern, by_period = defaultdict(list), defaultdict(list), defaultdict(list)
    first_day = min(r['decision_at'] // DAY for r in final)
    for r in final:
        by_day[r['decision_at'] // DAY].append(base_squared(r) - squared(r))
        by_pattern[r['pattern']].append(r)
        by_period[(r['decision_at'] // DAY - first_day) // 7].append(r)
    def subgroup(rr):
        return {**outcome_metrics(rr), 'mse': statistics.fmean(squared(r) for r in rr),
                'baseline_mse': statistics.fmean(base_squared(r) for r in rr)}
    patterns = {p: subgroup(rr) for p, rr in by_pattern.items()}
    periods = {str(p): subgroup(rr) for p, rr in by_period.items()}
    ci = block_interval(by_day)
    stable = all(v['mse'] <= v['baseline_mse'] * 1.2 + 1e-15
                 for v in [*patterns.values(), *periods.values()] if v['n'] >= 8)
    forecast_pass = (base_mse > 0 and mse <= base_mse * (1 - PROTOCOL['mse_improvement'])
        and mae <= base_mae * (1 - PROTOCOL['mae_improvement'])
        and ci['lower'] is not None and ci['lower'] > 0 and stable)
    priority = priority_report(final,
        prospective_opportunities(candidate, calibration, opportunities, now),
        complete=opportunities_complete)
    passed = forecast_pass and priority['status'] == 'PASSED'
    return {**report, 'status': 'PASSED' if passed else
            'FORECAST_VALIDATED_PRIORITIZATION_PENDING' if forecast_pass and priority['status'] == 'PENDING_EVIDENCE' else 'REJECTED',
            'assistance_authorized': passed,
            'reason': 'PROSPECTIVE_FORECAST_AND_OBSERVED_RANKING_GATES' if passed else
            'PRIORITIZATION_UTILITY_NOT_ESTABLISHED' if forecast_pass else 'NO_RELIABLE_PREDICTIVE_IMPROVEMENT',
            'mse': mse, 'baseline_mse': base_mse, 'mae': mae, 'baseline_mae': base_mae,
            'prediction_error_advantage_interval': ci, 'stable': stable,
            'base_rules': outcome_metrics(final), 'by_pattern': patterns,
            'by_period': periods, 'priority': priority, 'reviewed_at': now,
            'final_operation_ids': [r['operation_id'] for r in final]}


def validation_artifact(candidate):
    payload = copy.deepcopy(candidate['payload'])
    # ID-level manifests remain private in the trainer checkpoint. Runtime needs
    # criteria and aggregate metrics, not the private training/holdout dataset.
    payload['validation'] = {k: v for k, v in candidate['review'].items()
                             if k not in ['calibration_operation_ids', 'final_operation_ids', 'priority_operation_ids']}
    return envelope(payload)


def model_label_dependencies(model):
    dependencies = dict(model.get('training_label_hashes', {}))
    dependencies.update(model.get('validation_label_hashes', {}))
    return dependencies


def references_changed(model, rows):
    return [op for op, old in model_label_dependencies(model).items()
            if op not in rows or rows[op]['status'] != 'MATURE' or rows[op]['label_hash'] != old]


def finalize_candidate(group, candidate, rows, now, artifacts):
    candidate['status'] = candidate['review']['status']
    group['history'][-1].update(status=candidate['status'], reviewed_at=now,
                               final_label_hash=candidate['review'].get('final_label_hash'))
    report = candidate['review']
    ids = (set(report.get('calibration_operation_ids', []))
           | set(report.get('final_operation_ids', [])) | set(report.get('priority_operation_ids', [])))
    candidate['validation_label_hashes'] = {
        r['operation_id']: r['label_hash'] for r in rows if r['operation_id'] in ids}
    if candidate['status'] == 'PASSED':
        group['active'] = copy.deepcopy(candidate)
        artifacts.append(validation_artifact(candidate))


def run_training(dataset, checkpoint=None, *, now=None, allow_synthetic=False):
    guard_environment('PAPER')
    now = stamp(int(time.time() * 1000) if now is None else now)
    state = copy.deepcopy(checkpoint) if checkpoint is not None else new_checkpoint(now)
    if (state.get('version') != CHECKPOINT_VERSION or state.get('mode') != 'PAPER'
            or state.get('protocol_hash') != digest(PROTOCOL)):
        raise ValueError('CHECKPOINT_PROTOCOL_MISMATCH')
    changes, skips = ingest(state, dataset, now, allow_synthetic)
    reports, artifacts, revoked = {}, [], []
    opportunities = list(state.get('opportunities', {}).values())
    opportunities_complete = state.get('opportunities_manifest', {}).get('complete') is True
    for key, group in state['groups'].items():
        rows = sorted((r for r in group['rows'].values() if r['status'] == 'MATURE'),
                      key=lambda r: (r['mature_at'], r['operation_id']))
        if group.get('active') and references_changed(group['active'], group['rows']):
            revoked.append(group['active']['payload']['model_id'])
            for entry in group['history']:
                if entry['model_id'] == group['active']['payload']['model_id']:
                    entry.update(status='INVALIDATED_LABEL_REVISION', invalidated_at=now)
            group['active'] = None
        changed_used = [op for op, prior_hash in group['processed'].items()
                        if not group['rows'].get(op) or group['rows'][op]['status'] != 'MATURE'
                        or group['rows'][op]['label_hash'] != prior_hash]
        if changed_used:
            if group['candidate']:
                revoked.append(group['candidate']['payload']['model_id'])
                group['history'][-1].update(status='INVALIDATED_LABEL_REVISION', at=now,
                                           reason='FUNDING_OR_LABEL_RECONCILIATION')
            group['candidate'], group['trainer'], group['processed'] = None, None, {}
            group['lineage'] += 1
        candidate = group['candidate']
        if candidate and candidate.get('validation_label_hashes'):
            if references_changed(candidate, group['rows']):
                revoked.append(candidate['payload']['model_id'])
                group['history'][-1].update(status='INVALIDATED_FINAL_LABEL_REVISION', at=now)
                group['candidate'] = candidate = None
        terminal_this_run = False
        if candidate and candidate['status'] == 'PENDING_PROSPECTIVE':
            report = prospective_review(candidate, rows, now, opportunities,
                                        opportunities_complete=opportunities_complete)
            candidate['review'] = report
            if report['status'] != 'PENDING_PROSPECTIVE':
                finalize_candidate(group, candidate, rows, now, artifacts)
                terminal_this_run = report['status'] in ['PASSED', 'REJECTED']
        elif candidate and candidate['status'] == 'FORECAST_VALIDATED_PRIORITIZATION_PENDING':
            # The forecast final period has been used once and remains frozen.
            # A separate predeclared ranking gate waits for enough complete
            # observed cohorts; it is evaluated once, not repeatedly optimized.
            calibration, priority_rows, _ = prospective_windows(candidate, rows, now)
            priority = priority_report(priority_rows,
                prospective_opportunities(candidate, calibration, opportunities, now),
                complete=opportunities_complete)
            candidate['review']['priority'] = priority
            if priority['status'] != 'PENDING_EVIDENCE':
                candidate['review'].update(priority=priority,
                    status='PASSED' if priority['status'] == 'PASSED' else 'REJECTED',
                    assistance_authorized=priority['status'] == 'PASSED',
                    reason='PROSPECTIVE_FORECAST_AND_OBSERVED_RANKING_GATES'
                           if priority['status'] == 'PASSED' else 'PRIORITIZATION_UTILITY_NOT_ESTABLISHED',
                    priority_operation_ids=[r['operation_id'] for r in priority_rows],
                    priority_reviewed_at=now)
                finalize_candidate(group, candidate, rows, now, artifacts)
                terminal_this_run = True
        if candidate and candidate['status'] in ['PENDING_PROSPECTIVE', 'FORECAST_VALIDATED_PRIORITIZATION_PENDING'] and now > candidate['payload']['expires_at']:
            candidate['status'] = 'EXPIRED'
            group['history'][-1].update(status='EXPIRED', at=now)
            terminal_this_run = True
        new_rows = [r for r in rows if r['operation_id'] not in group['processed']]
        movements = len({r['movement_key'] for r in rows})
        eligible = len(rows) >= PROTOCOL['min_training'] and movements >= PROTOCOL['min_training_movements']
        candidate_waiting = candidate and candidate['status'] in ['PENDING_PROSPECTIVE', 'FORECAST_VALIDATED_PRIORITIZATION_PENDING']
        if now - group['attempt_epoch_at'] >= PROTOCOL['attempt_epoch_ms']:
            group['attempts'], group['attempt_epoch_at'] = 0, now
            if candidate and candidate['status'] != 'PASSED' and now > candidate['payload']['expires_at']:
                candidate_waiting = False
        batch_ready = len(new_rows) >= (PROTOCOL['min_training'] if group['trainer'] is None else PROTOCOL['min_new_labels'])
        if eligible and batch_ready and not candidate_waiting and not terminal_this_run and group['attempts'] < PROTOCOL['max_attempts_per_epoch']:
            group['attempts'] += 1
            batch = fit_increment(group, new_rows, now)
            candidate = create_candidate(group, now, batch)
            artifacts.append(envelope(candidate['payload']))
        group['status'] = (candidate['status'] if candidate else 'COLLECTING')
        reasons = Counter(r.get('reason') or r['status'] for r in group['rows'].values() if r['status'] != 'MATURE')
        reports[key] = {'status': group['status'], 'usable': len(rows),
            'excluded': sum(r['status'] == 'EXCLUDED' for r in group['rows'].values()),
            'pending': sum(r['status'] == 'PENDING' for r in group['rows'].values()),
            'exclusions': dict(reasons), 'movements': movements,
            'processed_labels': len(group['processed']),
            'new_labels_waiting': sum(r['operation_id'] not in group['processed'] for r in rows),
            'last_training_at': group['last_training_at'], 'attempts': group['attempts'],
            'model_id': candidate['payload']['model_id'] if candidate else None,
            'active_model_id': group.get('active', {}).get('payload', {}).get('model_id') if group.get('active') else None,
            'validation': candidate['review'] if candidate else None,
            'domain': group['domain'], 'revised_training_operations': changed_used}
    state['runs'] += 1
    registry = state.setdefault('revoked_models', {})
    for model_id in revoked:
        registry.setdefault(model_id, {'at': now, 'reason': 'TRAINING_OR_VALIDATION_LABEL_REVISED'})
    receipt = {'version': TRAINER_VERSION, 'mode': 'PAPER', 'at': now,
        'status': 'COLLECTING' if not artifacts and not any(g['trainer'] for g in state['groups'].values()) else 'PROCESSED',
        'protocol_hash': digest(PROTOCOL), 'groups': reports,
        'changed_labels': len(changes), 'skipped': skips,
        'unassigned_excluded': len(state['unassigned_exclusions']),
        'opportunities': len(opportunities), 'opportunities_complete': opportunities_complete,
        'revoked_model_ids': sorted(registry), 'newly_revoked_model_ids': sorted(set(revoked)),
        'artifacts_created': len(artifacts),
        'training_location': 'EXTERNAL_RUNNER', 'uses_operational_db': False,
        'checkpoint_hash': digest({k: v for k, v in state.items() if k != 'last_run'})}
    state['last_run'] = receipt
    return state, receipt, artifacts


def run_files(args):
    path = Path(args.checkpoint)
    dataset = read_json(args.dataset)
    old = read_json(path) if path.exists() else None
    state, receipt, artifacts = run_training(dataset, old, now=args.now)
    # Immutable candidate content is written before the checkpoint references it.
    # Retrying after an interrupted save yields the same model and artifact hash.
    out = Path(args.output_dir)
    available = {a['sha256']: a for a in artifacts}
    for group in state['groups'].values():
        if group.get('candidate') and group['candidate']['status'] in ['PENDING_PROSPECTIVE', 'FORECAST_VALIDATED_PRIORITIZATION_PENDING']:
            a = envelope(group['candidate']['payload']); available[a['sha256']] = a
        if group.get('active'):
            a = validation_artifact(group['active']); available[a['sha256']] = a
    artifact_files = []
    for artifact in available.values():
        payload = json.loads(artifact['payload_json'])
        name = payload['model_id'] + '-' + artifact['sha256'][:12] + '.json'
        existing = out / name
        if existing.exists() and read_json(existing) != artifact:
            raise ValueError('IMMUTABLE_ARTIFACT_CONFLICT')
        if not existing.exists():
            atomic_json(existing, artifact)
        artifact_files.append({'file': name, 'model_id': payload['model_id'],
            'sha256': artifact['sha256'], 'role': 'VALIDATED' if payload['validation']['assistance_authorized'] else 'CANDIDATE'})
    atomic_json(path, state)
    atomic_json(out / 'last-receipt.json', {**receipt, 'artifact_files': artifact_files})
    print(canonical({'status': receipt['status'], 'changed_labels': receipt['changed_labels'],
                     'groups': len(receipt['groups']), 'artifacts_created': len(artifacts),
                     'revoked_models': len(receipt['revoked_model_ids']),
                     'receipt': str(out / 'last-receipt.json')}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', required=True)
    parser.add_argument('--checkpoint', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--mode', default='PAPER')
    parser.add_argument('--now', type=int)
    args = parser.parse_args()
    guard_environment(args.mode)
    path = Path(args.checkpoint)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(path.with_suffix(path.suffix + '.lock'), 'a') as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run_files(args)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No source dataset, prices, vectors, secrets or traceback in CI logs.
        print(canonical({'status': 'TRAINING_UNAVAILABLE_RULES_UNCHANGED',
                         'reason': str(error)[:180]}))
        raise SystemExit(1)
