#!/usr/bin/env python3
"""Private read-only stage-0 receipt. CloudShell: python3 lumi_etapa0.py

Only Python stdlib plus the existing AWS CLI. No worker import, config changes,
backup, environment-file read, Telegram, scheduler or economic write. The remote
SQL uses a single read transaction, indexed bounded queries and a deadline.
"""
import base64, collections, datetime as dt, decimal, errno, hashlib, json, os, re
from pathlib import Path
import shlex, shutil, sqlite3, stat, subprocess, sys, time, zlib
try:import resource
except ImportError:resource=None

VERSION = 'lumi-stage0-readonly-1.0.3'
REGION = 'eu-north-1'
INSTANCE = 'i-0ae2ad0bb886f3d7f'
ACCOUNT = '146766539818'
SERVICE = 'lumi-trading.service'
DB = '/var/lib/lumi-trading/trading.sqlite'
STATE_ID = 'KRAKEN_BTCUSD_PAPER'
FRAMES = (1, 5, 15, 60, 240)
KINDS = ('SECONDARY_PATTERN_EVALUATION', 'SECONDARY_FRAME_EVALUATIONS_MISSED',
 'SECONDARY_FRAME_EVALUATION_RECOVERED', 'SECONDARY_ENTRY_REJECTED', 'SELECTED',
 'FILLED', 'PARTIAL_FILL', 'PARTIAL_CLOSE', 'CLOSED', 'NOT_FILLED',
 'ORDER_REMAINDER_CANCELLED', 'FUNDING_RECONCILED', 'SECONDARY_DATA_GAP',
 'SECONDARY_DATA_RECOVERED')
MAX_ROWS = 3000
MAX_EVENT_BYTES = 196608
MAX_STATE_BYTES = 8000000
MAX_TOTAL_BYTES = 24000000
PREFIX = 'LUMI_STAGE0_V1'


def sha(value): return hashlib.sha256(value).hexdigest()
def stamp(value): return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
def utc(): return dt.datetime.now(dt.timezone.utc)
def anon(value): return None if value is None else 'op-' + sha(str(value).encode())[:16]
def obj(value): return value if isinstance(value, dict) else {}
def seq(value): return list(value.values()) if isinstance(value, dict) else value if isinstance(value, list) else []
def pick(value, fields): return {key: obj(value).get(key) for key in fields}
def decimal_string(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)): return None
    try:
        number = decimal.Decimal(str(value))
        return str(number) if number.is_finite() else None
    except decimal.InvalidOperation: return None

def number(value):
    text = decimal_string(value)
    return decimal.Decimal(text) if text is not None else None

def elapsed(end, start):
    if isinstance(end, (float, int)) and isinstance(start, (float, int)):
        return (end-start)/1000 if end >= start else None
    return None

def operation_key(event):
    direct=event.get('id');planned=obj(event.get('plan')).get('id')
    if direct is not None and planned is not None and direct!=planned:return None
    value=direct if direct is not None else planned
    return value if isinstance(value,str) and 0<len(value)<=256 else None


def timeframe(event):
    value = obj(event.get('plan')).get('timeframe', event.get('timeframe'))
    return int(value) if str(value) in [str(x) for x in FRAMES] else None


def dashboard_status(db, *, capacity=False):
    """Allowlisted publisher metadata in the caller's same read transaction."""
    fields=('at','error','detail_at','detail_error','live_bytes','backup_error')
    if capacity:fields+=('backup_at','local_backup_at','local_backup_slot','next_backup_attempt_at','site_backup_retry_at')
    out={'status':'UNAVAILABLE','fields':dict.fromkeys(fields),
        'timestamp_scope':'LAST_SUCCESSFUL_PUBLISHER_ACKS_NOT_LAST_ATTEMPT',
        'live_bytes_scope':'LAST_SUCCESSFUL_LIVE_PUBLICATION_NOT_REJECTED_BODY'}
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").fetchone():return out
    row=db.execute("SELECT length(value),CASE WHEN length(value)<=16384 THEN value END FROM metadata WHERE key='dashboard'").fetchone()
    if row is None:return out
    if row[1] is None:out['status']='SIZE_LIMIT';return out
    try:stored=json.loads(row[1])
    except (ValueError,TypeError):out['status']='INVALID_JSON';return out
    if not isinstance(stored,dict):out['status']='INVALID_SHAPE';return out
    invalid=[]
    for key in fields:
        value=stored.get(key)
        if value is None:continue
        if key=='local_backup_slot':
            if isinstance(value,int) and not isinstance(value,bool) and value in (0,1,2):out['fields'][key]=value
            else:invalid.append(key)
        elif key in ('at','detail_at','live_bytes','backup_at','local_backup_at','next_backup_attempt_at','site_backup_retry_at'):
            if isinstance(value,int) and not isinstance(value,bool) and 0<=value<=9007199254740991:out['fields'][key]=value
            else:invalid.append(key)
        elif isinstance(value,str) and re.fullmatch(r'[A-Z_]{1,128}',value):out['fields'][key]=value
        else:invalid.append(key)
    out['status']='AVAILABLE_WITH_INVALID_FIELDS' if invalid else 'AVAILABLE'
    out['invalid_fields']=invalid
    return out


