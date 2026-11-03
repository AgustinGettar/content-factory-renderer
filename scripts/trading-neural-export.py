#!/usr/bin/env python3
"""Bounded, read-only WAL-consistent export for an EXTERNAL neural trainer.

No database copy, training, model execution or ledger write is performed here.
Only minimum learning records and execution evidence leave the SQLite snapshot.
"""
import argparse
import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile

VERSION = 'secondary-neural-export-1.0.0'
STATE_ID = 'KRAKEN_BTCUSD_PAPER'
KINDS = ('NEURAL_SIGNAL_CAPTURED', 'NEURAL_ENTRY_DECISION', 'NEURAL_LABEL_RECORDED',
         'NEURAL_RECONCILIATION_REQUIRED', 'SELECTED', 'FILLED', 'PARTIAL_FILL', 'PARTIAL_CLOSE',
         'CLOSED', 'FUNDING_RECONCILED', 'NOT_FILLED', 'ORDER_REMAINDER_CANCELLED',
         'SECONDARY_EXIT_ADVISORY_SNAPSHOT')
EVENT_KEYS = ('type', 'id', 'fill_id', 'at', 'price', 'qty', 'fee', 'pnl', 'fees',
              'gross', 'funding', 'entered_at', 'remaining_qty', 'reason', 'quality',
              'management_override', 'result_final', 'funding_complete', 'entry_fills',
              'excursions', 'data_gaps', 'amount', 'net_adjustment', 'net_after',
              'position_open', 'remaining_intervals', 'ledger', 'version', 'realTrading')
PLAN_KEYS = ('id', 'version', 'entry_revision', 'instrument', 'execution_model',
             'execution_contract', 'economic_policy', 'exit_policy', 'sizing',
             'timeframe', 'movement_id', 'parent_id', 'leg_index')
MAX_EVENT_BYTES = 1_048_576
MAX_EXPORT_BYTES = 32_000_000

def compact(payload, kind):
    if payload.get('ledger') != 'FREQUENT_PAPER' or payload.get('realTrading') is True:
        return None
    if kind == 'SECONDARY_EXIT_ADVISORY_SNAPSHOT':
        snapshot = payload.get('snapshot')
        if (not isinstance(snapshot, dict)
                or snapshot.get('version') != 'secondary-exit-advisory-snapshot-1.0.0'
                or snapshot.get('authority') != 'NONE'):
            return None
        return {'type': kind, 'at': payload.get('at'), 'id': payload.get('id'),
                'ledger': 'FREQUENT_PAPER', 'realTrading': False, 'snapshot': snapshot}
    if kind.startswith('NEURAL_'):
        key = {'NEURAL_SIGNAL_CAPTURED': 'snapshot', 'NEURAL_ENTRY_DECISION': 'decision',
               'NEURAL_LABEL_RECORDED': 'label'}.get(kind)
        if key:
            return {'type': kind, 'at': payload.get('at'), 'id': payload.get('id'),
                    'ledger': 'FREQUENT_PAPER', 'realTrading': False, key: payload[key]}
        return {k: payload[k] for k in ('type', 'id', 'at', 'reason') if k in payload}
    if payload.get('version') != 'secondary-futures-1.0.0':
        return None
    result = {k: payload[k] for k in EVENT_KEYS if k in payload}
    if isinstance(payload.get('plan'), dict):
        result['plan'] = {k: payload['plan'][k] for k in PLAN_KEYS if k in payload['plan']}
    return result

