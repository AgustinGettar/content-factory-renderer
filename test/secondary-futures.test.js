// Offline regressions. No real exchange request, Telegram message or production DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D,hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {SecondaryBroker,OperationalSecondary,secondaryCandidates,secondaryEconomics,initializeSecondary,secondaryEstimate,SECONDARY_VERSION,SECONDARY_MODEL,SECONDARY_PROTOCOL} from '../lib/trading/secondary-futures.js';
import {installOperational,attachOperationalProjection,SecondaryNotifier,secondaryMessage} from '../lib/trading/secondary-futures-runtime.js';
import {acceptControl,checkControls,settleControl} from '../lib/trading/paper-controls.js';
import {exitEstimate} from '../lib/trading/paper-exits.js';
const T=Date.parse('2026-11-01T18:00:02Z'),H=Math.floor(T/3600000)*3600000;
const q=(at=T,bid=100)=>({source:'KRAKEN_FUTURES_WS_TICKER',symbol:'PF_XBTUSD',event_at:at,received_at:at,bid:String(bid),ask:String(bid+0.01),bid_qty:'100',ask_qty:'100',suspended:false});
const metadata={qty_step:0.0001,tick_size:0.01,checked_at:T};
function root(){const a=newAccount();enablePortfolio(a);Object.assign(a,{cash:'470.4596514385377772',equity:'470.4596514385377772',net:'-30.2792022853160724',fees:'21.6195028217600724',closed:12,wins:0,losses:12,peak:'500',maxDrawdown:'0.05908'});return {schema:11,frequency:{account:a,counts:{evaluations:0,candidates:0,selected:41,filled:12,closed:12,notFilled:29,suppressed:31},grossClosed:'-8.659699463556',closedFees:'21.6195028217600724',daySelections:7,selectionDay:'2026-11-01',history:[{type:'CLOSED',id:'legacy-loss',pnl:'-5'}]},laboratory:{status:'RESEARCH_COMPLETE',active:'old-rejected',trials:[{status:'REJECTED',net:-24}]},multiStrategy:{version:'old-shadow',accounts:{BREAKOUT:{net:0}}},research:{active:'primary',versions:{primary:{account:{equity:'100',net:'0'}}}},exitManagement:{},controls:{receipts:[]}};}
function fixture(){let now=T;const r=root(),events=[],notices=[],b=new SecondaryBroker({root:r,now:()=>now,event:e=>{events.push(e);settleControl(r,e);},notice:(...a)=>notices.push(a)});return {r,b,events,notices,time(v){now=v;},now:()=>now};}
function plan(id='p1',pattern='BREAKOUT',direction='LONG'){const sign=direction==='LONG'?1:-1,entry=100,stop=entry-sign,target=entry+3*sign;return {id,version:SECONDARY_VERSION,execution_model:SECONDARY_MODEL,instrument:'PAPER:KRAKEN_FUTURES:PF_XBTUSD',family:'L',pattern,recipe:pattern,recipe_title:pattern,direction,timeframe:5,entry:String(entry),limit:String(entry),stop:String(stop),target:String(target),confirmed_at:T-2000,decision_at:T,expires_at:T+120000,holding_ms:1800000,order:'FUTURES_POST_ONLY_LIMIT',fill_model:'OBSERVED_TRADE_THROUGH_20X',economics:secondaryEconomics(entry,stop,target,direction,0)};}
function open(h,p=plan()){
 const start=p.direction==='SHORT'?q(T,99.99):q();assert.equal(h.b.choose(p,start,metadata,T),'ENTRY_PENDING');
 h.time(T+1100);h.b.market({...start,event_at:T+1100,received_at:T+1100},null,{[H]:0},T+1100);
 const short=p.direction==='SHORT';h.time(T+2200);const market=q(T+2200,short?100.01:99.98),trade={id:'trade',side:short?'buy':'sell',price:short?100.02:99.99,qty:100,event_at:T+2200,received_at:T+2200};h.b.market(market,trade,{[H]:0},T+2200);assert(h.b.a.positions[p.id]);return h.b.a.positions[p.id];
}
test('migration is flat-only, idempotent and preserves real secondary and every legacy record',()=>{
 const r=root(),before=structuredClone(r),events=[];const x=initializeSecondary(r,T,e=>events.push(e));assert.equal(x.status,'ACTIVE_PAPER');delete r.secondaryExecution;assert.deepEqual(r,before);r.secondaryExecution=x;assert.equal(initializeSecondary(r,T+1),x);assert.equal(events.length,1);assert.equal(events[0].capital_added,'0');
 const busy=root();busy.frequency.account.pending={plan:{}};assert.throws(()=>initializeSecondary(busy,T),/FLAT/);
 const altered=structuredClone(r);altered.secondaryExecution.protocol.makerFee='0';assert.throws(()=>initializeSecondary(altered,T),/PROTOCOL_MISMATCH/);
});
test('entries share one cash ledger and risk, reject opposites, duplicate and concentrated signals',()=>{
 const h=fixture();assert.equal(h.b.choose(plan(),q(),metadata,T),'ENTRY_PENDING');assert.equal(h.b.choose(plan(),q(),metadata,T),'DUPLICATE_SIGNAL');assert.equal(h.b.choose(plan('p2','PULLBACK','SHORT'),q(),metadata,T),'OPPOSITE_BTC_EXPOSURE');assert.equal(h.b.choose(plan('p2','PULLBACK'),q(),metadata,T),'ENTRY_PENDING');assert.equal(h.b.choose(plan('p3','RANGE_REENTRY'),q(),metadata,T),'PORTFOLIO_CAPACITY');
 const a=h.b.a,orders=Object.values(a.pendingOrders);assert(D(a.cash).eq('470.4596514385377772'));assert(orders.reduce((s,o)=>s+Number(o.plan.sizing.risk),0)<=Number(a.equity)*0.01+1e-9);assert(orders.reduce((s,o)=>s+Number(o.plan.sizing.reserved),0)<Number(a.cash));assert.equal(h.r.frequency.daySelections,9);assert.equal(h.notices.length,0);
});
test('maker selection is not a fill; touching, insufficient volume, old or wrong-side trades cannot fill',()=>{
 const h=fixture();h.b.choose(plan(),q(),metadata,T);h.time(T+1100);h.b.market(q(T+1100),null,{[H]:0},T+1100);const size=Number(h.b.a.pendingOrders.p1.plan.sizing.qty);
 for(const [i,price,qty,side,event_at] of [[1,100,100,'sell',T+2000],[2,99.99,size*19,'sell',T+3000],[3,99.99,100,'buy',T+4000],[4,99.99,100,'sell',T]]){
  const at=T+1100+i*1000;h.time(at);h.b.market(q(at,99.98),{price,qty,side,event_at,received_at:at},{[H]:0},at);assert.equal(Object.keys(h.b.a.positions).length,0);
 }
});
for(const direction of ['LONG','SHORT'])test(direction+' fill and close conserve cash, costs and history',()=>{
 const h=fixture(),cash=D(h.b.a.cash),oldNet=D(h.b.a.net),oldFees=D(h.b.a.fees),p=open(h,plan('p1','BREAKOUT',direction));assert.equal(h.events.filter(e=>e.type==='FILLED').length,1);assert.equal(h.notices[0][0],'SECONDARY_OPEN');
 const at=T+3300,price=direction==='LONG'?104:96;h.time(at);h.b.market(q(at,price),null,{[H]:0},at);assert.equal(Object.keys(h.b.a.positions).length,0);const e=h.events.find(e=>e.type==='CLOSED');assert(e);assert.equal(e.reason,'NET_TARGET');assert(D(e.pnl).gt(0));assert(D(h.b.a.cash).minus(cash).eq(e.pnl));assert(D(h.b.a.net).minus(oldNet).eq(e.pnl));assert(D(h.b.a.fees).minus(oldFees).eq(e.fees));assert.equal(h.b.a.closed,13);assert.equal(h.b.a.wins,1);assert.equal(h.r.frequency.history.at(-1).id,'legacy-loss');assert.equal(h.notices.at(-1)[0],'SECONDARY_CLOSE');
 h.b.market(q(at,price),null,{[H]:0},at);assert.equal(h.events.filter(e=>e.type==='CLOSED').length,1);
});
test('spot quotes cannot value or settle a futures position',()=>{
 const h=fixture(),p=open(h),before=h.b.a.cash;const at=T+3000,spot={...q(at,1),source:'KRAKEN_WS_V2_BBO'};h.b.market(spot,null,{[H]:0},at);assert(h.b.a.positions.p1);assert.equal(h.b.a.cash,before);
 const v=exitEstimate(p,spot,at);assert(v&&Number(v.quote_price)>99);assert.equal(v.model,'PF_XBTUSD_FUTURES_OBSERVED_BBO');
});
test('gaps close at the next observed quote, never a fabricated stop; funding is signed',()=>{
 const h=fixture(),p=open(h);h.time(T+3300);h.b.market(q(T+3300,100.2),null,{[H]:0.2},T+3300);assert(D(p.accrued_funding).gt(0));h.time(T+20000);h.b.market(q(T+3300),null,{[H]:0.2},T+20000);assert(h.b.a.positions.p1);h.time(T+21000);h.b.market(q(T+21000,100.2),null,{[H]:0.2},T+21000);const e=h.events.find(e=>e.type==='CLOSED');assert.equal(e.reason,'DATA_GAP_CLOSE');assert.equal(e.quality,'FUTURES_DATA_GAP');assert(Number(e.price)>100);assert.notEqual(e.price,'99');
 const short=fixture(),p2=open(short,plan('p1','BREAKOUT','SHORT'));short.time(T+3300);short.b.market(q(T+3300,100),null,{[H]:0.2},T+3300);assert(D(p2.accrued_funding).lt(0));
});
test('normal stop, pending expiry and time exits do not become hidden holds',()=>{
 const stop=fixture();open(stop);stop.time(T+3300);stop.b.market(q(T+3300,98.9),null,{[H]:0},T+3300);assert.equal(stop.events.find(e=>e.type==='CLOSED').reason,'STOP');
 const expire=fixture();expire.b.choose(plan(),q(),metadata,T);expire.time(T+120001);expire.b.market(q(T+120001),null,{[H]:0},T+120001);assert.equal(expire.events.find(e=>e.type==='NOT_FILLED').reason,'VENCIDA');
 const timeout=fixture(),p=open(timeout),at=p.expires_at;timeout.b.x.last_quote_at=at-1000;timeout.time(at);timeout.b.market(q(at,100),null,{[Math.floor(at/3600000)*3600000]:0,[H]:0},at);assert.equal(timeout.events.find(e=>e.type==='CLOSED').reason,'TIMEOUT');
});
test('manual close and lower net goal use fresh futures prices and durable control receipts',()=>{
 const h=fixture(),p=open(h),at=T+3000,id='12345678-1234-1234-1234-123456789012';
 const command={id,created_at:at,expires_at:at+60000,operation_id:p.plan.id,ledger:'FREQUENT_PAPER',plan_hash:p.plan.hash,action:'SET_NET_GOAL',net_goal:'0.10'};assert.equal(acceptControl(h.r,command,at,e=>h.events.push(e)).status,'APPLIED');
 const close={...command,id:'22345678-1234-1234-1234-123456789012',action:'CLOSE',mode:'ANY'};assert.equal(acceptControl(h.r,close,at,e=>h.events.push(e)).status,'WAITING_MARKET');h.time(at+1100);h.b.market(q(at+1100,100),null,{[H]:0},at+1100);assert.equal(h.events.find(e=>e.type==='CLOSED').reason,'MANUAL_CLOSE');assert.equal(h.r.controls.receipts.at(-1).status,'CLOSED');
});
test('drawdown, daily budget and loss streak are not bypassed to obtain more entries',()=>{
 for(const prepare of [h=>h.b.x.status='HALTED_DRAWDOWN',h=>h.b.a.halted=true,h=>h.b.x.cooldown_until=T+10000,h=>h.b.x.day_start='500']){
  const h=fixture();prepare(h);assert.notEqual(h.b.choose(plan(),q(),metadata,T),'ENTRY_PENDING');
 }
 const h=fixture();h.r.frequency.daySelections=100;assert.equal(h.b.choose(plan(),q(),metadata,T),'ENTRY_PENDING');
});
function series(){const cutoff=T-2000,b=Array.from({length:96},(_,i)=>({start:cutoff-(96-i)*300000,end:cutoff-(95-i)*300000,open:199.9,high:200.2,low:199.7,close:199.9,volume:1})),c=Array.from({length:96},(_,i)=>({start:cutoff-(96-i)*900000,end:cutoff-(95-i)*900000,open:190+i*0.1,high:190.4+i*0.1,low:189.8+i*0.1,close:190.2+i*0.1,volume:1}));Object.assign(b.at(-1),{open:199.9,high:200.9,low:199.9,close:200.8,volume:2});return {5:b,15:c};}
test('confirmed breakout creates a genuine better-price pending plan without enlarging its target for costs',()=>{
 const rows=secondaryCandidates(series(),q(T,200.8),metadata,T-2000,T,0);const d=rows.find(x=>x.pattern==='BREAKOUT');assert.equal(d.reason,'CANDIDATE',JSON.stringify(rows));assert(Number(d.plan.entry)<200.8);assert(d.plan.economics.netRR>=1.5);assert(Number(d.plan.target)/Number(d.plan.entry)-1<=0.012);assert.equal(d.plan.expires_at,T+120000);
});
test('future candles and unavailable funding cannot fabricate a candidate',()=>{
 const data=series(),before=secondaryCandidates(data,q(T,200.8),metadata,T-2000,T,0);for(const tf of [5,15])data[tf].push({...data[tf].at(-1),start:T,end:T+tf*60000,close:999999,high:999999});assert.deepEqual(secondaryCandidates(data,q(T,200.8),metadata,T-2000,T,0),before);
 assert(secondaryCandidates(series(),q(),metadata,T-2000,T,NaN).every(x=>x.reason==='FUNDING_NOT_AVAILABLE'));
});
test('wire adapter ignores snapshots and duplicate trade identifiers, preserving the observed market source',()=>{
 const h=fixture(),handlers={},socket={addEventListener:(k,v)=>handlers[k]=v,send(){}},engine={state:h.r,event:e=>h.events.push(e),notice:(...a)=>h.notices.push(a)},r=new OperationalSecondary({engine,now:h.now,socketFactory:()=>socket}).initialize();r.stopped=false;r.connect();
 const emit=x=>handlers.message({data:JSON.stringify(x)}),base={product_id:'PF_XBTUSD',time:T,uid:'unique',side:'sell',price:99.99,qty:100};emit({...base,feed:'trade_snapshot'});assert.equal(r.queue.length,0);emit({...base,feed:'trade'});emit({...base,feed:'trade'});assert.equal(r.queue.length,1);emit({...base,product_id:'OTHER',uid:'other',feed:'trade'});assert.equal(r.queue.length,1);
});
test('real mode or missing flag with migrated state fails closed',()=>{
 assert.throws(()=>installOperational({state:{secondaryExecution:{}}},{}),/FLAG_REQUIRED/);assert.throws(()=>installOperational({}, {LUMI_TRADING_SECONDARY_EXECUTION:SECONDARY_VERSION,LUMI_TRADING_MODE:'LIVE'}),/PAPER_ONLY/);
});
test('durable notification produces an actual receipt once; ambiguous transmission is not retried',async()=>{
 for(const fail of [false,true]){
  let calls=0;const item={id:'status',kind:'SECONDARY_STATUS',status:'QUEUED',payload:{equity:'470.46'}},store={async queued(){return item.status==='QUEUED'?[item]:[];},async tx(x){if(x.phase==='CLAIM'){Object.assign(item,{status:'DISPATCHING',claim_id:x.claim_id});return {...item};}Object.assign(item,x);return {...item};}};
  const env={LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_OWNER_ID:'123',LUMI_TELEGRAM_REVIEW_TEST_USERS:'123'},transport={async call(method){calls++;if(fail)throw Error('NETWORK_AMBIGUOUS');return {message_id:11,chat:{id:123},date:1};}},notifier=new SecondaryNotifier({store,env,transport,feed:{state:{},metadata:{}},pending:()=>false});notifier.identityAt=Date.now();await notifier.drain();assert.equal(item.status,fail?'UNKNOWN':'DELIVERED');await notifier.drain();assert.equal(calls,1);
 }
});
test('operational projection puts current account and active patterns in the usual secondary view',async()=>{
 const h=fixture();h.b.x.market={quote:q(),symbol:'PF_XBTUSD'};let output;const publisher={async send(path,body){output=JSON.parse(body);}},store={row(){return {revision:7,state:h.r};}};attachOperationalProjection(publisher,store);
 await publisher.send('api/aws/live',JSON.stringify({revision:7,frequency:{account:{positions:[]},protocol:{}},laboratory:{status:'RESEARCH_COMPLETE',trials:[]},operations:[]}),7);assert.equal(output.frequency.execution_status,'ACTIVE_PAPER');assert.equal(output.frequency.instrument,'PF_XBTUSD');assert.equal(output.frequency.daily_selection_limit,null);assert.equal(output.laboratory.status,'ACTIVE');assert.equal(output.laboratory.previous_trial_status,'RESEARCH_COMPLETE');assert.equal(output.laboratory.active,SECONDARY_VERSION);
});
