import {randomUUID} from 'node:crypto';
import {TelegramTransport} from '../telegram-review-v1/runtime.js';
import {POLICY,D,hash,freshness,VERSION} from './core.js';
import {invalidate} from './simulator.js';
export function rome(t){return new Intl.DateTimeFormat('es-AR',{timeZone:'Europe/Rome',dateStyle:'short',timeStyle:'medium'}).format(new Date(t))+' Europe/Rome '+new Intl.DateTimeFormat('en',{timeZone:'Europe/Rome',timeZoneName:'longOffset'}).formatToParts(new Date(t)).find(x=>x.type==='timeZoneName').value;}
const money=x=>D(x).toFixed(2);
export const PANEL_URL='https://lumi-trading-monitor.aguzz-gettar.chatgpt.site/';
const shortTime=t=>new Intl.DateTimeFormat('es-AR',{timeZone:'Europe/Rome',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(t))+' Italia';
const accountName=e=>e.account==='FREQUENT_PAPER'||e.ledger==='FREQUENT_PAPER'?'secundaria de pruebas':e.ledger==='ALERT_PLUS_60S'?'registro tras aviso +60 s':'principal';
const reasonName=r=>({STOP:'Stop loss',TARGET:'Take profit',TIMEOUT:'Tiempo máximo',VENCIDA:'Entrada vencida'}[r]??r??'Salida');
const probability=p=>p?.status==='AVAILABLE'?`Prob. cierre neto positivo: ${Math.round(p.p*100)} % · grupo de validación n=${p.n}, IC95 ${Math.round(p.interval[0]*100)}–${Math.round(p.interval[1]*100)} %`:'Probabilidad: NO DISPONIBLE';
export function renderNotice(n,feed,now){
 const e=n.payload??{},link=`\nAbrir panel: ${PANEL_URL}`;
 if(n.kind==='SIGNAL'){
  const p=e.plan,s=p.sizing,criterion=p.recipe_title??(p.family==='F'?'impulso de un minuto y medias 9/21':({A:'retroceso en tendencia',B:'ruptura y retesteo',C:'rebote en rango'}[p.family]??p.family));
  return `Agustín, dejé programada una posible compra en la cuenta ${accountName(e)}. Todavía no se ejecutó.
SIMULACIÓN FICTICIA · BTC/USD
Entrada ${money(p.entry)} · límite ${money(p.limit)} USD
Venta por stop ${money(p.stop)} · venta objetivo ${money(p.target)} USD
Monto máximo con comisión: ${money(D(s.qty).mul(p.limit).mul(D(1).plus(s.fee)))} USD. Riesgo previsto: ${money(s.risk)} USD.
Busco ${money(D(s.risk).mul(s.net_rr))} USD netos si alcanza el objetivo en las condiciones previstas.
Criterio: ${criterion}. Sin préstamo.
${probability(p.study?.prediction)}
Vence ${shortTime(p.expires_at)} · Ref. ${p.id.slice(0,8)}`+link;
 }
 if(n.kind==='RESULT'&&e.type==='PAPER_OPENED'){
  const p=e.plan,s=p.sizing,cost=D(e.qty).mul(e.price).mul(D(1).plus(s.fee)),target=D(p.target).minus(s.spread??0).mul(D(1).minus(s.slippage)).mul(e.qty).mul(D(1).minus(s.fee)).minus(cost);
  return `Agustín, abrí una compra simulada en la cuenta ${accountName(e)}.
BTC/USD · entrada ${money(e.price)} USD
Destiné ${money(cost)} USD, incluida la comisión (${e.qty} BTC).
Riesgo previsto: ${money(s.risk)} USD; objetivo neto estimado: ${money(target)} USD. La salida puede variar.
Ventas programadas: stop ${money(p.stop)} · objetivo ${money(p.target)} USD · sin préstamo.
${p.recipe_title??({A:'Retroceso en tendencia',B:'Ruptura y retesteo',C:'Rebote en rango',F:'Impulso de un minuto + medias 9/21'}[p.family]??'Regla registrada')}.
Te aviso al cerrar. ${shortTime(e.at)} · Ref. ${e.id.slice(0,8)}`+link;
 }
 if(n.kind==='RESULT')return `Agustín, cerré la operación simulada de la cuenta ${accountName(e)} por ${reasonName(e.reason).toLowerCase()}.
BTC/USD · entrada ${money(e.entry)} → salida ${money(e.price)} USD
Resultado neto: ${money(e.pnl)} USD, después de ${money(e.fees)} USD de comisiones.
${e.quality==='OBSERVED'?'El resultado quedó registrado para su análisis.':'Hubo datos incompletos: conservé el resultado adverso del simulador y no lo uso para entrenar.'}
${shortTime(e.at)} · Ref. ${e.id.slice(0,8)}`+link;
 if(n.kind==='VERSION'&&e.type==='LABORATORY_ENABLED')return `Agustín, activé el laboratorio de la cuenta secundaria. Voy a probar tres reglas con costes completos y evaluar sus resultados antes de pasar alguna a la principal. Ambas usan dinero ficticio.
Solo recargaré la secundaria si su saldo queda por debajo de 1 USD, hasta 100 USD; el aporte no contará como ganancia.`+link;
 if(n.kind==='VERSION'&&e.type==='PORTFOLIO_ENABLED')return `Agustín, ya puedo gestionar hasta tres operaciones o entradas pendientes por cuenta ficticia. Reservo capital para cada una y comparto el presupuesto de riesgo entre todas.
El riesgo previsto por entrada puede subir hasta 1 USD, sujeto al saldo y al límite conjunto del 1 %. Solo programo entradas con objetivo neto positivo y suficiente después de costes. El stop puede cerrar con pérdida; los saltos de precio pueden superar lo previsto.`+link;
 if(n.kind==='VERSION'&&e.type==='LABORATORY_REFILLED')return `Agustín, la cuenta secundaria quedó en ${money(e.before)} USD ficticios. Agregué ${money(e.amount)} USD ficticios para volver a 100 USD.
La recarga queda separada de los rendimientos y las pérdidas anteriores se conservan. La prueba queda descartada para la principal.`+link;
 if(n.kind==='VERSION'&&e.type==='LABORATORY_PROMOTED_PAPER')return `Agustín, la regla «${e.recipe}» superó la evaluación posterior del laboratorio. Empezará a operar en la cuenta principal, también con dinero ficticio, conservando su saldo. La secundaria continúa con la siguiente prueba. Esto no garantiza ganancias futuras.`+link;
 if(n.kind==='TECHNICAL')return `MONITOR CONECTADO · SIMULACIÓN\nBTC/USD · Kraken\nCuenta inicial: ${money(POLICY.initialCash)} USD ficticios\nDato: ${shortTime(feed.quote.event_at)}\nNo es una señal de entrada.`+link;
 if(n.kind==='VERSION'&&e.type==='PAPER_INITIAL_CAPITAL_CHANGED')return `CAPITAL FICTICIO ACTUALIZADO\nInicial: ${money(e.to)} USD · riesgo inicial: ${money(e.initial_risk_budget)} USD\nHistorial conservado.`+link;
 if(n.kind==='VERSION'&&e.type==='FREQUENCY_ACCOUNT_STARTED')return `CUENTA FRECUENTE ACTIVADA\n100 USD ficticios · riesgo inicial 0,25 USD\nRevisión cada minuto · sin préstamo\nProbabilidad: NO DISPONIBLE`+link;
 if(n.kind==='VERSION'&&e.type==='LEARNING_ENABLED')return `ANÁLISIS Y APRENDIZAJE ACTIVADOS\nAvisos breves de entrada y cierre.\nEl modelo aprenderá de cierres observados y se probará con operaciones posteriores.\nProbabilidad: NO DISPONIBLE hasta superar la validación.`+link;
 if(n.kind==='SUMMARY')return `RESUMEN · SIMULACIÓN\nSelectiva: ${money(e.engine.equity)} USD · neto cerrado ${money(e.engine.net)} USD · ${e.engine.closed} cierres\n${e.frequency?`Frecuente: ${money(e.frequency.equity)} USD · neto cerrado ${money(e.frequency.net)} USD · ${e.frequency.closed} cierres\n`:''}${shortTime(now)}`+link;
 return `ACTUALIZACIÓN DEL MODELO · SIMULACIÓN\n${e.type==='VERSION_PROMOTED_PAPER'?'Nueva versión aprobada para prueba simulada.':'Evaluación registrada; detalles en el panel.'}`+link;
}
export class TradingNotifier {
  constructor({store,db,env,feed,pending,transport}){Object.assign(this,{store,db,env,feed,pending});this.transport=transport||new TelegramTransport({token:env.LUMI_TELEGRAM_BOT_TOKEN});this.identityAt=0;}
  async owner(){
    const ids=(this.env.LUMI_TELEGRAM_REVIEW_TEST_USERS||'').split(',').filter(x=>/^\d+$/.test(x));
    const {data,error}=await this.db.from('cf_bot_admins').select('user_id,chat_id').eq('active',true);if(error)throw Error('TRADING_OWNER_LOOKUP_FAILED');
    const owners=data.filter(x=>String(x.user_id)===String(x.chat_id)&&ids.includes(String(x.user_id))&&Number(x.user_id)>0);
    if(owners.length!==1)throw Error('TRADING_PRIVATE_OWNER_NOT_UNIQUE');
    const id=String(owners[0].user_id),r=await this.db.from('lumi_telegram_review_sessions').select('chat_id,state_chat_id:state->>chat_id').eq('user_id',id).maybeSingle();
    if(r.error||String(r.data?.chat_id)!==id||String(r.data?.state_chat_id)!==id)throw Error('TRADING_OWNER_SESSION_MISMATCH');return id;
  }
  async verify(){
    if(this.env.LUMI_TELEGRAM_TRANSPORT_AUTHORITY!=='DIRECT')throw Error('TRADING_DIRECT_TRANSPORT_REQUIRED');
    const me=await this.transport.call('getMe',{});if(!me?.is_bot||String(me.id)!==this.env.LUMI_TELEGRAM_BOT_ID||me.username!=='AppMultimedia_VideosBot')throw Error('TRADING_BOT_MISMATCH');
    await this.owner();this.identityAt=Date.now();return true;
  }
  async drain(){
    if(!this.identityAt||Date.now()-this.identityAt>3600000)await this.verify();
    const outcomes=[];
    for(const n of (await this.store.queued()).sort((a,b)=>(a.kind==='SIGNAL'?0:1)-(b.kind==='SIGNAL'?0:1))){
      // Technical test also requires actual fresh data. Results/summaries are
      // historical reports and never represented as new opportunities.
      if(['SIGNAL','TECHNICAL'].includes(n.kind)&&freshness(this.feed.state,Date.now(),this.feed.metadata))continue;
      const owner=await this.owner(),claim_id=randomUUID(),claim=await this.store.tx({phase:'CLAIM',id:n.id,claim_id});
      if(claim.status!=='DISPATCHING'||claim.claim_id!==claim_id){outcomes.push({id:n.id,status:claim.status});continue;}
      let status='DELIVERED',reason=null,receipt={};
      try{
        const preflight_at=Date.now(),snapshot=this.feed.snapshot();
        if(['SIGNAL','TECHNICAL'].includes(n.kind)){
          const bad=freshness(snapshot,preflight_at,this.feed.metadata);if(bad)throw Object.assign(Error(bad),{expired:true});
          if(n.kind==='SIGNAL'){
            const p=n.payload.plan,bad=preflight_at-p.decision_at>POLICY.noticeAge?'NOTICE_EXPIRED':!this.pending(p.id)?'PLAN_NO_LONGER_PENDING':invalidate(p,snapshot,preflight_at,this.feed.context);
            if(bad)throw Object.assign(Error(bad),{expired:true});
            if(D(snapshot.quote.ask).minus(snapshot.quote.bid).gt(p.sizing.spread)||D(p.sizing.qty).gt(D(snapshot.quote.ask_qty).mul('.1'))||D(p.sizing.qty).gt(D(snapshot.quote.bid_qty).mul('.1')))throw Object.assign(Error('PRE_SEND_COST_OR_LIQUIDITY_CHANGED'),{expired:true});
          }
        }
        receipt={preflight_at,quote:snapshot.quote,trade:snapshot.trade};
        const text=renderNotice(n,snapshot,preflight_at);if(text.length>4000)throw Object.assign(Error('MESSAGE_TOO_LONG'),{definite:true});
        const attempt_at=Date.now();if(['SIGNAL','TECHNICAL'].includes(n.kind)&&freshness(this.feed.state,attempt_at,this.feed.metadata))throw Object.assign(Error('DATA_EXPIRED_BEFORE_SEND'),{expired:true});
        receipt.attempt_at=attempt_at;
        const message=await this.transport.call('sendMessage',{chat_id:owner,text,link_preview_options:{is_disabled:true}});receipt.response_at=Date.now();
        if(!Number.isSafeInteger(message?.message_id)||message.message_id<=0||String(message.chat?.id)!==owner)throw Error('INVALID_TELEGRAM_RECEIPT');
        Object.assign(receipt,{message_id:message.message_id,telegram_date:message.date,recipient_hash:hash(owner),read_confirmed:false});
      }catch(e){status=e.expired?'EXPIRED':e.definite?'REJECTED':'UNKNOWN';reason=/^[A-Z_]+$/.test(e.message)?e.message:'TELEGRAM_SEND_FAILED';receipt.response_at??=Date.now();}
      await this.store.tx({phase:'FINISH',id:n.id,claim_id,status,receipt,reason});outcomes.push({id:n.id,status,reason,receipt});break; // At most one API send per 5 s drain.
    }
    return outcomes;
  }
}