def read_db(path=DB, *, now=None, hours=24, max_rows=MAX_ROWS, deadline_seconds=15):
    """Returns only allowlisted secondary fields; never imports the economic writer."""
    now = now or utc()
    start, end = stamp(now-dt.timedelta(hours=hours)), stamp(now)
    result = {'window': {'start_inclusive': start, 'end_exclusive': end,
        'basis': 'EVENT_PERSISTENCE_CREATED_AT', 'requested_hours': hours},
        'consistent_read_transaction': False, 'source': 'SQLITE_READ_ONLY',
        'coverage': {}, 'frames': {}, 'limitations': [
        'Archived QUANT evaluations are sampled by changes/candidates/hour: event rows are not every attempt.',
        'Checkpoint counters are cumulative since their own activation, not the requested event window.',
        'Missing fields are null; recent records and MFE/MAE do not certify complete market paths.',
        'Snapshot consistency is not a backup or a restore test.']}
    db = sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro', uri=True, timeout=1)
    deadline = time.monotonic()+deadline_seconds
    total_bytes = 0
    try:
        db.execute('PRAGMA query_only=ON'); db.execute('PRAGMA busy_timeout=1000')
        db.execute('PRAGMA cache_size=-1024')
        db.set_progress_handler(lambda: int(time.monotonic()>deadline), 1000)
        db.execute('BEGIN')
        row = db.execute('SELECT revision,fence,lease_owner,lease_until,updated_at,length(state),CASE WHEN length(state)<=? THEN state END FROM state WHERE id=?', (MAX_STATE_BYTES, STATE_ID)).fetchone()
        if not row: raise RuntimeError('PAPER_CHECKPOINT_MISSING')
        if row[6] is None: raise RuntimeError('CHECKPOINT_SIZE_LIMIT')
        root = json.loads(row[6]); x = obj(root.get('secondaryExecution'))
        account = obj(obj(root.get('frequency')).get('account'))
        result['checkpoint'] = dict(zip(('revision','fence','owner_hash','lease_until','updated_at','state_bytes'), (row[0],row[1],sha(str(row[2]).encode()) if row[2] else None,row[3],row[4],row[5])))
        result['checkpoint']['owner_pid_binding'] = 'NOT_VERIFIED'
        result['dashboard_publisher']=dashboard_status(db)
        result['secondary_present'] = bool(x)
        result['account'] = {key: decimal_string(account.get(key)) for key in ('cash','equity','net','fees','fundingReserve','reserved','closed','wins','losses')}
        result['account']['scope'] = 'SECONDARY_CUMULATIVE_CHECKPOINT_NOT_WINDOW_TOTAL'
        result['profiles'] = {key: pick(x.get(key), ('version','active','activated_at','policy_hash')) for key in ('exploration','profit_policy','capital_allocation','risk_budget','quant','timeframe_execution')}
        # Configuration from the acquired checkpoint; no secret/environment files.
        result['policy_inputs'] = {key: {k:v for k,v in obj(obj(x.get(key)).get('policy')).items() if k in (
          'symbol','mode','ledger','realTrading','entry_frames','nominalUSD','leverage','leg_risk_fraction',
          'leg_risk_cap_usd','portfolio_risk_fraction','portfolio_risk_cap_usd','movement_risk_fraction',
          'movement_risk_cap_usd','margin_fraction','gross_exposure_multiple','aspirational_net_target_usd')}
          for key in ('exploration','risk_budget','timeframe_execution')}
        result['configuration_provenance'] = 'CHECKPOINT_APPLIED_PROFILES; startup environment and requested flags not read'
        quote = obj(obj(x.get('market')).get('quote'))
        result['market'] = pick(quote, ('event_at','received_at','bid','ask','bid_qty','ask_qty'))
        result['market'].update(pick(x.get('market'),('symbol','last_refresh','error','funding_history_error')))
        result['market']['frames']={str(tf):{key:obj(obj(x.get('market')).get(key)).get(str(tf)) for key in ('closed_at','frame_errors','frame_refresh_at')} for tf in FRAMES}
        at = quote.get('event_at'); age = elapsed(now.timestamp()*1000, at)
        result['market']['age_seconds'] = age
        result['market']['freshness'] = 'UNKNOWN' if age is None else 'STALE' if age>10 else 'WITHIN_10S_OBSERVATION_ONLY'
        frames = obj(obj(x.get('timeframe_execution')).get('frames'))
        enabled = obj(obj(x.get('timeframe_execution')).get('policy')).get('entry_frames')
        metrics = obj(obj(x.get('quant')).get('evaluation_metrics'))
        result['evaluation_metrics'] = pick(metrics, ('version','unit','since','counts'))
        for tf in FRAMES:
            frame = obj(frames.get(str(tf),frames.get(tf)))
            result['frames'][str(tf)] = {'enabled': tf in enabled if isinstance(enabled,list) else None,
              'checkpoint': pick(frame, ('last_cutoff','last_evaluation_at','last_completed_at','last_status','blocker','counts','entry_funnel','reasons')),
              'corrected_metrics': pick(obj(metrics.get('frames')).get(str(tf)), ('counts','last_status','last_attempt_at','terminal_through')),
              'archived_events': {}, 'unique_position_ids': {}, 'unique_selected_opportunities': None}
        def position(value):
            p = obj(value); plan = obj(p.get('plan'))
            return {'operation_id':anon(plan.get('id')), 'timeframe':timeframe({'plan':plan}),
                'direction':plan.get('direction'), 'pattern':plan.get('pattern'),
                'instrument':plan.get('instrument'), 'policy':pick(plan.get('exit_policy'), ('version','hash')),
                'position':pick(p, ('qty','initial_qty','entered_at','entry','initial_margin','remaining_risk','remaining_reserved','remaining_qty','execution_blocker')),
                'sizing':pick(plan.get('sizing'), ('qty','risk','reserved','notional','qty_step','leverage')),
                'realized':pick(p.get('realized'), ('net','gross','fees','funding','entry_fee','exit_fee')),
                'levels':pick(plan, ('stop','target','holding_ms')), 'pending': 'placed_at' in p}
        result['open_positions'] = [position(p) for p in seq(account.get('positions'))[:32]]
        result['pending_orders'] = [position(p) for p in seq(account.get('pendingOrders'))[:32]]
        result['record_counts'] = {'open_positions':len(seq(account.get('positions'))), 'pending_orders':len(seq(account.get('pendingOrders')))}
        index = db.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='events_kind_time'").fetchone()
        if not index: raise RuntimeError('REQUIRED_EVENTS_KIND_TIME_INDEX_MISSING_NO_SCAN_ATTEMPTED')
        if [row[2] for row in db.execute("PRAGMA index_info('events_kind_time')")]!=['kind','created_at']:raise RuntimeError('EVENTS_INDEX_COLUMNS_UNEXPECTED_NO_SCAN_ATTEMPTED')
        event_groups = collections.defaultdict(list)
        for kind in KINDS:
            rows = db.execute('SELECT id,created_at,length(payload),CASE WHEN length(payload)<=? THEN payload END FROM events INDEXED BY events_kind_time WHERE kind=? AND created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT ?', (MAX_EVENT_BYTES,kind,start,end,max_rows+1))
            coverage = {'indexed_rows_read':0,'row_limit':max_rows,'query_complete':True,'oversize':0,'invalid':0,'secondary_rows':0}
            for index,(eid,created,size,raw) in enumerate(rows):
                if index==max_rows: coverage['query_complete']=False;break
                coverage['indexed_rows_read']+=1
                total_bytes += size
                if total_bytes>MAX_TOTAL_BYTES: raise RuntimeError('EVENT_TOTAL_BYTE_LIMIT')
                if raw is None: coverage['oversize']+=1; coverage['query_complete']=False; continue
                try: event=json.loads(raw)
                except (ValueError,TypeError): coverage['invalid']+=1;coverage['query_complete']=False;continue
                if not isinstance(event,dict) or event.get('ledger')!='FREQUENT_PAPER': continue
                if event.get('realTrading') is True: raise RuntimeError('SECONDARY_REAL_TRADING_FLAG_CONFLICT')
                coverage['secondary_rows']+=1
                event_groups[kind].append((eid,created,event))
            result['coverage'][kind]=coverage
        # No outbox payloads/recipients: index-bounded notification counts only.
        if db.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='outbox_created'").fetchone():
            notices=collections.Counter();notice_rows=0;notice_complete=True
            for index,(kind,status) in enumerate(db.execute('SELECT kind,status FROM outbox INDEXED BY outbox_created WHERE created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT ?', (start,end,max_rows+1))):
                if index==max_rows:notice_complete=False;break
                notice_rows+=1
                if isinstance(kind,str) and kind.startswith('SECONDARY_'):notices[(kind,status)]+=1
            result['secondary_notifications']={'query_complete':notice_complete,'indexed_rows_read':notice_rows,'counts':[{'kind':kind,'status':status,'count':count} for (kind,status),count in sorted(notices.items())],'scope':'WINDOW_OUTBOX_ROWS_NOT_DELIVERY_ATTEMPTS'}
        else:result['secondary_notifications']={'status':'INDEX_OR_TABLE_UNAVAILABLE','counts':None}
        details=[]; net_total=decimal.Decimal(0); unknown_net=0
        for tf in FRAMES:
            output=result['frames'][str(tf)]
            for kind in KINDS:
                events=[e for _,_,e in event_groups[kind] if timeframe(e)==tf]
                ids={e.get('id',obj(e.get('plan')).get('id')) for e in events};ids.discard(None)
                checks={(e.get('cutoff'),e.get('pattern'),e.get('timeframe_version'),e.get('evaluation_status')) for e in events if e.get('cutoff') is not None}
                reasons=collections.Counter(e.get('reason','UNKNOWN') for e in events)
                complete=result['coverage'][kind]['query_complete']
                output['archived_events'][kind]={'observed_rows':len(events),'distinct_position_or_signal_ids':len(ids),'distinct_archived_cutoff_pattern_status':len(checks) if checks else None,'reason_counts':dict(reasons),'detected_pattern_records':sum(obj(e.get('criteria')).get('pattern_detected') is True for e in events) if kind=='SECONDARY_PATTERN_EVALUATION' else None,'signal_records':sum(e.get('signal_id') is not None for e in events) if kind=='SECONDARY_PATTERN_EVALUATION' else None,'status': 'INCOMPLETE_WINDOW' if not complete else 'ZERO_OBSERVED_IN_WINDOW' if not events else 'OBSERVED'}
                if kind in ('FILLED','PARTIAL_FILL','PARTIAL_CLOSE','CLOSED'): output['unique_position_ids'][kind]=len(ids) if complete else None
                if kind=='SELECTED': output['unique_selected_opportunities']=len(ids) if complete else None
        # Distinct DB event ids can still repeat the same economic closure.
        # Position id + canonical complete receipt identify exact repeats. Any
        # different receipt for one position is ambiguous: select none of them.
        closed_by_position=collections.defaultdict(dict);unidentified_closed=0;duplicate_closed=0
        for eid,created,e in event_groups['CLOSED']:
            ident=operation_key(e)
            if ident is None:unidentified_closed+=1;continue
            receipt=sha(json.dumps(e,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode())
            variants=closed_by_position[ident]
            if receipt in variants:duplicate_closed+=1
            else:variants[receipt]=(eid,created,e)
        conflicts=[ident for ident,variants in closed_by_position.items() if len(variants)>1]
        distinct_closures=[next(iter(variants.values())) for variants in closed_by_position.values() if len(variants)==1]
        unknown_net=unidentified_closed+len(conflicts)
        for ident in conflicts:
            variants=closed_by_position[ident]
            tfs=sorted({timeframe(e) for _,_,e in variants.values() if timeframe(e) is not None})
            if any(tf in (15,60) for tf in tfs):details.append({'operation_id':anon(ident),'status':'CONFLICTING_CLOSED_RECEIPTS','observed_entry_timeframes':tfs,'distinct_receipts':len(variants),'net_complete_position':None,'reason':None})
        # CLOSED.pnl is cumulative for a full position: never add PARTIAL_CLOSE.pnl to it.
        for eid,created,e in distinct_closures:
            n=number(e.get('pnl'))
            if n is None: unknown_net+=1
            else: net_total+=n
            if timeframe(e) not in (15,60): continue
            ident=operation_key(e)
            related={kind:[v for _,_,v in event_groups[kind] if v.get('id',obj(v.get('plan')).get('id'))==ident] for kind in ('FILLED','PARTIAL_FILL','PARTIAL_CLOSE','FUNDING_RECONCILED')}
            details.append({'operation_id':anon(ident),'persisted_at':created,'status':'UNAMBIGUOUS_CLOSED_RECEIPT','entry_timeframe':obj(e.get('plan')).get('timeframe'),'event_timeframe':e.get('timeframe'),
              'entered_at':e.get('entered_at'),'closed_at':e.get('at'),'duration_seconds':elapsed(e.get('at'),e.get('entered_at')),
              'reason':e.get('reason'),'net_complete_position':decimal_string(e.get('pnl')),'gross':decimal_string(e.get('gross')),'costs_signed':decimal_string(e.get('fees')),'funding_signed':decimal_string(e.get('funding')),
              'result_final':e.get('result_final'),'funding_complete':e.get('funding_complete'),
              'entry_events_in_window':len(related['FILLED'])+len(related['PARTIAL_FILL']),
              'partials_in_window':[pick(v,('at','qty','remaining_qty','fill_pnl','pnl','reason')) for v in related['PARTIAL_CLOSE'][:20]],
              'funding_corrections_in_window':[pick(v,('at','net_adjustment','net_after','funding_complete')) for v in related['FUNDING_RECONCILED'][:20]],
              'excursions':pick(e.get('excursions'),('max_favourable_net','max_adverse_net','observations','quality','net_scope')),
              'path_quality':'OBSERVED_MARK_EXTREMES_ONLY_NOT_EXECUTABLE_GUARANTEE',
              'entry_link':'OBSERVED_IN_WINDOW' if related['FILLED'] else 'ENTRY_OUTSIDE_WINDOW_OR_HISTORY_INSUFFICIENT'})
        result['closures_15m_1h']=details[:100]
        result['closure_detail_limit_reached']=len(details)>100
        complete_closures=result['coverage']['CLOSED']['query_complete']
        result['window_closed_net']={'value':str(net_total) if not unknown_net and complete_closures else None,'known_subset_value':str(net_total),'unknown_net_records':unknown_net,
          'scope':'DISTINCT_POSITION_CUMULATIVE_PNL_AT_CLOSE_IN_REQUESTED_WINDOW; later funding corrections listed separately; not account net delta or historical total',
          'positions':len(closed_by_position) if complete_closures and not unidentified_closed else None,
          'observed_unique_positions':len(closed_by_position),'raw_event_rows':len(event_groups['CLOSED']),
          'exact_duplicate_event_rows':duplicate_closed,'unidentified_closed_rows':unidentified_closed,
          'conflicting_position_ids':[anon(ident) for ident in conflicts],
          'provisional_or_unknown_finality_positions':sum(e.get('result_final') is not True for _,_,e in distinct_closures)}
        db.execute('COMMIT');result['consistent_read_transaction']=True
    except (sqlite3.Error,ValueError,TypeError,RuntimeError) as error:
        result['error']={'type':type(error).__name__,'code':str(error) if isinstance(error,RuntimeError) else 'READ_OR_SCHEMA_FAILED'}
        result['limitations'].append('Partial reads do not certify absence of events or a complete ledger reconciliation.')
    finally:
        if db.in_transaction: db.execute('ROLLBACK')
        db.close()
    return result


def command(args,timeout=8):
    run=subprocess.run(args,capture_output=True,text=True,timeout=timeout,env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'})
    if run.returncode: raise RuntimeError('COMMAND_'+args[0]+'_EXIT_'+str(run.returncode))
    if len(run.stdout)>1048576: raise RuntimeError('COMMAND_OUTPUT_LIMIT')
    return run.stdout.strip()


def journal_diagnostic(stderr):
    """Keep only bounded diagnostic categories/digest, never raw log/error text."""
    raw=stderr if isinstance(stderr,bytes) else str(stderr or '').encode(errors='replace')
    sample=raw[:4096].decode(errors='replace').lower()
    known=(('NO_JOURNAL_FILES','no journal files'),('NO_ENTRIES','no entries'),
      ('PERMISSION_DENIED','permission denied'),('INVALID_ARGUMENT','invalid argument'),
      ('UNRECOGNIZED_OPTION','unrecognized option'),('TIMESTAMP_PARSE_FAILED','failed to parse timestamp'),
      ('ACCESS_DENIED','access denied'))
    codes=[code for code,text in known if text in sample]
    return {'stderr_bytes':len(raw),'stderr_prefix_sha256':sha(raw[:4096]) if raw else None,
      'stderr_prefix_bytes':min(len(raw),4096),'codes':codes or (['UNCLASSIFIED_STDERR'] if raw else []),
      'raw_text_exported':False}


def journal_query(pid,invocation,kind,*,run=subprocess.run):
    args=['journalctl','--no-pager','-o','json','-u',SERVICE,'_PID='+str(pid),
      '_SYSTEMD_INVOCATION_ID='+invocation,'--grep='+kind,'-n','2']
    result={'kind':kind,'status':'UNAVAILABLE','return_code':None,'timeout_seconds':8,
      'matching_records':0,'invalid_rows':0,'filters':{'service':SERVICE,'pid':pid,'invocation':invocation,'grep':kind,'tail':2},'records':[]}
    try:
        completed=run(args,capture_output=True,text=True,timeout=8,env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'})
        result['return_code']=completed.returncode
        result['diagnostic']=journal_diagnostic(completed.stderr)
        if completed.returncode!=0:
            result['status']='NONZERO_EXIT';return result
        stdout=completed.stdout
        if not isinstance(stdout,str):result['status']='INVALID_OUTPUT_TYPE';return result
        if len(stdout.encode())>131072:result['status']='OUTPUT_SIZE_LIMIT';return result
        for line in stdout.splitlines():
            if not line.strip():continue
            try:
                row=json.loads(line)
                if not isinstance(row,dict):raise ValueError('JOURNAL_ROW_SHAPE')
                data=json.loads(row.get('MESSAGE',''))
                if not isinstance(data,dict):raise ValueError('JOURNAL_MESSAGE_SHAPE')
                if data.get('event')!=kind:continue
                # The result must be associated with this exact execution even
                # when mocked, malformed or returned by an unexpected journal.
                if row.get('_PID')!=str(pid) or row.get('_SYSTEMD_INVOCATION_ID')!=invocation:raise ValueError('JOURNAL_PROCESS_MISMATCH')
                allowed=pick(data,('event','mode','platform','policy_hash','revision','cpu_fraction','rss_bytes','quote_age_ms','secondary_execution','connected','reconciled','quotes','trades'))
                identity=obj(data.get('worker_identity'));allowed['worker_identity']=pick(identity,('pid','captured_at','process_started_at_utc_estimate','identity_sha256','lease_owner_sha256','fence','revision','declared_source_commit','manifest_sha256','source_tree_sha256','loaded_source_attested')) if identity else None
                if identity:allowed['worker_identity']['release']=pick(identity.get('release'),('status','declared_source_commit','manifest_sha256','source_tree_sha256','verification_scope','loaded_source_attested'))
                perf=obj(data.get('performance'));allowed['performance']={'event_loop':pick(perf.get('event_loop'),('utilization','p95_ms','max_ms')),'stages':{name:pick(obj(perf.get('stages')).get(name),('count','mean_ms','max_ms','p95_ms')) for name in ('tick','checkpoint','publish')}}
                allowed['queues']=pick(data.get('queues'),('events','notices','market','telegram_busy','telegram_identity_unavailable','detail_busy'))
                allowed.update(journal_pid=row.get('_PID'),invocation=row.get('_SYSTEMD_INVOCATION_ID'),realtime_us=row.get('__REALTIME_TIMESTAMP'))
                result['records'].append(allowed)
            except (ValueError,TypeError,KeyError):result['invalid_rows']+=1
        result['matching_records']=len(result['records'])
        result['status']='INVALID_OR_PARTIAL_ROWS' if result['invalid_rows'] else 'READ' if result['records'] else 'NO_MATCHING_RECORDS'
    except subprocess.TimeoutExpired as error:
        result['status']='TIMEOUT';result['diagnostic']=journal_diagnostic(error.stderr)
    except OSError as error:
        result['status']='OS_ERROR';result['os_errno']=error.errno;result['os_code']=errno.errorcode.get(error.errno,'UNKNOWN_OS_ERROR')
    except Exception as error:
        result['status']='READ_FAILED';result['error_type']=type(error).__name__
    return result


def collect_runtime_diagnostics(out,pid,invocation,*,db_path=DB,journal_reader=journal_query):
    """Optional journal failure cannot abort independent disk/ledger reads."""
    out['journal']=[];out['journal_queries']=[];out['collection_warnings']=[]
    for kind in ('lumi_trading_started','lumi_trading_health'):
        query=journal_reader(pid,invocation,kind)
        out['journal'].extend(query.pop('records',[]));out['journal_queries'].append(query)
        if query['status']!='READ':out['collection_warnings'].append({'section':'journal','kind':kind,'code':query['status']})
    try:
        path=Path(db_path);fs=os.statvfs(path.parent)
        out['storage']={'available_bytes':fs.f_bavail*fs.f_frsize,'db_bytes':path.stat().st_size,'wal_bytes':Path(str(path)+'-wal').stat().st_size if Path(str(path)+'-wal').exists() else 0}
    except OSError as error:
        out['storage']={'status':'READ_FAILED','os_errno':error.errno,'os_code':errno.errorcode.get(error.errno,'UNKNOWN_OS_ERROR')}
        out['collection_warnings'].append({'section':'storage','code':'READ_FAILED'})
    try:out['paper']=read_db(db_path)
    except Exception as error:out['paper']={'consistent_read_transaction':False,'error':{'type':type(error).__name__,'code':'DATABASE_READ_FAILED'}}
    if not out['paper'].get('consistent_read_transaction'):
        out['collection_warnings'].append({'section':'paper','code':'CONSISTENT_READ_NOT_COMPLETED'})
    out['diagnostic_status']='DEGRADED' if out['collection_warnings'] else 'COLLECTED_WITH_DECLARED_LIMITS'
    return out


CAPACITY_INVENTORY_LIMIT=40
RECOVERY_SERVICE='lumi-trading-s3-recovery.service'
RECOVERY_BUCKET='lumi-paper-recovery-146766539818-eun1'
MAX_REMOTE_COMMAND_BYTES=32768


def safe_read_error(error):
    return {'status':'READ_FAILED','error_type':type(error).__name__,
        'os_code':errno.errorcode.get(error.errno,'UNKNOWN_OS_ERROR') if isinstance(error,OSError) else None}


def file_stat(path):
    """Metadata only; never follow a symlink or read an unknown file."""
    try:
        s=Path(path).lstat()
        return {'status':'PRESENT','kind':'file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'symlink' if stat.S_ISLNK(s.st_mode) else 'other',
            'bytes':s.st_size,'allocated_bytes':getattr(s,'st_blocks',0)*512,
            'mtime_ns':s.st_mtime_ns,'device':s.st_dev,'inode':s.st_ino,'links':s.st_nlink}
    except FileNotFoundError:return {'status':'ABSENT','bytes':None}
    except OSError as error:return safe_read_error(error)


def bounded_source_digest(path, *, limit=262144):
    """Hash only the opened regular source descriptor, without following links."""
    result={'status':'UNAVAILABLE','limit_bytes':limit};fd=None
    if not hasattr(os,'O_NOFOLLOW'):result['status']='NO_NOFOLLOW_CAPABILITY';return result
    try:
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW);before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):result['status']='NOT_A_REGULAR_FILE';return result
        if before.st_size>limit:result['status']='SOURCE_SIZE_LIMIT';return result
        digest=hashlib.sha256();total=0
        while total<=limit:
            chunk=os.read(fd,min(65536,limit+1-total))
            if not chunk:break
            total+=len(chunk);digest.update(chunk)
        if total>limit:result['status']='SOURCE_SIZE_LIMIT';return result
        after=os.fstat(fd);named=Path(path).lstat()
        stable=(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)==(named.st_dev,named.st_ino,named.st_size,named.st_mtime_ns)
        result.update(status='READ' if stable and total==after.st_size else 'SOURCE_CHANGED_DURING_READ',bytes_read=total,stable_after_read=stable)
        if result['status']=='READ':result['sha256']=digest.hexdigest()
    except OSError as error:result.update(safe_read_error(error))
    finally:
        if fd is not None:os.close(fd)
    return result


def bounded_inventory(path, *, limit=CAPACITY_INVENTORY_LIMIT):
    """At most limit+1 direct entries; directory st_size is NOT subtree size."""
    out={'status':'UNAVAILABLE','entries':[],'limit':limit,'complete':False,
        'scope':'DIRECT_ENTRIES_ONLY_NO_RECURSION_DIRECTORY_BYTES_ARE_NOT_TREE_USAGE'}
    try:
        if file_stat(path).get('kind')!='directory':out['status']='NOT_A_REAL_DIRECTORY';return out
        with os.scandir(path) as entries:
            for index,entry in enumerate(entries):
                if index==limit:out['status']='ENTRY_LIMIT';return out
                # Do not export arbitrary names that could embed personal data.
                allowed=re.fullmatch(r'[a-f0-9]{40}|daily-[012]\.sqlite(?:\.enc)?(?:\.tmp)?|[a-zA-Z0-9._-]{1,100}\.(?:tar|tar\.gz|tgz|zip|log)(?:\.\d+)?',entry.name)
                name=entry.name if allowed else 'name-sha256:'+sha(entry.name.encode())
                out['entries'].append({'name':name,'remote_verify_directory':entry.name.startswith('.remote-verify-'),**file_stat(entry.path)})
        out['status']='READ';out['complete']=True
    except OSError as error:out.update(safe_read_error(error))
    return out


def read_capacity_db(path=DB, *, snapshot=False, deadline_seconds=2):
    """Read scalar metadata only. No events, state JSON, backup or full integrity scan."""
    path=Path(path);before=file_stat(path)
    result={'consistent_read_transaction':False,'scope':'SCALAR_CHECKPOINT_AND_PAGE_METADATA_NOT_RESTORE_VERIFICATION','file_before':before}
    if before.get('kind')!='file':result['status']='NOT_A_REGULAR_FILE';return result
    suffixes=('-wal','-shm','-journal')
    sidecars=lambda:{suffix:file_stat(str(path)+suffix) for suffix in suffixes}
    result['sidecars_before']=sidecars()
    if snapshot and any(v['status']!='ABSENT' for v in result['sidecars_before'].values()):
        result['status']='SNAPSHOT_SIDECAR_PRESENT_OR_UNREADABLE';return result
    db=None;deadline=time.monotonic()+deadline_seconds
    try:
        # SQLite's immutable flag prevents creating sidecars for a completed
        # rotated snapshot. A live DB must retain WAL visibility instead.
        db=sqlite3.connect(path.resolve().as_uri()+'?mode=ro'+('&immutable=1' if snapshot else ''),uri=True,timeout=1)
        db.execute('PRAGMA query_only=ON');db.execute('PRAGMA busy_timeout=1000');db.execute('PRAGMA cache_size=-256')
        db.set_progress_handler(lambda:int(time.monotonic()>deadline),100)
        db.execute('BEGIN')
        result['pages']={key:db.execute('PRAGMA '+key).fetchone()[0] for key in ('page_count','page_size','freelist_count')}
        schema=db.execute('PRAGMA table_info(state)').fetchmany(32)
        if not any(v[1]=='id' and v[5]==1 for v in schema):raise RuntimeError('STATE_PRIMARY_KEY_NOT_CONFIRMED_NO_SCAN')
        row=db.execute('SELECT revision,fence,updated_at FROM state WHERE id=?',(STATE_ID,)).fetchone()
        result['checkpoint']=dict(zip(('revision','fence','updated_at'),row)) if row else None
        if not snapshot:result['dashboard_publisher']=dashboard_status(db,capacity=True)
        result['consistent_read_transaction']=True;result['status']='READ' if row else 'PAPER_CHECKPOINT_MISSING'
    except Exception as error:result.update(safe_read_error(error))
    finally:
        if db is not None:
            if db.in_transaction:db.execute('ROLLBACK')
            db.close()
        result['file_after']=file_stat(path);result['sidecars_after']=sidecars()
        result['same_file_after_read']=all(before.get(k)==result['file_after'].get(k) for k in ('device','inode','bytes','mtime_ns'))
        if snapshot and (not result['same_file_after_read'] or any(v['status']!='ABSENT' for v in result['sidecars_after'].values())):
            result['status']='SNAPSHOT_CHANGED_DURING_READ';result['consistent_read_transaction']=False
    return result


def safe_probe(args, *, run=subprocess.run, timeout=4, output_limit=65536):
    """Internal bounded command result; raw streams are never put in receipts."""
    result={'status':'UNAVAILABLE','return_code':None,'timeout_seconds':timeout}
    try:
        completed=run(args,capture_output=True,text=True,timeout=timeout)
        result.update(return_code=completed.returncode,diagnostic=journal_diagnostic(completed.stderr))
        if completed.returncode:result['status']='NONZERO_EXIT';return result,None
        if not isinstance(completed.stdout,str) or len(completed.stdout.encode())>output_limit:
            result['status']='OUTPUT_LIMIT_OR_TYPE';return result,None
        result['status']='READ';return result,completed.stdout
    except subprocess.TimeoutExpired as error:
        result.update(status='TIMEOUT',diagnostic=journal_diagnostic(error.stderr))
    except OSError as error:result.update(safe_read_error(error))
    return result,None


def recovery_journal(*, run=subprocess.run):
    args=['journalctl','--no-pager','-o','json','-u',RECOVERY_SERVICE,'--grep=REMOTE_ALREADY_MATCHES|RESTORE_VERIFIED|RESTORE_STREAM_VERIFIED|"status":"FAIL"','-n','3']
    result,text=safe_probe(args,run=run);result.update(records=[],invalid_rows=0,tail=3)
    if text is None:return result
    statuses={'REMOTE_ALREADY_MATCHES','RESTORE_VERIFIED','RESTORE_STREAM_VERIFIED','FAIL'}
    phases={'PREPARE','SOURCE_SQLITE_INTEGRITY','REMOTE_EXISTING_HEAD','STORAGE_SPACE_PREFLIGHT','PRIVATE_KEY_LOAD','ENCRYPT','S3_UPLOAD','REMOTE_HEAD_CONFIRM','REMOTE_DOWNLOAD','REMOTE_SHA256','STREAM_AES_GCM_PLAINTEXT_CHECK','DECRYPT_AES_GCM','RESTORED_SQLITE_INTEGRITY'}
    errors={'NO_RECENT_SQLITE_BACKUP','BACKUP_STORAGE_SPACE_LOW','SNAPSHOT_INTEGRITY_FAILED','PAPER_LEDGER_MISSING','BACKUP_KEY_INVALID','PRIVATE_BACKUP_KEY_UNAVAILABLE','REMOTE_HEAD_VERIFICATION_FAILED','REMOTE_DOWNLOAD_SHA256_MISMATCH','RESTORED_REVISION_MISMATCH','RESTORED_PLAINTEXT_MISMATCH','COMPRESSED_BACKUP_SIZE_LIMIT','ROOT_ONLY_NO_EXPORTED_KEY','RECOVERY_UPLOAD_OR_VERIFY_ERROR'}
    for line in text.splitlines()[:3]:
        try:
            row=json.loads(line);data=json.loads(row.get('MESSAGE',''))
            if row.get('_SYSTEMD_UNIT')!=RECOVERY_SERVICE or not isinstance(data,dict) or data.get('status') not in statuses:raise ValueError('UNEXPECTED_RECOVERY_ROW')
            item={'status':data['status'],'phase':data.get('phase') if data.get('phase') in phases else None,
                'error':data.get('error') if data.get('error') in errors else None,
                'realtime_us':row.get('__REALTIME_TIMESTAMP') if re.fullmatch(r'\d{1,20}',str(row.get('__REALTIME_TIMESTAMP',''))) else None}
            for key in ('revision','source_bytes','encrypted_bytes','size'):
                value=data.get(key);item[key]=value if isinstance(value,int) and not isinstance(value,bool) and value>=0 else None
            item['sha256']=data.get('sha256') if re.fullmatch('[a-f0-9]{64}',str(data.get('sha256',''))) else None
            item['verified_again']=data.get('verified_again') if isinstance(data.get('verified_again'),bool) else None
            result['records'].append(item)
        except (ValueError,TypeError,AttributeError):result['invalid_rows']+=1
    if len(text.splitlines())>3:result['status']='ROW_LIMIT'
    elif result['invalid_rows']:result['status']='INVALID_OR_PARTIAL_ROWS'
    elif not result['records']:result['status']='NO_MATCHING_RECORDS'
    return result


def collect_capacity_diagnostics(out,pid,invocation,*,db_path=DB,releases='/opt/lumi-trading/releases',run=subprocess.run):
    started=time.monotonic();path=Path(db_path);backups=path.parent/'backups'
    out['collection_warnings']=[];capacity={'mode':'CAPACITY_ONLY_NO_HISTORY_QUERY_NO_FULL_STATE','observed_at_utc':stamp(utc())}
    out['capacity']=capacity
    try:
        fs=os.statvfs(path.parent)
        capacity['filesystem']={'total_bytes':fs.f_blocks*fs.f_frsize,'free_bytes':fs.f_bfree*fs.f_frsize,'available_bytes':fs.f_bavail*fs.f_frsize,'inodes_total':fs.f_files,'inodes_free':fs.f_ffree,'inodes_available':fs.f_favail}
    except OSError as error:capacity['filesystem']=safe_read_error(error)
    capacity['database']=read_capacity_db(path)
    capacity['backup_files']={}
    for slot in range(3):
        for suffix in ('.sqlite','.sqlite.tmp','.sqlite.enc.tmp'):
            name='daily-'+str(slot)+suffix;entry=file_stat(backups/name)
            if suffix=='.sqlite' and entry.get('kind')=='file':entry['scalar_read']=read_capacity_db(backups/name,snapshot=True)
            capacity['backup_files'][name]=entry
    capacity['backup_directory']=bounded_inventory(backups)
    capacity['releases_directory']=bounded_inventory(releases)
    capacity['var_log_direct_entries']=bounded_inventory('/var/log')
    capacity['journal_disk_usage'],usage=safe_probe(['journalctl','--disk-usage','--no-pager'],run=run)
    if usage is not None:
        match=re.fullmatch(r'Archived and active journals take up ([0-9.]+(?:[KMGT]B?|B)) in the file system\.\s*',usage)
        capacity['journal_disk_usage']['reported_size']=match.group(1) if match else None
        if not match:capacity['journal_disk_usage']['status']='UNRECOGNIZED_FORMAT'
    capacity['recovery_units']={}
    props=('LoadState','ActiveState','SubState','MainPID','Result','ExecMainStatus','ExecMainStartTimestamp','LastTriggerUSec','NextElapseUSecRealtime')
    for unit in (RECOVERY_SERVICE,'lumi-trading-s3-recovery.timer'):
        result,text=safe_probe(['systemctl','show',unit,'--property='+','.join(props)],run=run)
        if text is not None:
            parsed=dict(line.split('=',1) for line in text.splitlines() if '=' in line)
            result['properties']={key:value for key,value in parsed.items() if key in props and re.fullmatch(r'[A-Za-z0-9 :+._-]{0,100}',value)}
            if result['properties'].get('LoadState')!='loaded':result['status']='UNIT_NOT_LOADED_OR_UNKNOWN'
        capacity['recovery_units'][unit]=result
    capacity['recovery_helper']=bounded_source_digest('/opt/lumi-trading/recovery/s3-backup.mjs')
    capacity['recovery_journal']=recovery_journal(run=run)
    for key in ('backup_directory','releases_directory','var_log_direct_entries','journal_disk_usage','recovery_journal'):
        if capacity[key].get('status')!='READ':out['collection_warnings'].append({'section':key,'code':capacity[key].get('status')})
    for name,entry in capacity['backup_files'].items():
        if entry.get('status') not in ('ABSENT','PRESENT') or ('scalar_read' in entry and entry['scalar_read'].get('status')!='READ'):
            out['collection_warnings'].append({'section':'backup_file','name':name,'code':obj(entry.get('scalar_read')).get('status',entry.get('status'))})
    for name,result in capacity['recovery_units'].items():
        if result['status']!='READ':out['collection_warnings'].append({'section':name,'code':result['status']})
    if capacity['recovery_helper']['status']!='READ':out['collection_warnings'].append({'section':'recovery_helper','code':capacity['recovery_helper']['status']})
    if not capacity['database'].get('consistent_read_transaction'):out['collection_warnings'].append({'section':'database','code':'CONSISTENT_SCALAR_READ_NOT_COMPLETED'})
    if capacity['filesystem'].get('status')=='READ_FAILED':out['collection_warnings'].append({'section':'filesystem','code':'READ_FAILED'})
    capacity['elapsed_seconds']=round(time.monotonic()-started,3)
    capacity['limitations']=['No backup creation, copy, deletion, WAL checkpoint, vacuum, integrity scan or recovery helper execution.',
        'Scalar snapshot reads do not prove restore integrity, newest economic activity coverage or reusable disk space.',
        'Journal statuses describe their recorded time, not an independently repeated restore.',
        'Directory inventories are bounded and nonrecursive; absent or unreadable evidence is never a cleanup authorization.']
    out['diagnostic_status']='DEGRADED' if out['collection_warnings'] else 'COLLECTED_WITH_DECLARED_LIMITS'
    return out


def storage_reference(path,root):
    """Return release ownership and bounded path evidence, not arbitrary names."""
    text=os.path.normpath(str(path));base=os.path.normpath(str(root))
    try:parts=Path(text).relative_to(base).parts
    except ValueError:parts=()
    release=parts[0] if parts and re.fullmatch('[a-f0-9]{40}',parts[0]) else None
    suffix='/'.join(parts[1:])
    safe=release and (not suffix or suffix in ('.git','node_modules','.git/objects') or re.fullmatch(r'\.git/worktrees/[a-f0-9]{40}(?:/objects)?',suffix))
    return {'release':release,'path':text if safe else None,'path_sha256':sha(text.encode()),'inside_release_root':bool(release)}


def metadata_text(path,limit=8192):
    """Internal metadata only: regular file, no link following, bounded and stable."""
    fd=None
    try:
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW);before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size>limit:raise RuntimeError('METADATA_SIZE_OR_TYPE')
        data=os.read(fd,limit+1);after=os.fstat(fd)
        if len(data)>limit or len(data)!=before.st_size or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):raise RuntimeError('METADATA_CHANGED_OR_LIMIT')
        return data.decode('utf-8')
    finally:
        if fd is not None:os.close(fd)


