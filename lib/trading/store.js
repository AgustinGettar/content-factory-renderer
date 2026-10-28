import {randomUUID} from 'node:crypto';
import {hash} from './core.js';
export class TradingStore {
  constructor(db){this.db=db;this.owner=randomUUID();this.fence=0;this.revision=0;}
  async tx(p){const {data,error}=await this.db.rpc('lumi_trading_tx',{p:{owner:this.owner,fence:this.fence,...p}});if(error)throw Error(/^TRADING_[A-Z_]+$/.test(error.message)?error.message:'TRADING_STORAGE_UNAVAILABLE');return data;}
  async acquire(){const s=await this.tx({phase:'ACQUIRE'});this.fence=s.fence;this.revision=s.revision;return s.state;}
  async renew(){return this.tx({phase:'RENEW'});}
  async commit(state,events=[],notices=[]){const batch=randomUUID(),args={phase:'COMMIT',batch,revision:this.revision,state,events:events.map((e,i)=>({id:hash([batch,i]),kind:e.type,payload:e})),notices};let data;try{data=await this.tx(args);}catch(e){if(e.message!=='TRADING_STORAGE_UNAVAILABLE')throw e;data=await this.tx(args);}this.revision=data.revision;}
  async queued(){const {data,error}=await this.db.from('lumi_trading_outbox').select('*').eq('status','QUEUED').order('created_at').limit(20);if(error)throw Error('TRADING_OUTBOX_UNAVAILABLE');return data;}
  async deliveredSince(at){const {data,error}=await this.db.from('lumi_trading_outbox').select('id,payload,receipt').eq('status','DELIVERED').eq('kind','SIGNAL').gte('finished_at',new Date(at).toISOString()).order('finished_at').limit(100);if(error)throw Error('TRADING_RECEIPTS_UNAVAILABLE');return data;}
  async history(kind,since=0){const rows=[];for(let offset=0;;offset+=1000){const {data,error}=await this.db.from('lumi_trading_events').select('payload').eq('kind',kind).gte('created_at',new Date(since).toISOString()).order('created_at').range(offset,offset+999);if(error)throw Error('TRADING_HISTORY_UNAVAILABLE');rows.push(...data.map(x=>x.payload));if(data.length<1000)break;if(rows.length>100000)throw Error('TRADING_RESEARCH_RESOURCE_LIMIT');}return rows;}
}
