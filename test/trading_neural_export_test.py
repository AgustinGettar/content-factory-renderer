"""Isolated SQLite fixtures only; never opens the worker database."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    'neural_export', Path(__file__).parents[1] / 'scripts/trading-neural-export.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class NeuralExportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lumi-neural-export-isolated-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.database = self.directory / 'isolated.sqlite'
        self.output = self.directory / 'private' / 'events.jsonl.gz'
        self.original_connect = sqlite3.connect
        self.writer = self.original_connect(self.database)
        self.addCleanup(self.writer.close)
        self.writer.execute('PRAGMA journal_mode=WAL')
        self.writer.execute('PRAGMA wal_autocheckpoint=0')
        self.writer.execute('CREATE TABLE state (id TEXT PRIMARY KEY, revision INTEGER, state TEXT, updated_at TEXT)')
        self.writer.execute('CREATE TABLE events (id TEXT PRIMARY KEY, kind TEXT, payload TEXT, created_at TEXT)')
        self.state = {'secondaryExecution': {'version': 'secondary-futures-1.0.0'},
                      'secondaryNeural': {'protocol': {'mode': 'PAPER', 'realTrading': False},
                                          'counts': {'captures': 3, 'usable': 0}},
                      'learning': {'groups': {'FREQUENT_PAPER:secondary-futures-1.0.0':
                                             {'exclusions': {'NO_PRE_ENTRY_FEATURES': 8}}}},
                      'private': {'token': 'NEVER_EXPORT_STATE_SECRET'},
                      'primary': {'balance': 'NEVER_EXPORT_PRIMARY_BALANCE'}}
        self.save_state()

    def save_state(self, revision=7):
        self.writer.execute('INSERT OR REPLACE INTO state VALUES (?,?,?,?)',
                            (module.STATE_ID, revision, json.dumps(self.state), '2026-11-02T08:00:00Z'))
        self.writer.commit()

    def add(self, number, kind='FILLED', **overrides):
        value = {'type': kind, 'id': 'isolated-operation-' + str(number),
                 'at': 1793606400000 + number, 'version': 'secondary-futures-1.0.0',
                 'ledger': 'FREQUENT_PAPER', 'realTrading': False,
                 'qty': '0.001', 'price': '100000', 'fee': '0.05'}
        value.update(overrides)
        self.writer.execute('INSERT INTO events VALUES (?,?,?,?)',
                            ('isolated-event-' + str(number), kind,
                             json.dumps(value, ensure_ascii=False), '2026-11-02T08:00:00Z'))
        return value

    def export(self, **kwargs):
        self.writer.commit()
        return module.export_snapshot(self.database, self.output, source_id='ISOLATED_TEST', **kwargs)

    def records(self):
        with gzip.open(self.output, 'rt') as source:
            return [json.loads(line) for line in source]

    def test_reads_committed_wal_without_checkpoint_or_copy_and_is_private(self):
        self.add(1)
        self.writer.commit()
        self.assertGreater(Path(str(self.database) + '-wal').stat().st_size, 0)
        result = self.export()
        rows = self.records()
        self.assertEqual(rows[0]['manifest']['revision'], 7)
        self.assertEqual(rows[0]['manifest']['consistent_source'], 'SQLITE_READ_TRANSACTION_INCLUDING_WAL')
        self.assertEqual(rows[1]['payload']['id'], 'isolated-operation-1')
        self.assertEqual(rows[-1]['checkpoint'], {'cursor_end': 1, 'complete': True, 'events': 1})
        self.assertEqual(result['sha256'], hashlib.sha256(self.output.read_bytes()).hexdigest())
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.output.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(result['raw_bytes'], sum(len((json.dumps(row, separators=(',', ':')) + '\n').encode()) for row in rows))

    def test_state_events_and_high_watermark_share_one_snapshot_during_concurrent_write(self):
        self.add(1)
        self.writer.commit()
        owner, queries = self, []

        class Reader(sqlite3.Connection):
            def execute(self, sql, *args, **kwargs):
                queries.append(sql)
                if sql.startswith('SELECT COALESCE(MAX(rowid)'):
                    owner.add(2)
                    owner.save_state(revision=8)
                return super().execute(sql, *args, **kwargs)

        def connect(*args, **kwargs):
            return self.original_connect(*args, factory=Reader, **kwargs)

        with patch.object(module.sqlite3, 'connect', side_effect=connect):
            result = module.export_snapshot(self.database, self.output)
        rows = self.records()
        self.assertEqual(result['revision'], 7)
        self.assertEqual(result['snapshot_high_watermark'], 1)
        self.assertEqual([r['rowid'] for r in rows[1:-1]], [1])
        self.assertEqual(self.writer.execute('SELECT revision FROM state').fetchone()[0], 8)
        self.assertEqual(self.writer.execute('SELECT COUNT(*) FROM events').fetchone()[0], 2)
        self.assertTrue(all(sql.startswith(('SELECT ', 'PRAGMA query_only=', 'PRAGMA cache_size=', 'BEGIN', 'COMMIT')) for sql in queries))

    def test_paginates_and_resumes_at_exact_source_cursor(self):
        for number in range(1, 208):
            self.add(number)
        first = self.export(max_events=102)
        self.assertEqual(first['events'], 102)
        self.assertFalse(first['complete'])
        self.assertEqual(first['cursor_end'], 102)
        self.assertEqual([row['rowid'] for row in self.records()[1:-1]], list(range(1, 103)))
        last = self.export(after=first['cursor_end'])
        self.assertTrue(last['complete'])
        self.assertEqual(last['events'], 105)
        self.assertEqual(last['cursor_end'], 207)
        self.assertEqual([row['rowid'] for row in self.records()[1:-1]], list(range(103, 208)))
        empty = self.export(after=207)
        self.assertEqual(empty['events'], 0)
        self.assertEqual(len(self.records()), 2)

    def test_only_secondary_evidence_leaves_snapshot_and_plan_is_compact(self):
        self.add(1, ledger='PRIMARY_PAPER', token='NEVER_EXPORT_PRIMARY_EVENT')
        self.add(2, version='spot-old', token='NEVER_EXPORT_OLD_ENGINE')
        self.add(3, kind='HEARTBEAT', token='NEVER_EXPORT_OTHER_EVENT')
        self.add(4, realTrading=True, token='NEVER_EXPORT_REAL_EVENT')
        self.add(5, token='NEVER_EXPORT_EVENT_SECRET', plan={
            'id': 'isolated-operation-5', 'version': 'secondary-futures-1.0.0',
            'sizing': {'qty': '0.001'}, 'execution_contract': {'version': 'execution-1'},
            'study': {'secret': 'NEVER_EXPORT_STUDY'}, 'evidence': ['NEVER_EXPORT_RAW_HISTORY']})
        self.add(6, kind='NEURAL_ENTRY_DECISION', decision={'signal_id': 'isolated-signal',
                                                         'model_id': None, 'mode': 'COLLECTING'})
        self.add(7, ledger='PRIMARY_PAPER')
        result = self.export()
        rows = self.records()
        text = json.dumps(rows)
        self.assertNotIn('NEVER_EXPORT', text)
        self.assertEqual([row['rowid'] for row in rows[1:-1]], [5, 6])
        self.assertEqual(rows[1]['payload']['plan']['sizing'], {'qty': '0.001'})
        self.assertNotIn('study', rows[1]['payload']['plan'])
        self.assertEqual(rows[2]['payload']['decision']['mode'], 'COLLECTING')
        self.assertEqual(result['cursor_end'], 7)
        self.assertEqual(rows[0]['manifest']['legacy_learning'], {'NO_PRE_ENTRY_FEATURES': 8})

    def test_rejects_real_mode_wrong_contract_and_missing_state(self):
        with self.assertRaisesRegex(ValueError, 'PAPER_ONLY'):
            self.export(mode='REAL')
        self.state['secondaryNeural']['protocol']['realTrading'] = True
        self.save_state()
        with self.assertRaisesRegex(ValueError, 'PAPER_ONLY'):
            self.export()
        self.state['secondaryExecution']['version'] = 'SPOT'
        self.save_state()
        with self.assertRaisesRegex(ValueError, 'EXECUTION_DOMAIN'):
            self.export()
        self.writer.execute('DELETE FROM state')
        self.writer.commit()
        with self.assertRaisesRegex(ValueError, 'STATE_MISSING'):
            self.export()
        self.assertFalse(self.output.exists())

    def test_export_cannot_replace_sqlite_its_wal_or_shm(self):
        self.add(1)
        self.writer.commit()
        for path in [self.database, Path(str(self.database) + '-wal'), Path(str(self.database) + '-shm')]:
            before = path.read_bytes()
            with self.assertRaisesRegex(ValueError, 'CANNOT_REPLACE_SOURCE'):
                module.export_snapshot(self.database, path)
            self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.writer.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_bad_bounds_and_cursor_ahead_are_visible(self):
        for kwargs in [{'after': -1}, {'max_events': 0}, {'max_events': 10001}]:
            with self.assertRaisesRegex(ValueError, 'BOUNDS'):
                self.export(**kwargs)
        with self.assertRaisesRegex(ValueError, 'CURSOR_AHEAD'):
            self.export(after=1)
        self.assertFalse(self.output.exists())

    def test_limits_remove_partial_files_and_preserve_previous_valid_export(self):
        self.add(1)
        self.export()
        previous = self.output.read_bytes()
        with patch.object(module, 'MAX_EXPORT_BYTES', 300):
            with self.assertRaisesRegex(ValueError, 'RESOURCE_LIMIT'):
                self.export()
        self.assertEqual(self.output.read_bytes(), previous)
        self.assertEqual(list(self.output.parent.glob('.neural-export-*')), [])
        self.add(2, padding='x' * (module.MAX_EVENT_BYTES + 1))
        with self.assertRaisesRegex(ValueError, 'SOURCE_EVENT_RESOURCE_LIMIT'):
            self.export()
        self.assertEqual(self.output.read_bytes(), previous)

    def test_event_budget_counts_utf8_bytes_not_sqlite_text_characters(self):
        self.add(1, padding='á' * 300)
        with patch.object(module, 'MAX_EVENT_BYTES', 700):
            with self.assertRaisesRegex(ValueError, 'SOURCE_EVENT_RESOURCE_LIMIT'):
                self.export()
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
