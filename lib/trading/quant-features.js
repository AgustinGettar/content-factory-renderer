// Causal, bounded public-market features. No I/O, orders, future pivots or model authority.
export const QUANT_FEATURE_VERSION='secondary-quant-features-1.0.0';
export const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
export const variance=a=>a.length>1?mean(a.map(x=>(x-mean(a))**2)):null;
export const stdev=a=>a.length>1?Math.sqrt(variance(a)):null;
export function emaSeries(a,n){const out=Array(a.length).fill(null);if(a.length<n)return out;let v=mean(a.slice(0,n));out[n-1]=v;for(let i=n;i<a.length;i++){v+=(a[i]-v)*2/(n+1);out[i]=v;}return out;}
export const ema=(a,n)=>emaSeries(a,n).at(-1)??null;
export function wilder(a,n){if(a.length<n)return null;let v=mean(a.slice(0,n));for(const x of a.slice(n))v+=(x-v)/n;return v;}
export const trueRanges=b=>b.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-b[i].close),Math.abs(x.low-b[i].close)));
export const atr=(b,n=14)=>wilder(trueRanges(b),n);
export function regression(a){
 if(a.length<3||a.some(x=>!Number.isFinite(x)))return null;
 const mx=(a.length-1)/2,my=mean(a),xx=a.reduce((s,_,i)=>s+(i-mx)**2,0),xy=a.reduce((s,x,i)=>s+(i-mx)*(x-my),0),slope=xy/xx;
 const residual=a.map((x,i)=>x-(my+slope*(i-mx))),total=a.reduce((s,x)=>s+(x-my)**2,0);
 return {slope,intercept:my-slope*mx,r_squared:total>0?Math.max(0,1-residual.reduce((s,x)=>s+x*x,0)/total):0};
}
export function timeCycles(ms){const d=new Date(ms),minute=d.getUTCHours()*60+d.getUTCMinutes(),week=d.getUTCDay()*1440+minute;
 return {hour_sin:Math.sin(2*Math.PI*minute/1440),hour_cos:Math.cos(2*Math.PI*minute/1440),week_sin:Math.sin(2*Math.PI*week/10080),week_cos:Math.cos(2*Math.PI*week/10080),timezone:'UTC'};}
export function causalBars(series,{timeframe,cutoff,now,min=64}={}){
 if(!Number.isSafeInteger(timeframe)||timeframe<1||!Number.isSafeInteger(cutoff)||cutoff%(timeframe*60000)||!Number.isSafeInteger(now)||now<cutoff||!Array.isArray(series))return null;
 const b=series.filter(x=>x&&x.end<=cutoff&&(x.available_at==null||x.available_at<=now)).slice(-256).map(x=>({...x,...Object.fromEntries(['open','high','low','close','volume'].map(k=>[k,x[k]==null||typeof x[k]==="boolean"||x[k]===""?NaN:Number(x[k])]))}));
 if(b.length<min||b.at(-1).end!==cutoff||b.some((x,i)=>!Number.isSafeInteger(x.start)||x.end-x.start!==timeframe*60000||i&&x.start!==b[i-1].end||!['open','high','low','close','volume'].every(k=>Number.isFinite(x[k]))||x.low<=0||x.volume<0||x.high<Math.max(x.open,x.close)||x.low>Math.min(x.open,x.close)))return null;
 return b;
}
function dmi(b,n=14){
 const tr=trueRanges(b),plus=b.slice(1).map((x,i)=>{const u=x.high-b[i].high,d=b[i].low-x.low;return u>d&&u>0?u:0;}),minus=b.slice(1).map((x,i)=>{const u=x.high-b[i].high,d=b[i].low-x.low;return d>u&&d>0?d:0;});
 if(tr.length<2*n)return {adx:null,plus_di:null,minus_di:null};
 let t=mean(tr.slice(0,n)),p=mean(plus.slice(0,n)),m=mean(minus.slice(0,n));const dx=[];let pd=0,md=0;
 for(let i=n-1;i<tr.length;i++){if(i>=n){t+=(tr[i]-t)/n;p+=(plus[i]-p)/n;m+=(minus[i]-m)/n;}pd=t?100*p/t:0;md=t?100*m/t:0;dx.push(pd+md?100*Math.abs(pd-md)/(pd+md):0);}
 return {adx:wilder(dx,n),plus_di:pd,minus_di:md};
}
export function supertrend(b,n=10,multiplier=3){
 const ranges=trueRanges(b);if(ranges.length<n)return null;
 let a=mean(ranges.slice(0,n)),upper=null,lower=null,direction=1;
 for(let i=n;i<b.length;i++){if(i>n)a+=(ranges[i-1]-a)/n;const mid=(b[i].high+b[i].low)/2,u=mid+multiplier*a,l=mid-multiplier*a,previous=b[i-1].close;
  upper=upper==null||u<upper||previous>upper?u:upper;lower=lower==null||l>lower||previous<lower?l:lower;
  if(direction<0&&b[i].close>upper)direction=1;else if(direction>0&&b[i].close<lower)direction=-1;
 }return {period:n,multiplier,direction,value:direction>0?lower:upper};
}
function swings(b){const highs=[],lows=[];for(let i=2;i<b.length-2;i++){
 if(b.slice(i-2,i+3).every((x,j)=>j===2||b[i].high>x.high))highs.push({price:b[i].high,at:b[i].end,confirmed_at:b[i+2].end});
 if(b.slice(i-2,i+3).every((x,j)=>j===2||b[i].low<x.low))lows.push({price:b[i].low,at:b[i].end,confirmed_at:b[i+2].end});
 }const h=highs.slice(-2),l=lows.slice(-2),c=b.at(-1).close;
 return {highs:h,lows:l,hh:h.length===2&&h[1].price>h[0].price,lh:h.length===2&&h[1].price<h[0].price,hl:l.length===2&&l[1].price>l[0].price,ll:l.length===2&&l[1].price<l[0].price,bos_up:!!h.length&&c>h.at(-1).price,bos_down:!!l.length&&c<l.at(-1).price,choch_down:h.length===2&&l.length===2&&h[1].price>h[0].price&&l[1].price>l[0].price&&c<l[1].price,choch_up:h.length===2&&l.length===2&&h[1].price<h[0].price&&l[1].price<l[0].price&&c>h[1].price};}