def export_snapshot(database, output, *, after=0, max_events=10000,
                    source_id='lumi-aws-eu-north-1-i-0ae2ad0bb886f3d7f', mode='PAPER'):
    if mode != 'PAPER':
        raise ValueError('NEURAL_EXPORT_PAPER_ONLY')
    if not isinstance(after, int) or after < 0 or not 1 <= max_events <= 10000:
        raise ValueError('NEURAL_EXPORT_BOUNDS')
    output = Path(output)
    source = Path(database).resolve()
    if output.resolve() in {source, Path(str(source) + '-wal'), Path(str(source) + '-shm')}:
        raise ValueError('NEURAL_EXPORT_CANNOT_REPLACE_SOURCE')
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    connection = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=2)
    connection.row_factory = sqlite3.Row
    temporary = None
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA cache_size=-2048')
        connection.execute('BEGIN')  # Read transaction includes committed WAL pages.
        row = connection.execute('SELECT id,revision,state,updated_at FROM state WHERE id=?', (STATE_ID,)).fetchone()
        if row is None:
            raise ValueError('NEURAL_EXPORT_STATE_MISSING')
        state = json.loads(row['state'])
        execution = state.get('secondaryExecution', {})
        if execution.get('version') != 'secondary-futures-1.0.0':
            raise ValueError('NEURAL_EXPORT_EXECUTION_DOMAIN')
        neural = state.get('secondaryNeural') or {}
        if neural and (neural.get('protocol', {}).get('mode') != 'PAPER' or
                       neural.get('protocol', {}).get('realTrading') is not False):
            raise ValueError('NEURAL_EXPORT_PAPER_ONLY')
        high = connection.execute('SELECT COALESCE(MAX(rowid),0) FROM events').fetchone()[0]
        if after > high:
            raise ValueError('NEURAL_EXPORT_CURSOR_AHEAD')
        captured_at = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
        manifest = {'version': VERSION, 'mode': 'PAPER', 'realTrading': False,
                    'source_id': source_id, 'state_id': STATE_ID, 'revision': row['revision'],
                    'state_updated_at': row['updated_at'], 'captured_at': captured_at,
                    'cursor_start': after, 'snapshot_high_watermark': high,
                    'neural_counts': neural.get('counts', {}),
                    'legacy_learning': state.get('learning', {}).get('groups', {}).get(
                        'FREQUENT_PAPER:secondary-futures-1.0.0', {}).get('exclusions', {}),
                    'consistent_source': 'SQLITE_READ_TRANSACTION_INCLUDING_WAL'}
        fd, temporary = tempfile.mkstemp(prefix='.neural-export-', dir=output.parent)
        os.chmod(temporary, 0o600)
        count, cursor, raw_bytes, complete = 0, after, 0, True
        with os.fdopen(fd, 'wb') as target:
            with gzip.GzipFile(fileobj=target, mode='wb', compresslevel=1, mtime=0) as stream:
                def write(value):
                    nonlocal raw_bytes
                    encoded = (json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n').encode()
                    raw_bytes += len(encoded)
                    if raw_bytes > MAX_EXPORT_BYTES:
                        raise ValueError('NEURAL_EXPORT_RESOURCE_LIMIT')
                    stream.write(encoded)
                write({'manifest': manifest})
                while cursor < high:
                    query = ('SELECT rowid,id,kind,length(CAST(payload AS BLOB)) AS size,'
                             f'CASE WHEN length(CAST(payload AS BLOB))<={MAX_EVENT_BYTES} THEN payload ELSE NULL END AS payload,created_at FROM events '
                             'WHERE rowid>? AND rowid<=? AND kind IN (' + ','.join('?' for _ in KINDS) +
                             ') ORDER BY rowid LIMIT 100')
                    page = connection.execute(query, (cursor, high, *KINDS))
                    read = 0
                    for event in page:
                        if count >= max_events:
                            complete = False
                            break
                        read += 1
                        if event['size'] > MAX_EVENT_BYTES:
                            raise ValueError('NEURAL_SOURCE_EVENT_RESOURCE_LIMIT')
                        payload = compact(json.loads(event['payload']), event['kind'])
                        cursor = event['rowid']
                        if payload is None:
                            continue
                        write({'rowid': cursor, 'id': event['id'], 'kind': event['kind'],
                               'created_at': event['created_at'], 'payload': payload})
                        count += 1
                    if not complete:
                        break
                    if read < 100:
                        cursor = high
                        break
                manifest.update(cursor_end=cursor, events=count, complete=complete)
                write({'checkpoint': {'cursor_end': cursor, 'complete': complete, 'events': count}})
            target.flush()
            os.fsync(target.fileno())
        connection.execute('COMMIT')
        os.replace(temporary, output)
        temporary = None
        return {**manifest, 'path': str(output), 'bytes': output.stat().st_size,
                'raw_bytes': raw_bytes, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}
    finally:
        connection.close()
        if temporary:
            Path(temporary).unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--after', type=int, default=0)
    parser.add_argument('--max-events', type=int, default=10000)
    parser.add_argument('--mode', choices=['PAPER'], default='PAPER')
    args = parser.parse_args()
    print(json.dumps(export_snapshot(args.database, args.output, after=args.after,
                                    max_events=args.max_events, mode=args.mode)))

if __name__ == '__main__':
    main()
