#!/usr/bin/env python3
"""Private read-only stage-0 receipt. CloudShell: python3 lumi_etapa0.py

Only Python stdlib plus the existing AWS CLI. No worker import, config changes,
backup, environment-file read, Telegram, scheduler or economic write. The remote
SQL uses a single read transaction, indexed bounded queries and a deadline.
"""
import base64, collections, datetime as dt, decimal, hashlib, json, os, re
from pathlib import Path
import shlex, shutil, sqlite3, subprocess, sys, time, zlib

VERSION = 'lumi-stage0-readonly-1.0.0'
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


def dashboard_status(db):
    """Allowlisted publisher metadata in the caller's same read transaction."""
    fields=('at','error','detail_at','detail_error','live_bytes','backup_error')
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
        if key in ('at','detail_at','live_bytes'):
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


def remote():
    out={'version':VERSION,'started_at_utc':stamp(utc()),'actions':'READ_ONLY_NO_WORKER_IMPORT_NO_BACKUP_NO_ENV_FILES','loaded_runtime_commit':'NOT_VERIFIED'}
    try:
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
        out['journal']=[]
        for kind in ('lumi_trading_started','lumi_trading_health'):
            raw=command(['journalctl','--no-pager','-o','json','-u',SERVICE,'_PID='+str(pid),'_SYSTEMD_INVOCATION_ID='+service['InvocationID'],'--grep='+kind,'-n','2'])
            for line in raw.splitlines():
                try:
                    row=json.loads(line);data=json.loads(row.get('MESSAGE',''))
                    if data.get('event')!=kind:continue
                    allowed=pick(data,('event','mode','platform','policy_hash','revision','cpu_fraction','rss_bytes','quote_age_ms','secondary_execution','connected','reconciled','quotes','trades'))
                    identity=obj(data.get('worker_identity'));allowed['worker_identity']=pick(identity,('pid','captured_at','process_started_at_utc_estimate','identity_sha256','lease_owner_sha256','fence','revision','declared_source_commit','manifest_sha256','source_tree_sha256','loaded_source_attested')) if identity else None
                    if identity:allowed['worker_identity']['release']=pick(identity.get('release'),('status','declared_source_commit','manifest_sha256','source_tree_sha256','verification_scope','loaded_source_attested'))
                    perf=obj(data.get('performance'));allowed['performance']={'event_loop':pick(perf.get('event_loop'),('utilization','p95_ms','max_ms')),'stages':{name:pick(obj(perf.get('stages')).get(name),('count','mean_ms','max_ms','p95_ms')) for name in ('tick','checkpoint','publish')}}
                    allowed['queues']=pick(data.get('queues'),('events','notices','market','telegram_busy','telegram_identity_unavailable','detail_busy'))
                    allowed.update(journal_pid=row.get('_PID'),invocation=row.get('_SYSTEMD_INVOCATION_ID'),realtime_us=row.get('__REALTIME_TIMESTAMP'));out['journal'].append(allowed)
                except (ValueError,TypeError):continue
        fs=os.statvfs(Path(DB).parent)
        out['storage']={'available_bytes':fs.f_bavail*fs.f_frsize,'db_bytes':Path(DB).stat().st_size,'wal_bytes':Path(DB+'-wal').stat().st_size if Path(DB+'-wal').exists() else 0}
        out['paper']=read_db()
        final=dict(line.split('=',1) for line in command(['systemctl','show',SERVICE,'--property=MainPID,InvocationID']).splitlines() if '=' in line)
        out['same_process_after_read']=final.get('MainPID')==str(pid) and final.get('InvocationID')==service['InvocationID']
    except Exception as error:out['error']={'type':type(error).__name__,'code':str(error) if isinstance(error,RuntimeError) else 'HOST_READ_FAILED'}
    out['finished_at_utc']=stamp(utc())
    raw=json.dumps(out,separators=(',',':')).encode();blob=base64.b64encode(zlib.compress(raw,9)).decode()
    if len(blob)>22000:
        # Preserve the summary but explicitly report omitted detail; never truncate JSON.
        out.get('paper',{}).pop('closures_15m_1h',None);out['transport_detail_omission']='SSM_OUTPUT_BUDGET';raw=json.dumps(out,separators=(',',':')).encode();blob=base64.b64encode(zlib.compress(raw,9)).decode()
    if len(blob)>22000:raise RuntimeError('SSM_OUTPUT_BUDGET_EXCEEDED')
    print(PREFIX+' '+sha(raw)+' '+blob)


