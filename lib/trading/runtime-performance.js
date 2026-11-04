import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};
// Only immutable historical rows are cached. Quotes, positions, equity, lease
// and the committed checkpoint are read fresh on every publication.
export class DashboardReadCache{
 constructor(store,{maxBytes=4*1024*1024,maxEntries=16}={}){Object.assign(this,{store,maxBytes,maxEntries});this.cache=new Map();this.bytes=0;this.hits=0;this.misses=0;}
 row(){return this.store.row();}
 get(key,kinds,read){
  if(!this.store.readToken)return read();
  const token=this.store.readToken(kinds),old=this.cache.get(key);
  if(old?.token===token){this.hits++;return old.value;}
  this.misses++;if(old){this.bytes-=old.bytes;this.cache.delete(key);}
  const value=read(),bytes=Buffer.byteLength(JSON.stringify(value));
  if(bytes<=this.maxBytes){
   while(this.cache.size&&(this.bytes+bytes>this.maxBytes||this.cache.size>=this.maxEntries)){const [id,item]=this.cache.entries().next().value;this.bytes-=item.bytes;this.cache.delete(id);}
   this.cache.set(key,{token,value:freeze(value),bytes});this.bytes+=bytes;
  }
  return value;
 }
 latest(kinds,limit,project){return this.get(JSON.stringify([kinds,limit,project?.name]),kinds,()=>{const rows=this.store.latest(kinds,limit);return project?rows.map(project):rows;});}
 notices(limit,project){return this.get('notices:'+limit+':'+project?.name,null,()=>{const rows=this.store.notices(limit);return project?rows.map(project):rows;});}
 status(){return {entries:this.cache.size,serialized_bytes:this.bytes,max_serialized_bytes:this.maxBytes,hits:this.hits,misses:this.misses};}
}
export class RuntimePerformance{
 constructor(){this.samples=new Map();this.delay=monitorEventLoopDelay({resolution:20});this.delay.enable();this.elu=performance.eventLoopUtilization();}
 record(name,ms){if(!Number.isFinite(ms)||ms<0)return;let s=this.samples.get(name);if(!s){if(this.samples.size>=16)return;this.samples.set(name,s={count:0,sum:0,max:0,last:[]});}s.count++;s.sum+=ms;s.max=Math.max(s.max,ms);s.last.push(ms);if(s.last.length>120)s.last.shift();}
 async measure(name,fn){const t=performance.now();try{return await fn();}finally{this.record(name,performance.now()-t);}}
 report(){const elu=performance.eventLoopUtilization(this.elu);this.elu=performance.eventLoopUtilization();const stages=Object.fromEntries([...this.samples].map(([k,s])=>{const a=[...s.last].sort((a,b)=>a-b);return [k,{count:s.count,mean_ms:s.sum/s.count,max_ms:s.max,p95_ms:a[Math.min(a.length-1,Math.floor(a.length*.95))]}];}));this.samples.clear();const loop={utilization:elu.utilization,p95_ms:this.delay.percentile(95)/1e6,max_ms:this.delay.max/1e6};this.delay.reset();return {stages,event_loop:loop};}
 close(){this.delay.disable();}
}
