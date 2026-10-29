import {randomUUID} from 'node:crypto';
import {TelegramTransport} from '../telegram-review-v1/runtime.js';
import {POLICY,D,hash,freshness,VERSION} from './core.js';
import {invalidate} from './simulator.js';
export function rome(t){return new Intl.DateTimeFormat('es-AR',{timeZone:'Europe/Rome',dateStyle:'short',timeStyle:'medium'}).format(new Date(t))+' Europe/Rome '+new Intl.DateTimeFormat('en',{timeZone:'Europe/Rome',timeZoneName:'longOffset'}).formatToParts(new Date(t)).find(x=>x.type==='timeZoneName').value;}
const money=x=>D(x).toFixed(2);
export function renderNotice(n,feed,now){
  const head='MERCADO EN VIVO · SIMULACIÓN EXPERIMENTAL\nSIN ORDEN REAL · Kraken BTC/USD spot';
  if(n.kind==='VERSION'&&n.payload?.type==='FREQUENCY_ACCOUNT_STARTED')return `SEGUNDA CUENTA DE PRUEBA ACTIVADA\nFrecuente · 100 USD ficticios independientes.\nRevisión cada minuto; hasta 12 planes por día. Sin cantidad mínima garantizada.\nRiesgo 0,25 % por entrada; límite diario 1 %; pausa al 5 % de caída máxima.\nMismos costes de Kraken: 0,80 % por lado + deslizamiento y spread. Objetivo calculado después de costes.\nLa cuenta selectiva conserva su saldo e historial.\nCompra y venta spot simuladas, sin préstamo ni órdenes reales. Probabilidad NO DISPONIBLE.`;
  if(n.kind==='VERSION'&&n.payload?.type==='PAPER_INITIAL_CAPITAL_CHANGED')return `CAPITAL DE SIMULACIÓN ACTUALIZADO\nCapital inicial: ${money(n.payload.to)} USD ficticios.\nRiesgo inicial por entrada: ${money(n.payload.initial_risk_budget)} USD (${D(n.payload.risk_fraction).mul(100)} %).\nKraken BTC/USD spot · sin préstamo ni órdenes reales.\nSe respetan mínimos, comisiones y liquidez; no se fuerza una entrada.\nProbabilidad NO DISPONIBLE.\nCambio registrado sin borrar el historial.\nID ${n.id.slice(0,16)}`;
  if(n.kind==='SIGNAL'){
    const p=n.payload.plan,q=feed.quote,s=p.sizing;
    return `${head} · COMPRA/LONG\nCuenta: ${n.payload.account==='FREQUENT_PAPER'?'FRECUENTE · experimental':'SELECTIVA'}\nDato: ${rome(q.event_at)} · edad ${((now-q.event_at)/1000).toFixed(2)} s\nBid / ask: ${q.bid} / ${q.ask} USD\nEntrada hipotética: LAST cruza ${p.entry}; compra stop-limit ≤ ${p.limit}. No perseguir.\nStop: LAST ≤ ${p.stop} → salida modelada a mercado\nTP: LAST ≥ ${p.target} → salida modelada a mercado\nB/R neto estimado: ${D(s.net_rr).toFixed(2)}\nCuenta FICTICIA inicial: ${money(p.policy?.initialCash??POLICY.initialCash)} USD\nTamaño: ${s.qty} BTC · riesgo ${money(s.risk)} USD (${D(s.risk_pct).toFixed(3)} %)\nExposición / efectivo reservado: ${money(s.exposure)} / ${money(s.reserved)} USD\nApalancamiento efectivo: ${D(s.effective_leverage).toFixed(3)}×; financiado 1× sin préstamo. Real no configurado.\nCostes: taker ${D(s.fee).mul(100)} % por lado; spread observado; deslizamiento ${D(s.slippage).mul(10000)} bps.\nProbabilidad: NO DISPONIBLE\nEvento: TP antes del stop en ${p.family==='F'?'30 minutos':p.H+' velas de 15 min'} desde fill; muestra todavía insuficiente.\nA favor: ${p.criteria.join(', ')} · familia ${p.family}\nEn contra: estrategia y fills sin validar; costes altos; pérdidas posibles.\nInvalidación: contexto perdido, barrera alcanzada, trigger pasado, entrada fuera del límite o datos caducados.\nVence: ${rome(p.expires_at)}\nID ${p.id.slice(0,16)} · ${p.version}\nPlan ${p.hash.slice(0,16)}`;
  }
  if(n.kind==='TECHNICAL')return `PRUEBA DE CONEXIÓN\n${head}\nNo es una señal de trading.\nDato: ${rome(feed.quote.event_at)} · edad ${((now-feed.quote.event_at)/1000).toFixed(2)} s\nBid / ask: ${feed.quote.bid} / ${feed.quote.ask} USD\nÚltimo trade: ${rome(feed.trade.event_at)}\nFeed BBO + trades; reglas A/B/C experimentales.\nCuenta ficticia: ${money(POLICY.initialCash)} USD; sin fondos ni órdenes reales.\nProbabilidad NO DISPONIBLE.\nID ${n.id.slice(0,16)} · ${VERSION}`;
  if(n.kind==='RESULT'){const e=n.payload;return `RESULTADO SIMULADO · ${e.ledger==='FREQUENT_PAPER'?'CUENTA FRECUENTE':e.ledger}\nKraken BTC/USD spot · LONG\nMotivo: ${e.reason} · calidad ${e.quality}\nEntrada / salida modeladas: ${money(e.entry)} / ${money(e.price)} USD\nCantidad: ${e.qty} BTC\nResultado neto: ${money(e.pnl)} USD · ${D(e.R).toFixed(3)} R\nCostes: ${money(e.fees)} USD\nHora: ${rome(e.at)}\nID ${e.id.slice(0,16)} · ${e.policy_version}\nNo representa una operación del usuario.`;}
  if(n.kind==='SUMMARY'){const s=n.payload;return `RESUMEN SIMULADO · ${rome(now)}\nKraken BTC/USD spot · ${VERSION}\nPeriodo UTC: ${s.from} — ${s.to}\nCandidatos: ${s.candidates} · seleccionados: ${s.selected} · suprimidos: ${s.suppressed} · no ejecutados: ${s.notFilled}\nMotor: ${s.engine.closed} cierres, ${s.engine.wins} ganancias, ${s.engine.losses} pérdidas; neto ${money(s.engine.net)} USD; costes ${money(s.engine.fees)} USD; DD máximo ${D(s.engine.maxDrawdown).mul(100).toFixed(2)} %.\nTras aviso + 60 s: ${s.alert.closed} cierres, neto ${money(s.alert.net)} USD; costes ${money(s.alert.fees)} USD; DD ${D(s.alert.maxDrawdown).mul(100).toFixed(2)} %.\nAbiertas: motor ${s.engine.position?1:0}; tras aviso ${s.alert.position?1:0}.\nFallos de datos: ${s.incidents}.\nAlertas: entregadas ${s.delivered}; rechazadas/vencidas ${s.rejected}; inciertas ${s.unknown}.\nEvaluación: INCONCLUSO · sin estrategia aprobada. Probabilidad NO DISPONIBLE.\nCapital inicial ficticio: ${money(s.initialCash??POLICY.initialCash)} USD. No implica operaciones reales.`;}
  return `EVALUACIÓN DE VERSIONES · SIMULACIÓN\n${JSON.stringify(n.payload)}\nSin habilitación de órdenes reales.`;
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
        const message=await this.transport.call('sendMessage',{chat_id:owner,text});receipt.response_at=Date.now();
        if(!Number.isSafeInteger(message?.message_id)||message.message_id<=0||String(message.chat?.id)!==owner)throw Error('INVALID_TELEGRAM_RECEIPT');
        Object.assign(receipt,{message_id:message.message_id,telegram_date:message.date,recipient_hash:hash(owner),read_confirmed:false});
      }catch(e){status=e.expired?'EXPIRED':e.definite?'REJECTED':'UNKNOWN';reason=/^[A-Z_]+$/.test(e.message)?e.message:'TELEGRAM_SEND_FAILED';receipt.response_at??=Date.now();}
      await this.store.tx({phase:'FINISH',id:n.id,claim_id,status,receipt,reason});outcomes.push({id:n.id,status,reason,receipt});break; // At most one API send per 5 s drain.
    }
    return outcomes;
  }
}