def aws(*args):
    run=subprocess.run(['aws',*args,'--region',REGION,'--output','json','--no-cli-pager'],capture_output=True,text=True,timeout=35,env={**os.environ,'AWS_PAGER':'','AWS_CLI_AUTO_PROMPT':'off'})
    if run.returncode:
        # API error code only; never print an identity, URL, session or raw stderr.
        match=re.search(r'An error occurred \(([^)]+)\)',run.stderr)
        raise RuntimeError('AWS_'+args[0]+'_'+args[1]+': '+(match.group(1) if match else 'EXIT_'+str(run.returncode)))
    return json.loads(run.stdout)


def cloudshell():
    os.umask(0o077);now=utc();out={'version':VERSION,'client_utc':stamp(now),'collector_sha256':sha(Path(__file__).read_bytes())}
    destination=Path.cwd()/('lumi-etapa0-'+now.strftime('%Y%m%dT%H%M%SZ')+'.json')
    try:
        if not shutil.which('aws'):raise RuntimeError('RUN_INSIDE_AUTHORIZED_AWS_CLOUDSHELL')
        identity=aws('sts','get-caller-identity');out['account']=identity.get('Account')
        if out['account']!=ACCOUNT:raise RuntimeError('ACCOUNT_DIFFERS_FROM_PREVIOUS_CONFIRMED_ACCOUNT_NO_COMMAND_SENT')
        target=aws('ec2','describe-instances','--instance-ids',INSTANCE,'--query','Reservations[].Instances[].{id:InstanceId,state:State.Name,zone:Placement.AvailabilityZone}')
        out['target']=target
        if len(target)!=1 or target[0].get('id')!=INSTANCE or target[0].get('state')!='running':raise RuntimeError('TARGET_NOT_CONFIRMED_RUNNING')
        info=aws('ssm','describe-instance-information','--filters','Key=InstanceIds,Values='+INSTANCE,'--query','InstanceInformationList[].{id:InstanceId,ping:PingStatus}')
        if len(info)!=1 or info[0].get('ping')!='Online':raise RuntimeError('SSM_NOT_CONFIRMED_ONLINE')
        code="import base64,zlib;exec(compile(zlib.decompress(base64.b64decode('"+base64.b64encode(zlib.compress(Path(__file__).read_bytes(),9)).decode()+"')),'<lumi-stage0>','exec'))"
        cmd='python3 -I -B -c '+shlex.quote(code)+' --remote'
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
        valid=not out['remote'].get('error') and obj(out['remote'].get('paper')).get('consistent_read_transaction') is True
        out['status']='COLLECTED_WITH_DECLARED_LIMITS' if valid else 'REMOTE_READ_INCOMPLETE'
    except Exception as error:out['status']='ACCESS_OR_READ_INCOMPLETE';out['error']={'type':type(error).__name__,'code':str(error) if isinstance(error,RuntimeError) else 'CLIENT_READ_FAILED'}
    with destination.open('x') as file:json.dump(out,file,ensure_ascii=False,indent=2)
    print('Estado:',out['status']);print('Archivo privado para devolver:',destination.name);print('SHA256:',sha(destination.read_bytes()))
    if out.get('error'):print(out['error']['code'])
    print('CloudShell > Actions > Download file:',destination)
    return 0 if out['status']=='COLLECTED_WITH_DECLARED_LIMITS' else 2

if __name__=='__main__':
    if sys.argv[1:]==['--remote']:remote()
    elif not sys.argv[1:]:raise SystemExit(cloudshell())
    else:raise SystemExit('CloudShell: python3 lumi_etapa0.py (no arguments)')