export function featureSnapshot(series,options={}){
 const b=causalBars(series,options);if(!b)return {version:QUANT_FEATURE_VERSION,status:'UNAVAILABLE',reason:'CLOSED_HISTORY_NOT_SYNCHRONIZED'};
 const c=b.map(x=>x.close),last=b.at(-1),prev=b.at(-2),prior=b.slice(0,-1),a=atr(b),recent=b.slice(-20),e9=ema(c,9),e21=ema(c,21),e50=ema(c,50),e200=ema(c,200),dm=dmi(b);
 const tp=b.map(x=>(x.high+x.low+x.close)/3),vsum=recent.reduce((s,x)=>s+x.volume,0),vwap=vsum?recent.reduce((s,x)=>s+(x.high+x.low+x.close)/3*x.volume,0)/vsum:null;
 const anchorStart=options.anchor_at??Math.floor(options.cutoff/86400000)*86400000,anchored=b.filter(x=>x.start>=anchorStart),av=anchored.reduce((s,x)=>s+x.volume,0);
 // A partial session history is explicitly unavailable, never called a complete anchored VWAP.
 const avwap=anchored[0]?.start===anchorStart&&av>0?anchored.reduce((s,x)=>s+(x.high+x.low+x.close)/3*x.volume,0)/av:null;
 const diff=c.slice(1).map((x,i)=>x-c[i]),gain=wilder(diff.map(x=>Math.max(x,0)),14),loss=wilder(diff.map(x=>Math.max(-x,0)),14),rsi=gain===0&&loss===0?50:loss===0?100:100-100/(1+gain/loss);
 const fast=emaSeries(c,12),slow=emaSeries(c,26),macds=fast.map((x,i)=>x==null||slow[i]==null?null:x-slow[i]).filter(x=>x!=null),macd=macds.at(-1),macdSignal=ema(macds,9);
 const sd=stdev(c.slice(-20)),middle=mean(c.slice(-20)),low14=Math.min(...b.slice(-14).map(x=>x.low)),high14=Math.max(...b.slice(-14).map(x=>x.high));
 const typical=tp.slice(-20),tpMean=mean(typical),mad=mean(typical.map(x=>Math.abs(x-tpMean)));let positiveFlow=0,negativeFlow=0,obv=0;
 for(let i=1;i<b.length;i++){obv+=Math.sign(c[i]-c[i-1])*b[i].volume;if(i>=b.length-14){if(tp[i]>tp[i-1])positiveFlow+=tp[i]*b[i].volume;else if(tp[i]<tp[i-1])negativeFlow+=tp[i]*b[i].volume;}}
 const mfi=positiveFlow===0&&negativeFlow===0?50:negativeFlow===0?100:100-100/(1+positiveFlow/negativeFlow),r=regression(c.slice(-20).map(Math.log)),returns=c.slice(-21).slice(1).map((x,i)=>Math.log(x/c[c.length-21+i])),vol=stdev(returns);
 const slopeNormalized=r&&a>0?r.slope/(a/last.close):null,priorAtr=atr(b.slice(0,-14)),vr=priorAtr>0?a/priorAtr:null,rv=mean(prior.slice(-20).map(x=>x.volume)),eff=Math.abs(last.close-b.at(-21).close)/Math.max(1e-12,diff.slice(-20).reduce((s,x)=>s+Math.abs(x),0));
 const midrange=n=>(Math.max(...b.slice(-n).map(x=>x.high))+Math.min(...b.slice(-n).map(x=>x.low)))/2;
 const q=options.quote,quoteFresh=q&&q.symbol==='PF_XBTUSD'&&Number.isSafeInteger(q.event_at)&&options.now-q.event_at>=0&&options.now-q.event_at<=5000;
 const bid=quoteFresh?Number(q.bid):NaN,ask=quoteFresh?Number(q.ask):NaN,bq=Number(q?.bid_qty),aq=Number(q?.ask_qty),book=Number.isFinite(bid)&&Number.isFinite(ask)&&ask>=bid&&bid>0&&bq>=0&&aq>=0&&bq+aq>0;
 const micro=book?(ask*bq+bid*aq)/(bq+aq):null;
 return {version:QUANT_FEATURE_VERSION,status:'READY',timeframe:options.timeframe,cutoff:options.cutoff,sample_bars:b.length,close:last.close,open:last.open,prior_close:prev.close,ema9:e9,ema21:e21,ema50:e50,ema200:e200,sma20:middle,wma20:c.slice(-20).reduce((s,x,i)=>s+x*(i+1),0)/210,
 ema_slopes_per_minute:Object.fromEntries([9,21,50,200].map(n=>{const current=ema(c,n),previous=ema(c.slice(0,-3),n);return [n,current==null||previous==null?null:(current-previous)/(3*options.timeframe)];})),ema_separation_atr:a>0?(e9-e21)/a:null,supertrend:supertrend(b),
 atr14:a,atr_relative:a/last.close,...dm,rsi14:rsi,macd,macd_signal:macdSignal,macd_histogram:macdSignal==null?null:macd-macdSignal,vwap20:vwap,anchored_vwap:avwap,anchor_at:anchorStart,
 bollinger:{middle,upper:middle+2*sd,lower:middle-2*sd,width:4*sd/middle},keltner:{middle:e21,upper:e21+2*a,lower:e21-2*a},donchian:{high:Math.max(...prior.slice(-20).map(x=>x.high)),low:Math.min(...prior.slice(-20).map(x=>x.low))},
 ichimoku:{tenkan:midrange(9),kijun:midrange(26),span_a_unshifted:(midrange(9)+midrange(26))/2,span_b_unshifted:midrange(52),plot_shift_used_as_feature:false},
 stochastic_k:high14>low14?100*(last.close-low14)/(high14-low14):50,cci20:mad? (tp.at(-1)-tpMean)/(.015*mad):0,obv,mfi14:mfi,relative_volume:rv>0?last.volume/rv:null,efficiency:eff,atr_ratio:vr,structure:swings(b),
 log_regression:r,log_slope_per_minute:r?.slope/options.timeframe,normalized_slope:slopeNormalized,angle_radians:slopeNormalized==null?null:Math.atan(slopeNormalized),return_volatility:vol,cycles:timeCycles(options.cutoff),
 microstructure:{source:book?'OBSERVED_TOP_OF_BOOK':null,spread_bps:book?(ask-bid)/((ask+bid)/2)*10000:null,imbalance:book?(bq-aq)/(bq+aq):null,microprice:micro,full_depth_available:false,order_flow_imbalance:null,cvd:null,liquidation_volume:null},
 mark_price:quoteFresh&&Number(q.mark_price)>0?Number(q.mark_price):null,index_price:quoteFresh&&Number(q.index_price)>0?Number(q.index_price):null,open_interest:quoteFresh&&q.open_interest!=null&&Number(q.open_interest)>=0?Number(q.open_interest):null,
 volume_profile:{status:'UNAVAILABLE',reason:'TRADED_PRICE_VOLUME_HISTORY_REQUIRED'},feature_authority:'DETERMINISTIC_HYPOTHESIS_NOT_CALIBRATED_PROBABILITY'};
}
export function classifyQuantRegime(f){
 if(f?.status!=='READY')return {regime:'UNKNOWN',reason:f?.reason??'FEATURES_UNAVAILABLE',direction:'MIXED'};
 const up=f.ema9>f.ema21&&f.ema21>f.ema50&&f.normalized_slope>0&&f.plus_di>f.minus_di;
 const down=f.ema9<f.ema21&&f.ema21<f.ema50&&f.normalized_slope<0&&f.minus_di>f.plus_di;
 const expansion=(f.close>f.donchian.high||f.close<f.donchian.low)&&f.relative_volume>=1.2&&f.adx>=22;
 const trend=up&&f.adx>=25?'UPTREND':down&&f.adx>=25?'DOWNTREND':null;
 const regime=f.microstructure.spread_bps>8?'ILLIQUID':expansion?'BREAKOUT_EXPANSION':f.atr_ratio>=1.65?'HIGH_VOLATILITY':f.atr_ratio<=.65?'VOLATILITY_COMPRESSION':trend??(f.adx<22&&f.efficiency<=.4?'RANGE':'ERRATIC');
 return {version:'secondary-quant-regime-1.0.0',regime,direction:up?'UP':down?'DOWN':'MIXED',trend,accelerated:f.adx>=35&&Math.abs(f.normalized_slope)>=.15,statistically_validated:false,cutoff:f.cutoff,timeframe:f.timeframe};
}
