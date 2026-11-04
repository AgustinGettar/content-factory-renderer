// Research-only regime observations on closed PF_XBTUSD candles.
// Never authorizes orders, changes signed contracts, or claims a calibrated edge.
export const SECONDARY_MARKET_REGIME_VERSION = 'secondary-market-regime-observation-1.0.0';
const FRAMES = new Set([5, 15, 60, 240]);
const number = v => Number(v);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const rounded = x => finite(x) ? Number(x.toPrecision(8)) : null;
const unknown = (reason, timeframe, cutoff) => ({version: SECONDARY_MARKET_REGIME_VERSION, regime: 'UNKNOWN', reason,
 timeframe, cutoff, advisory_only: true, statistically_validated: false});
function ema(rows, period) {
 if (rows.length < period) return null;
 let value = mean(rows.slice(0, period).map(b => b.close));
 for (const b of rows.slice(period)) value += (b.close - value) * 2 / (period + 1);
 return value;
}
function directional(rows, period = 14) {
 const trs = [], plus = [], minus = [];
 for (let i = 1; i < rows.length; i++) {
  const a = rows[i], b = rows[i - 1], up = a.high - b.high, down = b.low - a.low;
  trs.push(Math.max(a.high - a.low, Math.abs(a.high - b.close), Math.abs(a.low - b.close)));
  plus.push(up > down && up > 0 ? up : 0);
  minus.push(down > up && down > 0 ? down : 0);
 }
 if (trs.length < period * 2 - 1) return null;
 let tr = trs.slice(0, period).reduce((a, b) => a + b, 0);
 let p = plus.slice(0, period).reduce((a, b) => a + b, 0);
 let m = minus.slice(0, period).reduce((a, b) => a + b, 0);
 let adx = 0, dxCount = 0, dxLast = 0;
 for (let i = period - 1; i < trs.length; i++) {
  if (i >= period) {
   tr = tr - tr / period + trs[i];
   p = p - p / period + plus[i];
   m = m - m / period + minus[i];
  }
  const pdi = tr > 0 ? p / tr * 100 : 0, mdi = tr > 0 ? m / tr * 100 : 0;
  const dx = pdi + mdi > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;
  if (dxCount < period) { adx += dx; dxCount++; if (dxCount === period) adx /= period; }
  else adx = (adx * (period - 1) + dx) / period;
  dxLast = dx;
 }
 return {adx, plus_di: tr > 0 ? p / tr * 100 : 0, minus_di: tr > 0 ? m / tr * 100 : 0, last_dx: dxLast};
}
function atr(rows, period = 14) {
 if (rows.length <= period) return null;
 const values = [];
 for (let i = rows.length - period; i < rows.length; i++) {
  const b = rows[i], prev = rows[i - 1];
  values.push(Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)));
 }
 return mean(values);
}
/** Deterministic, causal observations; thresholds are *unvalidated* research hypotheses. */
export function classifySecondaryMarketRegime(series, {timeframe, cutoff, now, quote = null} = {}) {
 if (!FRAMES.has(timeframe) || !Number.isSafeInteger(cutoff) || cutoff % (timeframe * 60000) !== 0 ||
     !Number.isSafeInteger(now) || now < cutoff) return unknown('INVALID_CLOCK', timeframe, cutoff);
 if (!Array.isArray(series)) return unknown('MISSING_CANDLES', timeframe, cutoff);
 const bars = series.filter(b => b && Number.isSafeInteger(b.end) && b.end <= cutoff &&
  (b.available_at == null || Number.isSafeInteger(b.available_at) && b.available_at <= now)).slice(-256)
  .map(b => ({...b, open: number(b.open), high: number(b.high), low: number(b.low), close: number(b.close), volume: number(b.volume)}));
 if (bars.length < 64 || bars.at(-1).end !== cutoff) return unknown('CLOSED_HISTORY_NOT_SYNCHRONIZED', timeframe, cutoff);
 const duration = timeframe * 60000;
 for (let i = 0; i < bars.length; i++) {
  const b = bars[i];
  if (!Number.isSafeInteger(b.start) || b.end - b.start !== duration ||
   (i > 0 && b.start !== bars[i - 1].end) ||
   ![b.open,b.high,b.low,b.close,b.volume].every(finite) || b.volume < 0 || b.low <= 0 ||
   b.low > Math.min(b.open,b.close) || b.high < Math.max(b.open,b.close)) return unknown('INVALID_CLOSED_HISTORY', timeframe, cutoff);
 }
 const close = bars.at(-1).close, recent = bars.slice(-20), earlier = bars.slice(-21, -1);
 const a = atr(bars), direction = directional(bars);
 if (!(a > 0) || !direction) return unknown('INDICATORS_UNAVAILABLE', timeframe, cutoff);
 const ema9 = ema(bars, 9), ema21 = ema(bars, 21), ema50 = ema(bars, 50), ema200 = ema(bars, 200);
 const old21 = ema(bars.slice(0, -3), 21);
 const normalizedSlope = (ema21 - old21) / (3 * a);
 const prices = bars.slice(-21).map(b => b.close);
 const traveled = prices.slice(1).reduce((sum, p, i) => sum + Math.abs(p - prices[i]), 0);
 const efficiency = traveled > 0 ? Math.abs(prices.at(-1) - prices[0]) / traveled : 0;
 const previousVolume = mean(earlier.map(b => b.volume)), relativeVolume = previousVolume > 0 ? bars.at(-1).volume / previousVolume : null;
 const volumeSum = recent.reduce((s, b) => s + b.volume, 0);
 const vwap = volumeSum > 0 ? recent.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0) / volumeSum : null;
 const priorAtr = atr(bars.slice(0, -14)), volatilityRatio = priorAtr > 0 ? a / priorAtr : null;
 const quoteAvailable = quote && quote.symbol === 'PF_XBTUSD' && Number.isSafeInteger(quote.event_at) && quote.event_at <= now && now - quote.event_at <= 5000;
 const bid = quoteAvailable ? number(quote.bid) : null, ask = quoteAvailable ? number(quote.ask) : null;
 const spreadBps = bid > 0 && ask >= bid ? (ask - bid) / ((ask + bid) / 2) * 10000 : null;
 const illiquid = spreadBps != null && spreadBps > 8;
 const up = ema9 > ema21 && ema21 > ema50 && close > ema21 && normalizedSlope > 0 && direction.plus_di > direction.minus_di && direction.adx >= 25;
 const down = ema9 < ema21 && ema21 < ema50 && close < ema21 && normalizedSlope < 0 && direction.minus_di > direction.plus_di && direction.adx >= 25;
 const highVol = volatilityRatio != null && volatilityRatio >= 1.65;
 const compressed = volatilityRatio != null && volatilityRatio <= 0.65;
 const breakUp = close > Math.max(...earlier.map(b => b.high));
 const breakDown = close < Math.min(...earlier.map(b => b.low));
 const expansion = (breakUp || breakDown) && relativeVolume != null && relativeVolume >= 1.2 &&
  direction.adx >= 22 && bars.at(-1).high - bars.at(-1).low >= 1.1 * a;
 const sideways = direction.adx < 22 && efficiency <= 0.4;
 const regime = illiquid ? 'ILLIQUID' : expansion ? 'BREAKOUT_EXPANSION' : highVol ? 'HIGH_VOLATILITY' :
  compressed ? 'VOLATILITY_COMPRESSION' : up ? 'UPTREND' : down ? 'DOWNTREND' : sideways ? 'RANGE' : 'UNDETERMINED';
 return {version: SECONDARY_MARKET_REGIME_VERSION, regime, reason: null,
  timeframe, cutoff, last_closed_at: bars.at(-1).end, sample_bars: bars.length,
  advisory_only: true, statistically_validated: false,
  direction: up ? 'UP' : down ? 'DOWN' : sideways ? 'SIDEWAYS' : 'MIXED',
  volatility: highVol ? 'HIGH' : compressed ? 'COMPRESSED' : 'NORMAL',
  features: {close: rounded(close), ema9: rounded(ema9), ema21: rounded(ema21), ema50: rounded(ema50),
   ema200: rounded(ema200), atr14: rounded(a), atr_relative: rounded(a / close), adx14: rounded(direction.adx),
   plus_di: rounded(direction.plus_di), minus_di: rounded(direction.minus_di),
   normalized_ema21_slope: rounded(normalizedSlope), efficiency20: rounded(efficiency),
   relative_volume20: rounded(relativeVolume), vwap20: rounded(vwap),
   atr_expansion_ratio: rounded(volatilityRatio), observed_spread_bps: rounded(spreadBps),
   break_direction: expansion ? (breakUp ? 'UP' : 'DOWN') : null}};
}
