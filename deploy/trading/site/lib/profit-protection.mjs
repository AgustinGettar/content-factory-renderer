// Read-only display of persisted PAPER policy and observations. No client-side trading decisions.
const number=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value))?Number(value):null;
export const formatNet=value=>{
 const n=number(value);return n===null?'—':new Intl.NumberFormat('es-AR',{minimumFractionDigits:2,maximumFractionDigits:Math.abs(n)<1?6:4}).format(n);
};
export const formatFraction=value=>{
 const n=number(value);return n===null?'—':new Intl.NumberFormat('es-AR',{minimumFractionDigits:0,maximumFractionDigits:3}).format(n*100)+' %';
};
export const exitReasonLabel=reason=>({
 ISOLATED_MARGIN_STRESS:'Cierre por estrés de margen simulado',EARLY_PROTECTION_PROGRESS_EXTENSION:'Extensión acotada con progreso protegido',EARLY_PROTECTION_BEFORE_TARGET:'Protección antes del objetivo',PROTECTED_PROGRESS_EXTENSION:'Extensión acotada con ganancia protegida',PYRAMID_INITIAL_NOT_PROTECTED:'La entrada inicial aún no está favorable y protegida',PYRAMID_INITIAL_NOT_FAVORABLE:'La entrada inicial no tiene neto favorable',MOVEMENT_MAX_LEGS:'El movimiento ya usó sus tres tramos',PORTFOLIO_SLOT_LIMIT:'Se alcanzó la capacidad conjunta de órdenes y posiciones',STOP:'Cierre por stop',NET_TARGET:'Cierre por objetivo neto',TARGET:'Cierre por objetivo de precio',STRUCTURAL_TARGET:'Cierre por objetivo estructural',
 TRAILING_RETRACEMENT:'Cierre por retroceso del neto',TRAILING_STAGNATION:'Cierre por estancamiento',TIMEOUT_EXTENDED:'Cierre por plazo máximo extendido',TIMEOUT:'Cierre por tiempo',
 DURABLE_EXIT_PENDING:'Cierre activado pendiente de ejecución',MANUAL_PROFIT:'Toma de ganancia solicitada',MANUAL_CLOSE:'Cierre solicitado',INVALIDATION:'Cierre por invalidación',
 NET_BELOW_ACTIVATION_MINIMUM:'El neto no alcanza el mínimo de activación',FUNDING_UNRESOLVED:'Falta reconciliar la financiación',EXECUTABLE_LIQUIDITY_INSUFFICIENT:'Liquidez insuficiente para valorar toda la posición',
 PRE_EXECUTION_EXPECTED_NET_TARGET_BELOW_MINIMUM:'La cotización posterior a la latencia ya no deja margen neto suficiente',PRE_EXECUTION_FUNDING_NOT_AVAILABLE:'Falta financiación verificable antes de ejecutar',
 EXPECTED_NET_TARGET_BELOW_MINIMUM:'Objetivo neto previsto inferior al mínimo útil',ENTRY_ECONOMICS_CHANGED_BEFORE_FILL:'El margen neto dejó de ser suficiente antes de ejecutar',
 NEW_OPPORTUNITY:'Nueva oportunidad',ADDITION_NEW_CONFIRMATION:'Adición con nueva confirmación',REPEATED_CONFIRMATION:'Confirmación ya procesada',LATE_REPETITION_NO_NEW_CONFIRMATION:'Repetición sin nueva confirmación',
 TARGET_REACHED_TRAILING_EXTENSION:'Extensión acotada por objetivo alcanzado',BASE_HOLDING_LIMIT:'Plazo base de la posición',TRAILING_EXTENSION:'Continuación con extensión acotada',TRAILING_ACTIVATION:'Extensión fijada al activar la protección',BASE_HOLDING:'Plazo base de la posición'
}[reason]??reason??'Sin motivo registrado');
const states={OPEN_BEFORE_TARGET:'Antes del objetivo',TRAILING_ACTIVE:'Objetivo alcanzado · dejando correr',EXIT_PENDING:'Salida pendiente',PARTIALLY_CLOSED:'Cierre parcial · remanente abierto',CLOSED:'Cerrada',ORDER_PENDING:'Orden pendiente'};
export function profitProtection(plan,position,now){
 const policy=plan?.exit_policy;if(!policy?.version)return null;
 const early=policy.target_activation_required===false||policy.version==='secondary-net-protection-2.0.0',raw=position?.profit_protection??{},quote=position?.live_exit,state=raw.state??(position?'OPEN_BEFORE_TARGET':'ORDER_PENDING');
 const quoteAt=number(quote?.quote_at),fresh=Boolean(quote?.fresh&&Number.isSafeInteger(quoteAt)&&quoteAt>0&&quoteAt<=8640000000000000&&now-quoteAt>=-1000&&now-quoteAt<=5000);
 const complete=quote?.funding_complete!==false&&quote?.result_final!==false&&!position?.funding_uncertain&&!position?.funding_pending?.length&&!position?.funding_gaps?.length&&!position?.closed_funding_pending?.length;
 const quantity=number(position?.qty),basis=number(raw.basis_qty),sameQuantity=quantity!==null&&basis!==null&&Math.abs(quantity-basis)<=1e-12;
 const liquid=quote?.liquidity_ok!==false;
 const currentNet=fresh&&complete&&liquid?number(quote?.net):null,peak=number(raw.peak_net),retracement=currentNet!==null&&peak!==null&&sameQuantity?Math.max(0,peak-currentNet):null;
 const uncertaintyUnit=number(raw.execution_uncertainty_per_unit),uncertainty=uncertaintyUnit!==null&&basis!==null?uncertaintyUnit*basis:null;
 const realized=number(position?.realized?.net);
 return {policy,raw,state,early,requiredActivationNet:raw.required_activation_net??null,additionalUncertainty:uncertainty,minProtectedNet:raw.min_protected_net_per_unit!=null&&basis!==null?Number(raw.min_protected_net_per_unit)*basis:policy.min_protected_net_usd??null,realizedNet:realized,combinedNet:currentNet!==null&&realized!==null?currentNet+realized:null,
  label:early&&state==='OPEN_BEFORE_TARGET'?'Esperando ganancia protegible':early&&state==='TRAILING_ACTIVE'?'Ganancia protegida · dejando correr':states[state]??state,activated:Boolean(raw.trailing_activated_at),fresh,complete,liquid,currentNet,quantity,basis,sameQuantity,
  activationNet:raw.activation_net_original??raw.activation_net??null,activationNetRemaining:raw.activation_net??null,peakNet:raw.peak_net??null,protectedNet:raw.protected_net??null,retracementAllowance:raw.retracement_allowance??null,
  retracement,retracementFraction:retracement!==null&&peak>0?retracement/peak:null,exitIntent:position?.exit_intent??null,
  effectiveExpiresAt:raw.effective_expires_at??position?.expires_at??null,baseExpiresAt:raw.base_expires_at??position?.expires_at??null,
  deadlineReason:raw.deadline_reason??null,stagnationDeadlineAt:raw.stagnation_deadline_at??null,
  activationBlocker:raw.activation_blocker??null,targetNetInsufficient:raw.target_net_insufficient??null};
}
export function profitPolicyView(data){
 const profile=data?.frequency?.profit_policy??data?.secondary_execution?.profit_policy??data?.secondary_activity?.profit_policy;
 if(!profile)return null;
 return {...profile,early:profile.policy?.target_activation_required===false||profile.policy?.exitVersion==='secondary-net-protection-2.0.0',minimumProtectedNet:profile.policy?.min_protected_net_usd??null,uncertaintyFraction:profile.policy?.execution_uncertainty_fraction??null,minimumFraction:profile.policy?.min_expected_net_target_fraction??null,retracementFraction:profile.policy?.retracement_fraction??null,
  minimumPer100:number(profile.policy?.min_expected_net_target_fraction)===null?null:Number(profile.policy.min_expected_net_target_fraction)*100};
}
