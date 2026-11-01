import {randomUUID} from 'node:crypto';
import {D,hash} from './core.js';
import {TradingNotifier,PANEL_URL} from './notifier.js';
import {OperationalSecondary,SECONDARY_VERSION,SECONDARY_MODEL,SECONDARY_PROTOCOL,secondaryEstimate,isSecondary} from './secondary-futures.js';
const KINDS=new Set(['SECONDARY_OPEN','SECONDARY_CLOSE','SECONDARY_STATUS']);
const textMoney=x=>D(x??0).toFixed(2);
export function secondaryMessage(n){
 const e=n.payload,p=e.plan,s=p?.sizing,link='\nAbrir Trading: '+PANEL_URL;
 if(n.kind==='SECONDARY_STATUS')return 'Agustín, reanudé la secundaria PAPER con un único saldo compartido de '+textMoney(e.equity)+' USD ficticios. Evalúa ruptura/retesteo, retroceso y reentrada en rango en PF_XBTUSD (Kraken Futures). No reinicié saldos ni borré pérdidas. Las entradas límite necesitan una operación posterior con precio y volumen suficientes; mantiene stop, controles de riesgo y salida máxima a 30 minutos. No son fondos reales ni una garantía de ganancia.'+link;
 if(n.kind==='SECONDARY_OPEN')return `Agustín, abrí una ${p.direction==='SHORT'?'venta en corto':'compra'} simulada en la secundaria.
Kraken Futures · PF_XBTUSD · 5 min / contexto 15 min
${p.recipe_title}
Entrada: ${textMoney(e.price)} USD · ${e.qty} BTC
Exposición: ${textMoney(s.exposure)} USD · margen ${textMoney(s.initial_margin)} USD · ${s.leverage}× ficticio
Stop: ${textMoney(p.stop)} · objetivo: ${textMoney(p.target)} USD
Riesgo previsto: ${textMoney(s.risk)} USD; objetivo neto estimado: ${textMoney(s.target_net)} USD, no garantizado.
Comisión maker de entrada 0,02 %; salida taker 0,05 %, más deslizamiento y financiación. Salida por tiempo: 30 minutos.
Ref. ${e.id.slice(0,8)}`+link;
 if(n.kind==='SECONDARY_CLOSE')return `Agustín, cerré la operación simulada de la secundaria.
Kraken Futures · PF_XBTUSD · ${e.direction==='SHORT'?'Venta en corto':'Compra'}
Motivo: ${{STOP:'stop',NET_TARGET:'objetivo neto',TIMEOUT:'tiempo máximo',MANUAL_PROFIT:'toma de ganancia solicitada',MANUAL_CLOSE:'cierre solicitado',DATA_GAP_CLOSE:'cierre con datos incompletos'}[e.reason]??e.reason}
Entrada ${textMoney(e.entry)} → salida ${textMoney(e.price)} USD
Resultado neto: ${textMoney(e.pnl)} USD. Costes: ${textMoney(e.fees)} USD, incluida financiación.
${e.quality==='OBSERVED'?'Precio y volumen observados en la simulación.':'Hubo un hueco de datos: se conserva el resultado y se excluye de validación limpia.'}
Ref. ${e.id.slice(0,8)}`+link;
 throw Error('SECONDARY_NOTICE_UNKNOWN');
}
export class SecondaryNotifier extends TradingNotifier{
 constructor(options){
  const original=options.store,filtered=new Proxy(original,{get(t,k){if(k==='queued')return async()=> (await t.queued()).filter(n=>!KINDS.has(n.kind));const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;}});
  super({...options,store:filtered});this.originalStore=original;
 }
 async drain(){
  const notice=(await this.originalStore.queued()).find(n=>KINDS.has(n.kind));if(!notice)return super.drain();
  if(!this.identityAt||Date.now()-this.identityAt>3600000)await this.verify();
  const owner=await this.owner(),id=notice.id,claim_id=randomUUID(),claim=await this.originalStore.tx({phase:'CLAIM',id,claim_id});
  if(claim.status!=='DISPATCHING'||claim.claim_id!==claim_id)return [{id,status:claim.status}];
  let status='DELIVERED',reason=null,receipt={};
  try{
   const text=secondaryMessage(notice);if(text.length>4000)throw Object.assign(Error('MESSAGE_TOO_LONG'),{definite:true});
   receipt.attempt_at=Date.now();const r=await this.transport.call('sendMessage',{chat_id:owner,text,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[[{text:'Abrir Trading',web_app:{url:PANEL_URL}}]]}});receipt.response_at=Date.now();
   if(!Number.isSafeInteger(r?.message_id)||r.message_id<=0||String(r.chat?.id)!==owner)throw Error('INVALID_TELEGRAM_RECEIPT');
   Object.assign(receipt,{message_id:r.message_id,telegram_date:r.date,recipient_hash:hash(owner),read_confirmed:false});
  }catch(e){status=e.definite?'REJECTED':'UNKNOWN';reason=/^[A-Z_]+$/.test(e.message)?e.message:'TELEGRAM_SEND_FAILED';receipt.response_at??=Date.now();}
  await this.originalStore.tx({phase:'FINISH',id,claim_id,status,receipt,reason});return [{id,status,reason,receipt}];
 }
}
export function installOperational(engine,env){
 const requested=env.LUMI_TRADING_SECONDARY_EXECUTION;
 if(!requested){if(engine.state.secondaryExecution)throw Error('SECONDARY_EXECUTION_FLAG_REQUIRED');return null;}
 if(requested!==SECONDARY_VERSION||env.LUMI_RUNTIME_ENV!=='staging'||env.LUMI_TRADING_MODE!=='PAPER'||env.LUMI_TRADING_STORAGE!=='SQLITE')throw Error('SECONDARY_EXECUTION_PAPER_ONLY');
 const runtime=new OperationalSecondary({engine}).initialize();engine.secondaryRuntime=runtime;
 // Route all secondary writes through the futures broker. The existing spot
 // engine, controls and primary continue to run, but cannot settle these trades.
 engine.frequency.market=()=>{};engine.frequency.recover=()=>{};engine.frequency.boundary=async()=>{};
 engine.frequency.cancel=reason=>{if(['ORDER_CANCELLED_ON_SHUTDOWN','RESOURCE_LIMIT'].includes(reason))runtime.broker.cancelAll(reason);};
 engine.laboratory.boundary=async()=>{};
 const track=engine.learning.track.bind(engine.learning);engine.learning.track=(ledger,version,p,q)=>{if(!isSecondary(p))return track(ledger,version,p,q);};
 const tick=engine.tick.bind(engine);engine.tick=async()=>{if(engine.busy)return;if(runtime.now()-engine.lastLease<=30000)runtime.tick();await tick();};
 const delivery=engine.acceptDelivery.bind(engine);engine.acceptDelivery=n=>{if(KINDS.has(n.kind))return;return delivery(n);};
 if(engine.notifier){const old=engine.notifier;engine.notifier=new SecondaryNotifier({store:engine.store,db:old.db,env,feed:engine.feed,pending:id=>engine.pending(id),transport:old.transport});}
 if(!runtime.state.status_notice_queued){engine.notice('SECONDARY_STATUS',{equity:engine.state.frequency.account.equity},[SECONDARY_VERSION,'enabled']);runtime.state.status_notice_queued=true;}
 runtime.start();return runtime;
}
export function attachOperationalProjection(publisher,store){
 if(!publisher)return;const send=publisher.send.bind(publisher);
 publisher.send=async(path,body,revision)=>{
  const d=JSON.parse(body),row=store.row();if(row.revision!==revision||!row.state.secondaryExecution)return send(path,body,revision);
  const state=row.state,x=state.secondaryExecution,f=state.frequency,q=x.market?.quote,now=Date.now(),policy=SECONDARY_PROTOCOL;
  d.secondary_execution={...x,protocol:policy};
  d.frequency={...d.frequency,execution_version:SECONDARY_VERSION,execution_status:x.status,exchange:'KRAKEN_FUTURES',instrument:policy.symbol,operation_mode:'CONTINUOUS_PAPER',daily_selection_limit:null,market:x.market,lastDecision:f.lastDecision,pattern_decisions:x.decisions,protocol:{...d.frequency.protocol,intervalMs:300000,maxHoldingMinutes:30,fee:policy.takerFee,makerFee:policy.makerFee,risk:policy.riskFraction,dailyLoss:policy.dailyLossFraction,minNetRR:String(policy.minNetRR)},risk_profile:{version:SECONDARY_VERSION,maxSlots:policy.maxSlots,openRisk:policy.openRiskFraction,risk:policy.riskFraction,maxRiskUSD:policy.riskCapUSD,dailyLoss:policy.dailyLossFraction},entry_profile:null,context_profile:null,maker_sizing_profile:null};
  for(const p of d.frequency.account.positions??[]){const raw=f.account.positions[p.plan.id];p.live_exit=raw?secondaryEstimate(raw,q,now):null;}
  for(const o of d.operations??[]){if(o.plan?.execution_model!==SECONDARY_MODEL)continue;const raw=f.account.positions[o.id];o.instrument=policy.symbol;o.exchange='KRAKEN_FUTURES';if(raw){o.live_position=d.frequency.account.positions.find(p=>p.plan.id===o.id);o.status='OPEN';}}
  d.laboratory={...d.laboratory,previous_trial_status:d.laboratory.status,status:x.status==='ACTIVE_PAPER'?'ACTIVE':x.status,active:SECONDARY_VERSION,executionRevision:SECONDARY_VERSION,operational:true,lastDecision:f.lastDecision,recipes:policy.patterns.map(id=>({id,title:id,tf:5,kind:id,holdingMs:policy.holdingMs,minNetRR:String(policy.minNetRR)})),trials:[...(d.laboratory.trials??[]),{version:SECONDARY_VERSION,status:x.status,started_at:x.activated_at,closed:x.counts.closed,net:D(f.account.net).minus(x.baseline.net).toNumber(),recipe:{id:SECONDARY_VERSION,title:'Secundaria operativa · PF_XBTUSD',tf:5,timeframes:[5,15]},decisions:x.decisions,report:{status:'EXPERIMENTAL_PAPER',reason:'NO_PROFITABILITY_CLAIM'}}]};
  return send(path,JSON.stringify(d),revision);
 };
}
