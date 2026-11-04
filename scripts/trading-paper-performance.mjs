#!/usr/bin/env node
// Offline, read-only report. Does not start a worker or open any exchange API.
import {DatabaseSync} from 'node:sqlite';
import {summarizeSecondaryPerformance} from '../lib/trading/secondary-performance-review.js';
const path=process.argv[2]??'/var/lib/lumi-trading/trading.sqlite';
if (!path.startsWith('/') || !path.endsWith('.sqlite')) throw Error('ABSOLUTE_SQLITE_FILE_REQUIRED');
const db=new DatabaseSync(path,{readOnly:true,timeout:3000});
try {
  const events=db.prepare("SELECT payload FROM events WHERE kind='CLOSED' ORDER BY rowid ASC").all()
    .map(x=>JSON.parse(x.payload));
  const result=summarizeSecondaryPerformance(events);
  const row=db.prepare('SELECT revision,updated_at,state FROM state LIMIT 1').get();
  if (!row) throw Error('PAPER_STATE_MISSING');
  const root=JSON.parse(row.state),account=root.frequency?.account;
  if (!account || !root.secondaryExecution || account.halted === undefined) throw Error('PAPER_SECONDARY_ACCOUNT_REQUIRED');
  result.observation={revision:row.revision,state_updated_at:row.updated_at,
    secondary_version:root.secondaryExecution.version,
    account_net_usd:account.net,account_closed_count:account.closed,
    note:'Account ledger is authoritative; CLOSED-event aggregates exclude late funding adjustments and open PnL.'};
  console.log(JSON.stringify(result,null,2));
} finally { db.close(); }
