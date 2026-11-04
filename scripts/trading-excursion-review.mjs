#!/usr/bin/env node
// Explicit read-only research on durable futures closes. Not loaded by worker.
import {DatabaseSync} from 'node:sqlite';
import {reviewSecondaryExcursions} from '../lib/trading/secondary-excursion-review.js';
const db=new DatabaseSync('/var/lib/lumi-trading/trading.sqlite',{readOnly:true,timeout:3000});
try{
 const rows=db.prepare("SELECT payload FROM events WHERE kind='CLOSED' ORDER BY rowid ASC").all()
  .map(r=>JSON.parse(r.payload));
 console.log(JSON.stringify(reviewSecondaryExcursions(rows),null,2));
}finally{db.close();}