def storage_processes(root,*,proc_root='/proc',limit=128,deadline=None):
    out={'status':'READ','complete':True,'pid_limit':limit,'examined':0,'unreadable':0,'references':[]}
    try:
        with os.scandir(proc_root) as entries:
            for entry in entries:
                if not entry.name.isdigit():continue
                if out['examined']>=limit or (deadline is not None and time.monotonic()>=deadline):out.update(status='PROCESS_LIMIT',complete=False);break
                out['examined']+=1
                try:
                    target=os.readlink(Path(entry.path)/'cwd');reference=storage_reference(target,root)
                    if reference['inside_release_root']:out['references'].append({'pid':int(entry.name),**reference})
                except OSError:out['unreadable']+=1;out['complete']=False
    except OSError as error:out.update(safe_read_error(error));out['complete']=False
    if out['unreadable'] and out['status']=='READ':out['status']='PROCESS_READ_GAPS'
    return out


def storage_walk(paths,*,root,seconds=12,max_entries=150000,max_inodes=100000,max_depth=24,max_pending=4096):
    """Aggregate lstat only. Never follow links or read any file contents."""
    began=time.monotonic();deadline=began+seconds;seen={};examined=0;stop=None;results={};edges=[];edge_limit=256;edge_overflow=False
    for owner,path in paths:
        row={'status':'NOT_VISITED','complete':False,'entries':0,'regular_files':0,'reported_allocated_bytes':0,'buckets':{},'errors':0};results[owner]=row
        if stop:continue
        try:device=Path(path).lstat().st_dev
        except OSError:row['status']='ROOT_UNREADABLE';row['errors']+=1;continue
        stack=[(Path(path),0)];row['status']='READ';row['complete']=True
        while stack:
            if time.monotonic()>=deadline:stop='WALK_TIME_LIMIT';break
            if examined>=max_entries:stop='WALK_ENTRY_LIMIT';break
            if examined%1024==0 and resource is not None and sys.platform=='linux' and resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024>=64*1024**2:stop='COLLECTOR_RSS_LIMIT';break
            current,depth=stack.pop()
            try:s=current.lstat()
            except OSError:row['errors']+=1;row['complete']=False;continue
            examined+=1;row['entries']+=1
            if s.st_dev!=device:row['errors']+=1;row['complete']=False;continue
            if depth>max_depth:row['errors']+=1;row['complete']=False;continue
            relative=current.relative_to(path).parts;top=relative[0] if relative else ''
            bucket=top if top in ('.git','node_modules','data','backups','artifacts') else 'source_or_other'
            allocated=getattr(s,'st_blocks',0)*512;row['reported_allocated_bytes']+=allocated;row['buckets'][bucket]=row['buckets'].get(bucket,0)+allocated
            if stat.S_ISREG(s.st_mode):row['regular_files']+=1
            inode=(s.st_dev,s.st_ino)
            if inode in seen:
                item=seen[inode];item[2]+=1
                if item[3]!=owner:item[4]=True
            else:
                if len(seen)>=max_inodes:stop='WALK_INODE_LIMIT';break
                seen[inode]=[allocated,s.st_nlink,1,owner,False,stat.S_ISREG(s.st_mode)]
            if stat.S_ISLNK(s.st_mode):
                if len(edges)>=edge_limit:edge_overflow=True;row['complete']=False;continue
                try:
                    target=os.readlink(current);target=Path(target) if os.path.isabs(target) else current.parent/target
                    edges.append({'owner':owner,'source_category':bucket,'source_relative_sha256':sha('/'.join(relative).encode()),'target':storage_reference(target,root)})
                except OSError:row['errors']+=1;row['complete']=False
            elif stat.S_ISDIR(s.st_mode):
                try:
                    with os.scandir(current) as children:
                        for child in children:
                            if len(stack)>=max_pending:stop='WALK_PENDING_PATH_LIMIT';break
                            if len(stack)+examined>=max_entries:stop='WALK_ENTRY_LIMIT';break
                            if time.monotonic()>=deadline:stop='WALK_TIME_LIMIT';break
                            stack.append((Path(child.path),depth+1))
                except OSError:row['errors']+=1;row['complete']=False
            if stop:break
        if stop:row['status']=stop;row['complete']=False
        elif not row['complete']:row['status']='WALK_READ_GAPS'
    unique=0;shared=0;unaccounted_links=0
    for allocated,nlinks,occurrences,owner,multiple,regular in seen.values():
        unique+=allocated
        if multiple:shared+=allocated
        else:results[owner]['unique_within_observed_trees_allocated_bytes']=results[owner].get('unique_within_observed_trees_allocated_bytes',0)+allocated
        if regular and nlinks>occurrences:unaccounted_links+=1
    return {'status':stop or ('READ' if all(x['complete'] for x in results.values()) and not edge_overflow else 'WALK_READ_GAPS'),'complete':not stop and all(x['complete'] for x in results.values()) and not edge_overflow,'elapsed_seconds':round(time.monotonic()-began,3),'limits':{'seconds':seconds,'entries':max_entries,'inodes':max_inodes,'depth':max_depth,'pending_paths':max_pending,'exported_symlinks':edge_limit,'rss_soft_limit_bytes':64*1024**2,'rss_sample_every_entries':1024},'collector_peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024 if resource is not None and sys.platform=='linux' else None,'entries_examined':examined,'unique_inodes':len(seen),'reported_unique_inode_allocated_bytes':unique,'shared_across_trees_allocated_bytes':shared,'regular_inodes_with_unobserved_links':unaccounted_links,'trees':results,'symlink_edges':edges,'symlink_edge_limit_reached':edge_overflow,'safe_reclaimable_bytes':None,'scope':'st_blocks attribution, not exclusive physical extents or proof that removal is safe; no file-content reads.'}


def storage_git_graph(paths,*,root,run=subprocess.run,deadline=None):
    graph={};deadline=deadline or time.monotonic()+12
    for name,path in paths:
        item={'status':'NOT_VISITED','head':None,'git_links':[],'node_modules':None,'alternates':[]};graph[name]=item
        if time.monotonic()>=deadline:item['status']='GRAPH_TIME_LIMIT';continue
        args=['git','--no-optional-locks','-C',str(path),'rev-parse','--path-format=absolute','--git-dir','--git-common-dir','HEAD']
        result,text=safe_probe(args,run=run,timeout=max(0.05,min(1,deadline-time.monotonic())),output_limit=8192);item.update(result)
        if text is not None:
            lines=text.strip().splitlines()
            if len(lines)!=3 or not re.fullmatch('[a-f0-9]{40}',lines[2]):item['status']='INVALID_GIT_METADATA'
            else:
                item['head']=lines[2];item['head_matches_directory']=name==lines[2]
                item['git_links']=[{'kind':kind,**storage_reference(value,root)} for kind,value in zip(('git_dir','git_common_dir'),lines[:2])]
                common=Path(lines[1])
                if storage_reference(common,root)['inside_release_root']:
                    alternates=common/'objects/info/alternates'
                    try:
                        text=metadata_text(alternates);values=text.splitlines()
                        if len(values)>16:item['alternates_status']='ALTERNATE_LIMIT'
                        else:
                            item['alternates']=[storage_reference(value if os.path.isabs(value) else common/'objects'/value,root) for value in values if value]
                            item['alternates_status']='READ'
                    except FileNotFoundError:item['alternates_status']='ABSENT'
                    except Exception:item['alternates_status']='ALTERNATE_UNREADABLE'
                else:item['alternates_status']='EXTERNAL_COMMON_DIR_NOT_READ'
        cursor=Path(path)/'node_modules';chain=[]
        try:
            for depth in range(16):
                info=cursor.lstat()
                if not stat.S_ISLNK(info.st_mode):item['node_modules']={'status':'READ','kind':'directory' if stat.S_ISDIR(info.st_mode) else 'other','chain':chain,'final':storage_reference(cursor,root)};break
                target=os.readlink(cursor);cursor=Path(os.path.normpath(target if os.path.isabs(target) else cursor.parent/target));chain.append(storage_reference(cursor,root))
            else:item['node_modules']={'status':'SYMLINK_DEPTH_LIMIT','chain':chain}
        except FileNotFoundError:item['node_modules']={'status':'DANGLING' if chain else 'ABSENT','chain':chain}
        except OSError:item['node_modules']={'status':'SYMLINK_READ_FAILED','chain':chain}
    return graph


def storage_git_status(path,*,run=subprocess.run,timeout=2):
    args=['git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-C',str(path),'status','--porcelain=v1','--untracked-files=normal','--ignored=matching']
    result,text=safe_probe(args,run=run,timeout=timeout,output_limit=131072)
    result.update(clean_tracked=None,untracked_count=None,ignored_count=None,deletion_actions_available=False)
    if text is None:return result
    rows=text.splitlines();counts=collections.Counter();ignored_modules=0
    for line in rows:
        if len(line)<3 or line[2]!=' ' or not re.fullmatch(r'[ MADRCU?!]{2}',line[:2]):result['status']='INVALID_PORCELAIN';return result
        counts[line[:2]]+=1
        if line[:2]=='!!' and line[3:].rstrip('/')=='node_modules':ignored_modules+=1
    result.update(porcelain_sha256=sha(text.encode()),porcelain_rows=len(rows),clean_tracked=not any(k not in ('??','!!') for k in counts),untracked_count=counts['??'],ignored_count=counts['!!'],ignored_node_modules_count=ignored_modules,ignored_other_count=counts['!!']-ignored_modules,code_counts=dict(counts),scope='Counts are porcelain entries, not recursive file counts. No paths exported. Clean tracked files do not prove ignored/untracked data disposable or a safe rollback set.')
    return result


def collect_storage_plan(out,pid,invocation,*,root='/opt/lumi-trading/releases',backups='/var/lib/lumi-trading/backups',proc_root='/proc',run=subprocess.run,seconds=36,walk_seconds=12,lower_priority=True):
    started=time.monotonic();deadline=started+seconds;root=Path(root);out['collection_warnings']=[]
    plan={'mode':'METADATA_STORAGE_PLAN_NO_DB_NO_BACKUP_NO_CLEANUP','deletion_actions_available':False,'safe_reclaimable_bytes':None,'limits':{'overall_seconds':seconds,'walk_seconds':walk_seconds,'graph_and_status_additional_seconds':12,'process_count':128,'backup_entries':512,'git_status_candidates':5},'priority':'NOT_REQUESTED'};out['storage_plan']=plan
    if lower_priority:
        try:plan['priority']={'collector_nice':os.nice(15),'scope':'COLLECTOR_AND_ITS_CHILDREN_ONLY'}
        except OSError as error:plan['priority']=safe_read_error(error)
    plan['filesystem']={}
    for name,path in (('root',Path('/')),('ledger_parent',Path(backups).parent)):
        try:
            s=path.stat();fs=os.statvfs(path);plan['filesystem'][name]={'device':s.st_dev,'major':os.major(s.st_dev),'minor':os.minor(s.st_dev),'total_bytes':fs.f_blocks*fs.f_frsize,'available_bytes':fs.f_bavail*fs.f_frsize,'inodes_available':fs.f_favail}
        except OSError as error:plan['filesystem'][name]=safe_read_error(error)
    plan['filesystem']['same_device']=plan['filesystem']['root'].get('device')==plan['filesystem']['ledger_parent'].get('device') if 'device' in plan['filesystem']['root'] and 'device' in plan['filesystem']['ledger_parent'] else None
    plan['memory']={'MemTotal_bytes':None,'MemAvailable_bytes':None}
    try:
        with (Path(proc_root)/'meminfo').open('rb') as file:memory=file.read(4097)
        if len(memory)>4096:plan['memory']['status']='SIZE_LIMIT'
        else:
            for key in ('MemTotal','MemAvailable'):
                match=re.search(rb'^'+key.encode()+rb':\s+(\d+) kB$',memory,re.M)
                if match:plan['memory'][key+'_bytes']=int(match.group(1))*1024
            plan['memory']['status']='READ' if all(plan['memory'][k+'_bytes'] is not None for k in ('MemTotal','MemAvailable')) else 'INCOMPLETE'
    except OSError as error:plan['memory'].update(safe_read_error(error))
    inventory=bounded_inventory(root,limit=64);plan['release_inventory']=inventory
    paths=[(e['name'],root/e['name']) for e in inventory.get('entries',[]) if e.get('kind')=='directory' and re.fullmatch('[a-f0-9]{40}',e['name'])]
    plan['processes']=storage_processes(root,proc_root=proc_root,deadline=deadline)
    plan['backup_inventory']=bounded_inventory(backups,limit=512)
    verify_paths=[]
    try:
        with os.scandir(backups) as entries:
            for index,entry in enumerate(entries):
                if index>=512 or time.monotonic()>=deadline:break
                if re.fullmatch(r'\.remote-verify-[A-Za-z0-9_-]{1,64}',entry.name) and entry.is_dir(follow_symlinks=False):verify_paths.append(('backup-temp-'+sha(entry.name.encode())[:16],Path(entry.path)))
    except OSError:pass
    plan['release_trees']=storage_walk(paths,root=root,seconds=min(walk_seconds,max(0,deadline-time.monotonic())))
    # Temporary verification dirs contain only named snapshot/cipher artifacts;
    # metadata recursion is independently shallow and cannot consume another12s.
    remaining_walk=max(0,walk_seconds-plan['release_trees']['elapsed_seconds'])
    plan['backup_temporary_trees']=storage_walk(verify_paths,root=root,seconds=min(remaining_walk,max(0,deadline-time.monotonic())),max_entries=max(0,150000-plan['release_trees']['entries_examined']),max_depth=2)
    graph_deadline=min(deadline,time.monotonic()+12)
    graph=storage_git_graph(paths,root=root,run=run,deadline=graph_deadline);plan['release_graph']=graph
    current=storage_reference(out.get('current',''),root);active=storage_reference(obj(out.get('process')).get('cwd',''),root)
    protected=collections.defaultdict(set)
    if current['release']:protected[current['release']].add('CURRENT_SYMLINK_TARGET')
    if active['release']:protected[active['release']].add('ACTIVE_WORKER_CWD')
    for p in plan['processes']['references']:protected[p['release']].add('PROCESS_CWD_REFERENCE')
    edges=[]
    for name,g in graph.items():
        for ref in g['git_links']+g['alternates']+obj(g.get('node_modules')).get('chain',[])+([obj(g.get('node_modules')).get('final')] if obj(g.get('node_modules')).get('final') else []):
            if ref.get('release') and ref['release']!=name:edges.append((name,ref['release'],'SHARED_GIT_OR_DEPENDENCY'))
    for edge in plan['release_trees']['symlink_edges']:
        if edge['target']['release'] and edge['owner']!=edge['target']['release']:edges.append((edge['owner'],edge['target']['release'],'TREE_SYMLINK_DEPENDENCY'))
    changed=True
    while changed:
        changed=False
        for src,dst,reason in edges:
            if src in protected and reason not in protected[dst]:protected[dst].add(reason);changed=True
    incoming=collections.defaultdict(set)
    for src,dst,reason in edges:incoming[dst].add(src)
    plan['protected_releases']={name:sorted(reasons) for name,reasons in protected.items()}
    plan['incoming_dependencies']={name:sorted(refs) for name,refs in incoming.items()}
    plan['git_status']={}
    measured=plan['release_trees']['trees']
    candidates=sorted((name for name,path in paths if name not in protected and measured.get(name,{}).get('complete')),key=lambda name:measured[name]['reported_allocated_bytes'],reverse=True)[:5]
    for name in candidates:
        remaining=graph_deadline-time.monotonic()
        if remaining<=0:plan['git_status'][name]={'status':'STATUS_BUDGET_EXHAUSTED','clean_tracked':None};continue
        plan['git_status'][name]=storage_git_status(root/name,run=run,timeout=min(2,remaining))
    plan['blockers']=['ROLLBACK_RETENTION_UNVERIFIED','NO_VERIFIED_CLEANUP_SET']
    if any(g.get('status')!='READ' or g.get('alternates_status') not in ('READ','ABSENT') or obj(g.get('node_modules')).get('status') not in ('READ','ABSENT') for g in graph.values()):plan['blockers'].append('DEPENDENCY_GRAPH_INCOMPLETE')
    if not plan['processes']['complete']:plan['blockers'].append('PROCESS_REFERENCES_UNVERIFIED')
    if not inventory.get('complete') or not plan['release_trees']['complete']:plan['blockers'].append('RELEASE_MEASUREMENT_INCOMPLETE')
    if not plan['backup_inventory'].get('complete') or not plan['backup_temporary_trees']['complete']:plan['blockers'].append('BACKUP_INVENTORY_INCOMPLETE')
    if any(name not in plan['git_status'] or plan['git_status'][name].get('status')!='READ' for name in measured if name not in protected):plan['blockers'].append('MISSING_CLEAN_TREE_CHECK_FOR_OTHER_RELEASES')
    plan['elapsed_seconds']=round(time.monotonic()-started,3)
    plan['status']='READ_WITH_EXPLICIT_GATES';plan['identity_not_backup']=True
    out['collection_warnings']=[{'section':'storage_plan','code':code} for code in plan['blockers']]
    out['diagnostic_status']='DEGRADED'
    return out


def receipt_status(remote):
    if remote.get('mode')=='STORAGE_PLAN':
        valid=not remote.get('error') and obj(remote.get('storage_plan')).get('status')=='READ_WITH_EXPLICIT_GATES' and remote.get('same_process_after_read') is True
        return 'COLLECTED_WITH_READ_GAPS' if valid else 'REMOTE_READ_INCOMPLETE'
    sql=obj(obj(remote.get('capacity')).get('database')) if remote.get('mode')=='CAPACITY' else obj(remote.get('paper'))
    valid=not remote.get('error') and sql.get('consistent_read_transaction') is True and remote.get('same_process_after_read') is True
    if not valid:return 'REMOTE_READ_INCOMPLETE'
    return 'COLLECTED_WITH_READ_GAPS' if remote.get('collection_warnings') else 'COLLECTED_WITH_DECLARED_LIMITS'


def collect_runtime_identity(out):
    props=['LoadState','ActiveState','SubState','MainPID','ExecMainStartTimestamp','InvocationID','NRestarts','MemoryCurrent','MemoryMax','TasksCurrent','TasksMax']
    service=dict(line.split('=',1) for line in command(['systemctl','show',SERVICE,'--property='+','.join(props)]).splitlines() if '=' in line)
    out['service']=service;pid=int(service['MainPID']);proc=Path('/proc')/str(pid)
    args=(proc/'cmdline').read_bytes()[:16384].split(b'\0')
    if service['ActiveState']!='active' or not any(a==b'scripts/trading-worker.mjs' or a.endswith(b'/scripts/trading-worker.mjs') for a in args):raise RuntimeError('SERVICE_IDENTITY_NOT_CONFIRMED')
    release=Path(os.readlink(proc/'cwd')).resolve()
    if not release.is_relative_to('/opt/lumi-trading/releases'):raise RuntimeError('RELEASE_PATH_UNEXPECTED')
    out['process']={'pid':pid,'cwd':str(release),'exe':os.readlink(proc/'exe'),'start_ticks':int((proc/'stat').read_text().rsplit(')',1)[1].split()[19])}
    out['current']=str(Path('/opt/lumi-trading/current').resolve())
    out['disk_commit']=command(['git','-C',str(release),'rev-parse','HEAD'])
    files=['scripts/trading-worker.mjs','package.json','package-lock.json','lib/trading/sqlite-store.js','lib/trading/secondary-futures.js','lib/trading/secondary-futures-engine.js','lib/trading/secondary-futures-runtime.js','lib/trading/secondary-evaluation-metrics.js','lib/trading/secondary-shadow-runtime.js','lib/trading/secondary-profit-protection.js','lib/trading/dashboard-publisher.js','deploy/trading/worker-release-manifest.json']
    out['disk_files']={}
    for name in files:
        file=release/name
        if not file.exists():out['disk_files'][name]={'present':False};continue
        if not file.resolve().is_relative_to(release) or file.stat().st_size>4194304:raise RuntimeError('SOURCE_FILE_BOUNDARY')
        before=file.stat();digest=sha(file.read_bytes());after=file.stat()
        out['disk_files'][name]={'sha256':digest,'bytes':after.st_size,'mtime_ns':after.st_mtime_ns,'stable':(before.st_size,before.st_mtime_ns)==(after.st_size,after.st_mtime_ns)}
    return pid,service['InvocationID']


def remote(*,capacity=False,storage=False):
    out={'version':VERSION,'started_at_utc':stamp(utc()),'actions':'READ_ONLY_NO_WORKER_IMPORT_NO_BACKUP_NO_ENV_FILES','loaded_runtime_commit':'NOT_VERIFIED'}
    if capacity:out['mode']='CAPACITY'
    if storage:out['mode']='STORAGE_PLAN'
    try:
        pid,invocation=collect_runtime_identity(out)
        try:
            if storage:collect_storage_plan(out,pid,invocation)
            elif capacity:collect_capacity_diagnostics(out,pid,invocation)
            else:collect_runtime_diagnostics(out,pid,invocation)
        finally:
            try:
                final=dict(line.split('=',1) for line in command(['systemctl','show',SERVICE,'--property=MainPID,InvocationID']).splitlines() if '=' in line)
                out['same_process_after_read']=final.get('MainPID')==str(pid) and final.get('InvocationID')==invocation
            except Exception as error:
                out['same_process_after_read']=None;out['final_process_check']={'status':'READ_FAILED','type':type(error).__name__}
            if out.get('same_process_after_read') is not True:
                out.setdefault('collection_warnings',[]).append({'section':'process','code':'PROCESS_STABILITY_NOT_CONFIRMED'});out['diagnostic_status']='DEGRADED'
    except Exception as error:out['error']={'type':type(error).__name__,'code':str(error) if isinstance(error,RuntimeError) else 'HOST_READ_FAILED'}
    out['finished_at_utc']=stamp(utc())
    emit_remote(out)


def emit_remote(out):
    raw=json.dumps(out,separators=(',',':')).encode();blob=base64.b64encode(zlib.compress(raw,9)).decode()
    if len(blob)>22000:
        # Preserve the summary but explicitly report omitted detail; never truncate JSON.
        out.get('paper',{}).pop('closures_15m_1h',None);out['transport_detail_omission']='SSM_OUTPUT_BUDGET';raw=json.dumps(out,separators=(',',':')).encode();blob=base64.b64encode(zlib.compress(raw,9)).decode()
    if len(blob)>22000 and out.get('mode')=='STORAGE_PLAN':
        plan=out['storage_plan'];omissions=[]
        for key in ('release_inventory','backup_inventory'):
            data=plan.get(key,{})
            if len(data.get('entries',[]))>40:
                entries=data['entries'];data['entries']=sorted(entries,key=lambda e:e.get('allocated_bytes',0),reverse=True)[:40]
                omissions.append({'section':key,'omitted_entries':len(entries)-40});data['transport_details_complete']=False
        trees=plan.get('release_trees',{})
        if len(trees.get('symlink_edges',[]))>40:
            omissions.append({'section':'symlink_edges','omitted_edges':len(trees['symlink_edges'])-40});trees['symlink_edges']=trees['symlink_edges'][:40];trees['transport_details_complete']=False
        plan['transport_omissions']=omissions;plan.setdefault('blockers',[]).append('TRANSPORT_DETAILS_INCOMPLETE')
        out.setdefault('collection_warnings',[]).append({'section':'transport','code':'TRANSPORT_DETAILS_INCOMPLETE'})
        raw=json.dumps(out,separators=(',',':')).encode();blob=base64.b64encode(zlib.compress(raw,9)).decode()
    if len(blob)>22000:raise RuntimeError('SSM_OUTPUT_BUDGET_EXCEEDED')
    print(PREFIX+' '+sha(raw)+' '+blob)


def aws(*args):
    run=subprocess.run(['aws',*args,'--region',REGION,'--output','json','--no-cli-pager'],capture_output=True,text=True,timeout=35,env={**os.environ,'AWS_PAGER':'','AWS_CLI_AUTO_PROMPT':'off'})
    if run.returncode:
        # API error code only; never print an identity, URL, session or raw stderr.
        match=re.search(r'An error occurred \(([^)]+)\)',run.stderr)
        raise RuntimeError('AWS_'+args[0]+'_'+args[1]+': '+(match.group(1) if match else 'EXIT_'+str(run.returncode)))
    return json.loads(run.stdout)


def recovery_heads(*,reader=None):
    """Exactly three HEADs, no download/list/put and no arbitrary metadata export."""
    reader=reader or aws;out=[]
    for slot in range(3):
        key='recovery/daily-'+str(slot)+'.lumi-gcm'
        result={'key':key,'queried_at_utc':stamp(utc()),'status':'UNAVAILABLE','scope':'HEAD_METADATA_NOT_CONTENT_OR_RESTORE_VERIFICATION'}
        try:
            response=reader('s3api','head-object','--bucket',RECOVERY_BUCKET,'--key',key,'--expected-bucket-owner',ACCOUNT,
                '--query','{bytes:ContentLength,modified_at:LastModified,revision:Metadata.revision,source_size:Metadata.source_size,source_mtime_ms:Metadata.source_mtime_ms,sha256:Metadata.sha256}')
            result['status']='READ';result['fields']={}
            for name in ('bytes','revision','source_size','source_mtime_ms'):
                value=response.get(name)
                result['fields'][name]=int(value) if not isinstance(value,bool) and re.fullmatch(r'\d{1,20}',str(value)) else None
            digest=response.get('sha256');result['fields']['sha256']=digest if re.fullmatch(r'[a-f0-9]{64}',str(digest)) else None
            date=response.get('modified_at');result['fields']['modified_at']=date if isinstance(date,str) and re.fullmatch(r'[0-9T:.+Z -]{10,40}',date) else None
        except RuntimeError as error:
            result['status']='READ_FAILED';match=re.fullmatch(r'AWS_s3api_head-object: ([A-Za-z0-9_]{1,80})',str(error))
            result['error_code']=match.group(1) if match else 'UNCLASSIFIED_HEAD_ERROR'
        except Exception as error:result.update(status='READ_FAILED',error_type=type(error).__name__)
        out.append(result)
    return out


def storage_volume_metadata(*,reader=None):
    reader=reader or aws;out={'queried_at_utc':stamp(utc()),'status':'UNAVAILABLE','scope':'READ_ONLY_CURRENT_ROOT_BLOCK_MAPPING_AND_VOLUME_PROPERTIES; NO_MODIFICATION_OR_PRICE_APPROVAL'}
    try:
        rows=reader('ec2','describe-instances','--instance-ids',INSTANCE,'--query','Reservations[].Instances[].{id:InstanceId,root_device:RootDeviceName,root_type:RootDeviceType,mapping:BlockDeviceMappings[].{device:DeviceName,volume:Ebs.VolumeId,status:Ebs.Status}}')
        if not isinstance(rows,list) or len(rows)!=1 or rows[0].get('id')!=INSTANCE:raise RuntimeError('INSTANCE_MAPPING_NOT_CONFIRMED')
        source=rows[0];root=source.get('root_device');kind=source.get('root_type')
        if not isinstance(root,str) or not re.fullmatch(r'/dev/[A-Za-z0-9/_-]{1,64}',root):raise RuntimeError('ROOT_DEVICE_INVALID')
        out['root_device']=root;out['root_type']=kind if kind in ('ebs','instance-store') else None
        mapping=source.get('mapping')
        if not isinstance(mapping,list) or len(mapping)>8:raise RuntimeError('BLOCK_MAPPING_LIMIT_OR_TYPE')
        selected=[m for m in mapping if m.get('device')==root and re.fullmatch(r'vol-[a-f0-9]{8,17}',str(m.get('volume','')))]
        if len(selected)!=1:raise RuntimeError('ROOT_VOLUME_NOT_IDENTIFIED')
        volume=selected[0]['volume'];out['root_volume_id']=volume
        values=reader('ec2','describe-volumes','--volume-ids',volume,'--query','Volumes[].{id:VolumeId,size_gib:Size,type:VolumeType,state:State,encrypted:Encrypted,attachments:Attachments[].{instance:InstanceId,device:Device,state:State}}')
        if not isinstance(values,list) or len(values)!=1 or values[0].get('id')!=volume:raise RuntimeError('VOLUME_NOT_CONFIRMED')
        v=values[0];matches=[a for a in v.get('attachments',[]) if a.get('instance')==INSTANCE and a.get('device')==root and a.get('state')=='attached']
        if len(matches)!=1:raise RuntimeError('ROOT_VOLUME_ATTACHMENT_NOT_CONFIRMED')
        out['volume']={'id':volume,'size_gib':v.get('size_gib') if isinstance(v.get('size_gib'),int) and not isinstance(v.get('size_gib'),bool) and v['size_gib']>0 else None,'type':v.get('type') if v.get('type') in ('standard','io1','io2','gp2','gp3','sc1','st1') else None,'state':v.get('state') if v.get('state') in ('creating','available','in-use','deleting','deleted','error') else None,'encrypted':v.get('encrypted') if isinstance(v.get('encrypted'),bool) else None,'expected_instance_attachment':'attached'}
        out['status']='READ'
    except RuntimeError as error:
        out['status']='READ_FAILED';text=str(error);match=re.fullmatch(r'AWS_ec2_(describe-instances|describe-volumes): ([A-Za-z0-9_]{1,80})',text)
        known={'INSTANCE_MAPPING_NOT_CONFIRMED','ROOT_DEVICE_INVALID','BLOCK_MAPPING_LIMIT_OR_TYPE','ROOT_VOLUME_NOT_IDENTIFIED','VOLUME_NOT_CONFIRMED','ROOT_VOLUME_ATTACHMENT_NOT_CONFIRMED'}
        out['error_code']=match.group(2) if match else text if text in known else 'UNCLASSIFIED_VOLUME_READ_ERROR'
    except Exception as error:out.update(status='READ_FAILED',error_type=type(error).__name__)
    return out


def remote_command(*,capacity=False,storage=False):
    code="import base64,zlib;exec(compile(zlib.decompress(base64.b64decode('"+base64.b64encode(zlib.compress(Path(__file__).read_bytes(),9)).decode()+"')),'<lumi-stage0>','exec'))"
    cmd='python3 -I -B -c '+shlex.quote(code)+' --remote'+(' --storage-plan' if storage else ' --capacity' if capacity else '')
    if len(cmd.encode())>MAX_REMOTE_COMMAND_BYTES:raise RuntimeError('REMOTE_COMMAND_SIZE_LIMIT_NO_COMMAND_SENT')
    return cmd


def cloudshell(*,capacity=False,storage=False):
    os.umask(0o077);now=utc();out={'version':VERSION,'client_utc':stamp(now),'collector_sha256':sha(Path(__file__).read_bytes())}
    destination=Path.cwd()/(('lumi-espacio-' if storage else 'lumi-capacidad-' if capacity else 'lumi-etapa0-')+now.strftime('%Y%m%dT%H%M%SZ')+'.json')
    if capacity:out['mode']='CAPACITY'
    if storage:out['mode']='STORAGE_PLAN'
    try:
        if not shutil.which('aws'):raise RuntimeError('RUN_INSIDE_AUTHORIZED_AWS_CLOUDSHELL')
        identity=aws('sts','get-caller-identity');out['account']=identity.get('Account')
        if out['account']!=ACCOUNT:raise RuntimeError('ACCOUNT_DIFFERS_FROM_PREVIOUS_CONFIRMED_ACCOUNT_NO_COMMAND_SENT')
        target=aws('ec2','describe-instances','--instance-ids',INSTANCE,'--query','Reservations[].Instances[].{id:InstanceId,state:State.Name,zone:Placement.AvailabilityZone}')
        out['target']=target
        if len(target)!=1 or target[0].get('id')!=INSTANCE or target[0].get('state')!='running':raise RuntimeError('TARGET_NOT_CONFIRMED_RUNNING')
        info=aws('ssm','describe-instance-information','--filters','Key=InstanceIds,Values='+INSTANCE,'--query','InstanceInformationList[].{id:InstanceId,ping:PingStatus}')
        if len(info)!=1 or info[0].get('ping')!='Online':raise RuntimeError('SSM_NOT_CONFIRMED_ONLINE')
        cmd=remote_command(capacity=capacity,storage=storage);out['remote_command_bytes']=len(cmd.encode())
        result=aws('ssm','send-command','--instance-ids',INSTANCE,'--document-name','AWS-RunShellScript','--comment','Lumi stage0 bounded read-only diagnosis','--timeout-seconds','90','--parameters',json.dumps({'commands':[cmd],'executionTimeout':['60']}))
        cid=result['Command']['CommandId'];out['command_id']=cid;print('CommandId:',cid,flush=True)
        until=time.monotonic()+100;result={}
        while time.monotonic()<until:
            time.sleep(2)
            try:result=aws('ssm','get-command-invocation','--command-id',cid,'--instance-id',INSTANCE)
            except RuntimeError as error:
                if 'InvocationDoesNotExist' in str(error):continue
                raise
            if result.get('Status') not in ('Pending','InProgress','Delayed'):break
        out['ssm_status']=result.get('Status');out['response_code']=result.get('ResponseCode')
        if result.get('Status')!='Success':raise RuntimeError('SSM_NOT_SUCCESS_KEEP_COMMAND_ID_DO_NOT_DUPLICATE_PENDING')
        line=next((v for v in result.get('StandardOutputContent','').splitlines() if v.startswith(PREFIX+' ')),None)
        if not line:raise RuntimeError('REMOTE_RECEIPT_MISSING')
        _,digest,encoded=line.split(' ',2);raw=zlib.decompress(base64.b64decode(encoded,validate=True))
        if sha(raw)!=digest:raise RuntimeError('REMOTE_RECEIPT_CHECKSUM_MISMATCH')
        out['remote']=json.loads(raw);out['remote_sha256']=digest
        out['status']=receipt_status(out['remote'])
        if capacity:
            out['recovery_s3_heads']=recovery_heads()
            if any(v['status']!='READ' for v in out['recovery_s3_heads']) and out['status']=='COLLECTED_WITH_DECLARED_LIMITS':out['status']='COLLECTED_WITH_READ_GAPS'
        if storage:out['root_volume']=storage_volume_metadata()
    except Exception as error:out['status']='ACCESS_OR_READ_INCOMPLETE';out['error']={'type':type(error).__name__,'code':str(error) if isinstance(error,RuntimeError) else 'CLIENT_READ_FAILED'}
    with destination.open('x') as file:json.dump(out,file,ensure_ascii=False,indent=2)
    print('Estado:',out['status']);print('Archivo privado para devolver:',destination.name);print('SHA256:',sha(destination.read_bytes()))
    if out.get('error'):print(out['error']['code'])
    print('CloudShell > Actions > Download file:',destination)
    return 0 if out['status'] in ('COLLECTED_WITH_DECLARED_LIMITS','COLLECTED_WITH_READ_GAPS') else 2

if __name__=='__main__':
    if sys.argv[1:]==['--remote']:remote()
    elif sys.argv[1:]==['--remote','--capacity']:remote(capacity=True)
    elif sys.argv[1:]==['--remote','--storage-plan']:remote(storage=True)
    elif sys.argv[1:]==['--capacity']:raise SystemExit(cloudshell(capacity=True))
    elif sys.argv[1:]==['--storage-plan']:raise SystemExit(cloudshell(storage=True))
    elif not sys.argv[1:]:raise SystemExit(cloudshell())
    else:raise SystemExit('CloudShell: python3 lumi_etapa0.py [--capacity|--storage-plan]')
