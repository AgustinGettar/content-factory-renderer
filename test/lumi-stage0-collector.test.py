"""Synthetic SQLite tests; never open the operational path or call AWS."""
import base64, contextlib, datetime as dt, importlib.util, io, json, sqlite3, tempfile, unittest, zlib
from unittest import mock
from pathlib import Path
SPEC=importlib.util.spec_from_file_location('collector',Path(__file__).resolve().parents[1]/'docs/trading/implementation/stage0/lumi_etapa0.py')
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)
NOW=dt.datetime(2026,11,13,12,tzinfo=dt.timezone.utc)
END=int(NOW.timestamp()*1000)

class Collector(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'synthetic.sqlite'
  self.db=sqlite3.connect(self.path)
  self.db.executescript('CREATE TABLE state(id TEXT PRIMARY KEY,revision INTEGER,fence INTEGER,lease_owner TEXT,lease_until TEXT,updated_at TEXT,state TEXT);CREATE TABLE events(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,created_at TEXT);CREATE INDEX events_kind_time ON events(kind,created_at);')
  self.state={'frequency':{'account':{'cash':'1000','net':'4.2','positions':{},'pendingOrders':{}}},'secondaryExecution':{'version':'secondary-futures-1.0.0','timeframe_execution':{'policy':{'entry_frames':[1,5,15,60,240]},'frames':{'15':{'last_status':'COMPLETE','counts':{'completed':100}}}},'market':{'quote':{'event_at':END-20000,'received_at':END-10,'bid':'90000','ask':'90001'}}}}
  self.save()
 def tearDown(self):self.db.close();self.temp.cleanup()
 def save(self):
  self.db.execute('INSERT OR REPLACE INTO state VALUES(?,?,?,?,?,?,?)',(m.STATE_ID,90,4,'private-owner','2026-11-13T12:00:30.000Z','2026-11-13T11:59:59.000Z',json.dumps(self.state)));self.db.commit()
 def event(self,kind,payload,eid='one',date='2026-11-13T11:00:00.000Z'):
  self.db.execute('INSERT INTO events VALUES(?,?,?,?)',(eid,kind,json.dumps(payload),date));self.db.commit()
 def read(self,**kwargs):return m.read_db(self.path,now=NOW,**kwargs)
 def test_consistent_read_only_does_not_change_database(self):
  before=self.path.read_bytes();out=self.read();self.assertTrue(out['consistent_read_transaction']);self.assertEqual(before,self.path.read_bytes());self.assertNotIn('private-owner',json.dumps(out))
 def test_recent_receipt_does_not_rejuvenate_quote(self):
  out=self.read();self.assertEqual(out['market']['freshness'],'STALE');self.assertEqual(out['market']['age_seconds'],20)
 def test_missing_fields_are_unknown_not_zero(self):
  self.state={'secondaryExecution':{}};self.save();out=self.read();self.assertIsNone(out['account']['equity']);self.assertIsNone(out['frames']['1']['enabled']);self.assertEqual(out['market']['freshness'],'UNKNOWN')
 def test_main_ledger_excluded(self):
  self.event('CLOSED',{'ledger':'MAIN','id':'private-main','timeframe':15,'pnl':'900'});out=self.read();self.assertEqual(out['window_closed_net']['positions'],0);self.assertEqual(out['closures_15m_1h'],[]);self.assertNotIn('private-main',json.dumps(out))
 def test_completed_net_not_double_counts_partial_and_accepts_signed_funding(self):
  common={'ledger':'FREQUENT_PAPER','id':'position','timeframe':15,'plan':{'timeframe':60}}
  self.event('PARTIAL_CLOSE',{**common,'pnl':'2.2','at':END-1000},'part')
  self.event('CLOSED',{**common,'pnl':'4.2','fees':'-0.3','funding':'-0.5','entered_at':END-600000,'at':END-100,'result_final':True},'final')
  self.event('FUNDING_RECONCILED',{**common,'net_adjustment':'0.1','net_after':'4.3'},'funding')
  out=self.read();row=out['closures_15m_1h'][0]
  self.assertEqual(out['window_closed_net']['value'],'4.2');self.assertEqual(row['costs_signed'],'-0.3');self.assertEqual(row['entry_timeframe'],60);self.assertEqual(row['event_timeframe'],15);self.assertEqual(len(row['partials_in_window']),1);self.assertEqual(row['duration_seconds'],599.9)
 def test_truncated_window_is_not_zero_cases(self):
  for i in range(3):self.event('CLOSED',{'ledger':'MAIN','pnl':'1'},str(i))
  out=self.read(max_rows=2);self.assertFalse(out['coverage']['CLOSED']['query_complete']);self.assertIsNone(out['window_closed_net']['value']);self.assertEqual(out['frames']['15']['archived_events']['CLOSED']['status'],'INCOMPLETE_WINDOW')
 def test_no_index_refuses_event_scan(self):
  self.db.execute('DROP INDEX events_kind_time');self.db.commit();out=self.read();self.assertFalse(out['consistent_read_transaction']);self.assertEqual(out['error']['code'],'REQUIRED_EVENTS_KIND_TIME_INDEX_MISSING_NO_SCAN_ATTEMPTED')
 def test_archive_does_not_claim_attempt_completions(self):
  self.event('SECONDARY_PATTERN_EVALUATION',{'ledger':'FREQUENT_PAPER','timeframe':15,'cutoff':END-60000,'pattern':'TEST','reason':'WAIT','evaluation_status':'COMPLETE'})
  out=self.read();row=out['frames']['15'];self.assertEqual(row['checkpoint']['counts']['completed'],100);self.assertIsNone(row['corrected_metrics']['counts']);self.assertEqual(row['archived_events']['SECONDARY_PATTERN_EVALUATION']['observed_rows'],1)
 def test_oversize_payload_is_explicit_incomplete(self):
  self.event('CLOSED',{'ledger':'FREQUENT_PAPER','timeframe':15,'padding':'x'*m.MAX_EVENT_BYTES})
  out=self.read();self.assertEqual(out['coverage']['CLOSED']['oversize'],1);self.assertIsNone(out['window_closed_net']['value'])
 def test_real_flag_conflict_refuses_certification(self):
  self.event('CLOSED',{'ledger':'FREQUENT_PAPER','realTrading':True});out=self.read();self.assertEqual(out['error']['code'],'SECONDARY_REAL_TRADING_FLAG_CONFLICT');self.assertFalse(out['consistent_read_transaction'])
 def test_no_unknown_nested_fields_exported(self):
  self.state['frequency']['account']['positions']={'x':{'plan':{'id':'x','timeframe':15},'realized':{'net':'1','secret':'do-not-export'}}};self.save();self.assertNotIn('do-not-export',json.dumps(self.read()))
 def test_deadline_preserves_unknown_instead_of_fabricating_zero(self):

  for i in range(150):self.event('CLOSED',{'ledger':'FREQUENT_PAPER','timeframe':15,'pnl':'1'},str(i))
  out=self.read(deadline_seconds=-1);self.assertFalse(out['consistent_read_transaction']);self.assertIn('error',out)
 def test_wrong_index_definition_refuses_scan(self):
  self.db.executescript('DROP INDEX events_kind_time;CREATE INDEX events_kind_time ON events(created_at);');out=self.read();self.assertEqual(out['error']['code'],'EVENTS_INDEX_COLUMNS_UNEXPECTED_NO_SCAN_ATTEMPTED')
 def test_outbox_counts_do_not_export_payload_or_primary(self):
  self.db.executescript('CREATE TABLE outbox(kind TEXT,status TEXT,created_at TEXT,payload TEXT);CREATE INDEX outbox_created ON outbox(created_at);');self.db.executemany('INSERT INTO outbox VALUES(?,?,?,?)',[('SECONDARY_OPEN','DELIVERED','2026-11-13T11:00:00.000Z','private-recipient'),('SIGNAL','DELIVERED','2026-11-13T11:00:00.000Z','primary-private')]);self.db.commit();out=self.read();self.assertEqual(out['secondary_notifications']['counts'],[{'kind':'SECONDARY_OPEN','status':'DELIVERED','count':1}]);self.assertNotIn('private-recipient',json.dumps(out));self.assertNotIn('primary-private',json.dumps(out))
 def test_dashboard_metadata_allowlist_in_same_read_transaction(self):
  self.db.execute('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)')
  saved={'at':END-8100000,'detail_at':END-8102000,'error':'DASHBOARD_PUBLISH_FAILED','detail_error':None,'backup_error':'BACKUP_STORAGE_SPACE_LOW','live_bytes':1028000,'token':'must-not-export','private_snapshot':{'secret':'hidden'}}
  self.db.execute('INSERT INTO metadata VALUES(?,?)',('dashboard',json.dumps(saved)));self.db.commit();before=self.path.read_bytes();out=self.read();self.assertTrue(out['consistent_read_transaction']);self.assertEqual(before,self.path.read_bytes());dashboard=out['dashboard_publisher'];self.assertEqual(dashboard['status'],'AVAILABLE');self.assertEqual(dashboard['fields']['live_bytes'],1028000);self.assertEqual(dashboard['fields']['error'],'DASHBOARD_PUBLISH_FAILED');self.assertEqual(dashboard['fields']['at'],END-8100000);self.assertNotIn('must-not-export',json.dumps(out));self.assertNotIn('hidden',json.dumps(out));self.assertEqual(dashboard['live_bytes_scope'],'LAST_SUCCESSFUL_LIVE_PUBLICATION_NOT_REJECTED_BODY')
 def test_missing_dashboard_metadata_is_unknown_not_zero(self):
  out=self.read();self.assertEqual(out['dashboard_publisher']['status'],'UNAVAILABLE');self.assertIsNone(out['dashboard_publisher']['fields']['live_bytes']);self.assertIsNone(out['dashboard_publisher']['fields']['at'])
 def test_invalid_dashboard_metadata_remains_visible_without_leaking_error(self):
  self.db.execute('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)');self.db.execute('INSERT INTO metadata VALUES(?,?)',('dashboard',json.dumps({'at':True,'live_bytes':-1,'error':'secret token=private','detail_at':END-1000})));self.db.commit();out=self.read();d=out['dashboard_publisher'];self.assertEqual(d['status'],'AVAILABLE_WITH_INVALID_FIELDS');self.assertEqual(set(d['invalid_fields']),{'at','live_bytes','error'});self.assertIsNone(d['fields']['live_bytes']);self.assertIsNone(d['fields']['error']);self.assertEqual(d['fields']['detail_at'],END-1000);self.assertNotIn('private',json.dumps(d));self.assertTrue(out['consistent_read_transaction'])
 def test_oversized_dashboard_metadata_is_not_loaded(self):
  self.db.execute('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)');self.db.execute('INSERT INTO metadata VALUES(?,?)',('dashboard','x'*16385));self.db.commit();out=self.read();self.assertEqual(out['dashboard_publisher']['status'],'SIZE_LIMIT');self.assertIsNone(out['dashboard_publisher']['fields']['at']);self.assertTrue(out['consistent_read_transaction'])
 def test_identical_closure_rows_count_position_and_net_once(self):
  e={'ledger':'FREQUENT_PAPER','id':'pos-repeat','timeframe':15,'pnl':'4.2','at':END-100,'result_final':True}
  self.event('CLOSED',e,'event-original');self.event('CLOSED',dict(reversed(list(e.items()))),'event-repeated')
  out=self.read();summary=out['window_closed_net'];self.assertEqual(summary['raw_event_rows'],2);self.assertEqual(summary['positions'],1);self.assertEqual(summary['exact_duplicate_event_rows'],1);self.assertEqual(summary['value'],'4.2');self.assertEqual(len(out['closures_15m_1h']),1)
 def test_conflicting_closure_receipts_do_not_select_favorable_result(self):
  e={'ledger':'FREQUENT_PAPER','id':'pos-conflict','timeframe':15,'pnl':'4.2'}
  self.event('CLOSED',e,'first');self.event('CLOSED',{**e,'pnl':'-6.1'},'second');self.event('CLOSED',{'ledger':'FREQUENT_PAPER','id':'other-position','timeframe':60,'pnl':'1'},'third')
  out=self.read();s=out['window_closed_net'];self.assertEqual(s['positions'],2);self.assertIsNone(s['value']);self.assertEqual(s['known_subset_value'],'1');self.assertEqual(s['unknown_net_records'],1);self.assertEqual(len(s['conflicting_position_ids']),1);ambiguous=[v for v in out['closures_15m_1h'] if v['status']=='CONFLICTING_CLOSED_RECEIPTS'];self.assertEqual(len(ambiguous),1);self.assertIsNone(ambiguous[0]['net_complete_position']);self.assertIsNone(ambiguous[0]['reason'])
 def test_same_net_with_conflicting_cause_is_not_silently_collapsed(self):
  e={'ledger':'FREQUENT_PAPER','id':'pos-reason','timeframe':60,'pnl':'1','reason':'STOP'}
  self.event('CLOSED',e,'first');self.event('CLOSED',{**e,'reason':'NET_TARGET'},'second');s=self.read()['window_closed_net'];self.assertIsNone(s['value']);self.assertEqual(len(s['conflicting_position_ids']),1)
 def test_unidentified_closure_does_not_fabricate_position_identity(self):
  self.event('CLOSED',{'ledger':'FREQUENT_PAPER','timeframe':15,'pnl':'5'});s=self.read()['window_closed_net'];self.assertIsNone(s['positions']);self.assertIsNone(s['value']);self.assertEqual(s['unidentified_closed_rows'],1);self.assertEqual(s['raw_event_rows'],1)
 def test_funding_after_duplicate_close_is_separate_from_at_close_total(self):
  e={'ledger':'FREQUENT_PAPER','id':'funded-pos','timeframe':60,'pnl':'4.2','result_final':False}
  self.event('CLOSED',e,'close');self.event('CLOSED',e,'duplicate');self.event('FUNDING_RECONCILED',{'ledger':'FREQUENT_PAPER','id':'funded-pos','timeframe':60,'net_adjustment':'0.3','net_after':'4.5','funding_complete':True},'funding')
  out=self.read();s=out['window_closed_net'];self.assertEqual(s['value'],'4.2');self.assertEqual(s['positions'],1);self.assertEqual(s['provisional_or_unknown_finality_positions'],1);self.assertIn('not account net delta or historical total',s['scope']);self.assertEqual(out['closures_15m_1h'][0]['funding_corrections_in_window'][0]['net_after'],'4.5')
 def test_window_excludes_old_history_explicitly(self):
  self.event('CLOSED',{'ledger':'FREQUENT_PAPER','timeframe':60,'pnl':'9'},date='2026-11-11T11:00:00.000Z');out=self.read();self.assertEqual(out['frames']['60']['archived_events']['CLOSED']['status'],'ZERO_OBSERVED_IN_WINDOW');self.assertEqual(out['window']['requested_hours'],24)


 def journal_row(self,kind='lumi_trading_health',pid='42',invocation='synthetic-invocation'):
  return json.dumps({'_PID':pid,'_SYSTEMD_INVOCATION_ID':invocation,'__REALTIME_TIMESTAMP':'1000000','MESSAGE':json.dumps({'event':kind,'mode':'PAPER','revision':90,'cpu_fraction':0.2,'rss_bytes':100000,'worker_identity':{'pid':42,'lease_owner_sha256':'a'*64,'fence':4,'release':{'manifest_sha256':'b'*64,'declared_source_commit':'c'*40,'loaded_source_attested':False}},'secret':'SYNTHETIC_PRIVATE_LOG_FIELD'})})
 def run_remote_with_journal(self,runner,*,final_response=None):
  original=m.collect_runtime_diagnostics
  def identify(out):
   out.update(service={'MainPID':'42','InvocationID':'synthetic-invocation'},process={'pid':42},disk_commit='f'*40)
   return 42,'synthetic-invocation'
  def collect(out,pid,invocation):
   return original(out,pid,invocation,db_path=self.path,journal_reader=lambda p,i,k:m.journal_query(p,i,k,run=runner))
  stream=io.StringIO()
  response='MainPID=42\nInvocationID=synthetic-invocation' if final_response is None else final_response
  with mock.patch.object(m,'collect_runtime_identity',side_effect=identify),mock.patch.object(m,'collect_runtime_diagnostics',side_effect=collect),mock.patch.object(m,'command',return_value=response) as last,contextlib.redirect_stdout(stream):
   m.remote()
  last.assert_called_once_with(['systemctl','show',m.SERVICE,'--property=MainPID,InvocationID'])
  prefix,digest,blob=stream.getvalue().strip().split(' ',2);raw=zlib.decompress(base64.b64decode(blob));self.assertEqual(prefix,m.PREFIX);self.assertEqual(m.sha(raw),digest)
  return json.loads(raw)
 def test_remote_journal_exit_one_continues_storage_sql_and_second_query(self):
  calls=[]
  def run(args,**kwargs):
   calls.append(args);kind=next(v.split('=',1)[1] for v in args if v.startswith('--grep='))
   return m.subprocess.CompletedProcess(args,1,'','') if kind=='lumi_trading_started' else m.subprocess.CompletedProcess(args,0,self.journal_row(),'')
  out=self.run_remote_with_journal(run)
  self.assertEqual(out['journal_queries'][0]['status'],'NONZERO_EXIT');self.assertEqual(out['journal_queries'][0]['return_code'],1);self.assertEqual(out['journal_queries'][0]['diagnostic']['codes'],[])
  self.assertEqual(out['journal_queries'][1]['status'],'READ');self.assertEqual(len(out['journal']),1);self.assertEqual(out['journal'][0]['worker_identity']['release']['declared_source_commit'],'c'*40)
  self.assertGreater(out['storage']['available_bytes'],0);self.assertTrue(out['paper']['consistent_read_transaction']);self.assertEqual(out['paper']['checkpoint']['revision'],90);self.assertTrue(out['same_process_after_read']);self.assertEqual(m.receipt_status(out),'COLLECTED_WITH_READ_GAPS')
  self.assertEqual(len(calls),2);self.assertTrue(all('_PID=42' in a and '_SYSTEMD_INVOCATION_ID=synthetic-invocation' in a for a in calls));self.assertFalse(any(any(v.startswith('--since') for v in a) for a in calls));self.assertNotIn('SYNTHETIC_PRIVATE_LOG_FIELD',json.dumps(out))
 def test_remote_journal_timeout_preserves_other_reads_and_records_safe_diagnostic(self):
  def run(args,**kwargs):raise m.subprocess.TimeoutExpired(args,8,output='PRIVATE_OUTPUT',stderr=b'PRIVATE_STDERR')
  out=self.run_remote_with_journal(run);self.assertTrue(out['paper']['consistent_read_transaction']);self.assertEqual([r['status'] for r in out['journal_queries']],['TIMEOUT','TIMEOUT']);self.assertTrue(all(r['return_code'] is None for r in out['journal_queries']));self.assertNotIn('PRIVATE_STDERR',json.dumps(out));self.assertNotIn('PRIVATE_OUTPUT',json.dumps(out));self.assertEqual(m.receipt_status(out),'COLLECTED_WITH_READ_GAPS')
 def test_remote_journal_os_error_does_not_export_path_or_abort_sql(self):
  def run(args,**kwargs):raise PermissionError(13,'SYNTHETIC_SECRET','/private/path')
  out=self.run_remote_with_journal(run);self.assertEqual(out['journal_queries'][0]['os_code'],'EACCES');self.assertEqual(out['journal_queries'][0]['os_errno'],13);self.assertTrue(out['paper']['consistent_read_transaction']);self.assertNotIn('SYNTHETIC_SECRET',json.dumps(out));self.assertNotIn('/private/path',json.dumps(out))
 def test_remote_invalid_journal_rows_are_explicit_and_do_not_erase_valid_rows(self):
  def run(args,**kwargs):
   kind=next(v.split('=',1)[1] for v in args if v.startswith('--grep='))
   text='not-json\n[]\n'+json.dumps({'MESSAGE':'not-json'})+'\n'+self.journal_row(kind)
   return m.subprocess.CompletedProcess(args,0,text,'')
  out=self.run_remote_with_journal(run);self.assertTrue(out['paper']['consistent_read_transaction']);self.assertEqual(len(out['journal']),2);self.assertTrue(all(r['invalid_rows']==3 and r['status']=='INVALID_OR_PARTIAL_ROWS' for r in out['journal_queries']));self.assertEqual(m.receipt_status(out),'COLLECTED_WITH_READ_GAPS')
 def test_remote_journal_execution_mismatch_is_not_accepted(self):
  def run(args,**kwargs):
   kind=next(v.split('=',1)[1] for v in args if v.startswith('--grep='))
   return m.subprocess.CompletedProcess(args,0,self.journal_row(kind,pid='43'),'')
  out=self.run_remote_with_journal(run);self.assertEqual(out['journal'],[]);self.assertTrue(out['paper']['consistent_read_transaction']);self.assertEqual(out['journal_queries'][0]['invalid_rows'],1)
 def test_remote_storage_error_does_not_prevent_sql_read(self):
  run=lambda args,**kwargs:m.subprocess.CompletedProcess(args,1,'','')
  with mock.patch.object(m.os,'statvfs',side_effect=OSError(5,'SYNTHETIC_PRIVATE_DEVICE')):out=self.run_remote_with_journal(run)
  self.assertEqual(out['storage']['status'],'READ_FAILED');self.assertTrue(out['paper']['consistent_read_transaction']);self.assertTrue(out['same_process_after_read']);self.assertEqual(m.receipt_status(out),'COLLECTED_WITH_READ_GAPS');self.assertNotIn('SYNTHETIC_PRIVATE_DEVICE',json.dumps(out))
 def test_remote_sql_error_still_checks_final_pid_and_is_not_certified(self):
  run=lambda args,**kwargs:m.subprocess.CompletedProcess(args,1,'','')
  with mock.patch.object(m,'read_db',side_effect=sqlite3.OperationalError('SYNTHETIC_SECRET_SQL')):out=self.run_remote_with_journal(run)
  self.assertFalse(out['paper']['consistent_read_transaction']);self.assertTrue(out['same_process_after_read']);self.assertEqual(m.receipt_status(out),'REMOTE_READ_INCOMPLETE');self.assertNotIn('SYNTHETIC_SECRET_SQL',json.dumps(out))
 def test_remote_changed_final_pid_prevents_successful_receipt(self):
  run=lambda args,**kwargs:m.subprocess.CompletedProcess(args,1,'','')
  out=self.run_remote_with_journal(run,final_response='MainPID=43\nInvocationID=synthetic-invocation');self.assertFalse(out['same_process_after_read']);self.assertTrue(out['paper']['consistent_read_transaction']);self.assertEqual(m.receipt_status(out),'REMOTE_READ_INCOMPLETE')
 def test_journal_diagnostic_is_bounded_and_never_exports_raw_stderr(self):
  raw='Permission denied token=SYNTHETIC_SECRET '+('x'*10000);r=m.journal_diagnostic(raw)
  self.assertEqual(r['stderr_bytes'],len(raw));self.assertEqual(r['stderr_prefix_bytes'],4096);self.assertEqual(r['codes'],['PERMISSION_DENIED']);self.assertFalse(r['raw_text_exported']);self.assertNotIn('SYNTHETIC_SECRET',json.dumps(r));self.assertLess(len(json.dumps(r)),400)
 def test_journal_oversized_output_is_an_explicit_optional_gap(self):
  run=lambda args,**kwargs:m.subprocess.CompletedProcess(args,0,'x'*131073,'')
  out=self.run_remote_with_journal(run);self.assertTrue(out['paper']['consistent_read_transaction']);self.assertEqual(out['journal_queries'][0]['status'],'OUTPUT_SIZE_LIMIT');self.assertEqual(out['journal'],[])

if __name__=='__main__':unittest.main(verbosity=2)
