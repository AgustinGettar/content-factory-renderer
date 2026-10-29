import {randomUUID} from 'node:crypto';
import {TelegramTransport} from '../telegram-review-v1/runtime.js';
import {POLICY,D,hash,freshness,VERSION} from './core.js';
import {invalidate} from './simulator.js';
export function rome(t){return new Intl.DateTimeFormat('es-AR',{timeZone:'Europe/Rome',dateStyle:'short',timeStyle:'medium'}).format(new Date(t))+' Europe/Rome '+new Intl.DateTimeFormat('en',{timeZone:'Europe/Rome',timeZoneName:'longOffset'}).formatToParts(new Date(t)).find(x=>x.type==='timeZoneName').value;}
const money=x=>D(x).toFixed(2);
export const PANEL_URL='https://lumi-trading-monitor.aguzz-gettar.chatgpt.site/';
const shortTime=t=>new Intl.DateTimeFormat('es-AR',{timeZone:'Europe/Rome',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(t))+' Italia';
const accountName=e=>e.account==='FREQUENT_PAPER'||e.ledger==='FREQUENT_PAPER'?'Frecuente':e.ledger==='ALERT_PLUS_60S'?'Tras aviso +60 s':'Selectiva';
const reasonName=r=>({STOP:'Stop loss',TARGET:'Take profit',TIMEOUT:'Tiempo máximo',VENCIDA:'Entrada vencida'}[r]??r??'Salida');
const probability=p=>p?.status==='AVAILABLE'?`Prob. cierre neto positivo: ${Math.round(p.p*100)} % · grupo de validación n=${p.n}, IC95 ${Math.round(p.interval[0]*100)}–${Math.round(p.interval[1]*100)} %`:'Probabilidad: NO DISPONIBLE';
export function renderNotice(n,feed,now){
 const e=n.payload??{},link=`\nAbrir panel: ${PANEL_URL}`;
 if(n.kind==='SIGNAL'){
  const p=e.plan,s=p.sizing,criterion=p.family==='F'?'Impulso 1 min + medias 9/21':({A:'Retroceso en tendencia',B:'Ruptura y retesteo',C:'Rebote en rango'}[p.family]??p.family);
  return `PLAN DE COMPRA · ${accountName(e)} · SIMULACIÓN FICTICIA\nBTC/USD · Kraken spot\nActivación: ${money(p.entry)} · límite: ${money(p.limit)} USD\nStop: ${money(p.stop)} · TP: ${money(p.target)} USD\nTamaño: ${s.qty} BTC · riesgo previsto: ${money(s.risk)} USD\nSin préstamo · 1×\nCriterio: ${criterion}\n${probability(p.study?.prediction)}\nVence: ${shortTime(p.expires_at)}\nCotización: ${shortTime(feed.quote.event_at)}\nRef. ${p.id.slice(0,8)}`+link;
 }
 if(n.kind==='RESULT'&&e.type==='PAPER_OPENED'){
  const p=e.plan;return `COMPRA EJECUTADA · ${accountName(e)} · SIMULACIÓN\nBTC/USD · ${money(e.price)} USD\n${e.qty} BTC · stop ${money(p.stop)} · TP ${money(p.target)}\nRiesgo previsto: ${money(p.sizing.risk)} USD · sin préstamo\n${shortTime(e.at)} · Ref. ${e.id.slice(0,8)}`+link;
 }
 if(n.kind==='RESULT')return `OPERACIÓN CERRADA · ${accountName(e)} · SIMULACIÓN\nBTC/USD · ${reasonName(e.reason)}\nEntrada: ${money(e.entry)} · salida: ${money(e.price)} USD\nNeto: ${money(e.pnl)} USD · comisiones: ${money(e.fees)} USD\n${e.quality==='OBSERVED'?'Datos observados':'Datos incompletos: resultado conservador'}\n${shortTime(e.at)} · Ref. ${e.id.slice(0,8)}`+link;
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
