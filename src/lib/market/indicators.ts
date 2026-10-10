// ---------- 技术指标与机会识别（纯函数，服务端使用） ----------
// 1) 均线支撑/压力机会：3m/5m/15m K 线回踩 MA5/MA10/MA20 企稳（做多）或反抽受阻（做空）
// 2) 大级别支撑/压力：4h K 线分形极值（摆动高低点）聚类成 S/R 区域

export type ScannerTF = '3m' | '5m' | '15m';

export interface MaSignal {
  id: string; // symbol|tf|type
  symbol: string;
  base: string;
  tf: ScannerTF;
  type: 'LONG_MA_SUPPORT' | 'SHORT_MA_RESIST';
  maName: 'MA5' | 'MA10' | 'MA20';
  maValue: number;
  price: number;
  distancePct: number; // 现价与均线距离 %
  score: number; // 1-5
  alignment: 'BULL' | 'BEAR' | 'MIXED'; // 均线排列
  volumeBoost: boolean; // 反转 K 线放量
  change24h: number;
  quoteVolume24h: number;
  detectedAt: number;
}

export interface MajorLevel {
  price: number;
  touches: number; // 聚类内极值点数量
  distancePct: number; // 相对现价距离 %
}

export interface SymbolLevels {
  symbol: string;
  base: string;
  price: number;
  change24h: number;
  quoteVolume24h: number;
  support: MajorLevel | null; // 最近的下方大级别支撑
  resist: MajorLevel | null; // 最近的上方大级别压力
}

// 触碰均线容差（价格可高于均线的幅度）与企稳回升幅度，按周期放宽
const BAND: Record<ScannerTF, number> = { '3m': 0.0015, '5m': 0.002, '15m': 0.003 };
const BOUNCE: Record<ScannerTF, number> = { '3m': 0.0008, '5m': 0.001, '15m': 0.0015 };

/** 简单移动平均（endIdx 为收盘索引，含 endIdx 向前 period 根） */
export function sma(values: number[], period: number, endIdx: number): number | null {
  if (endIdx + 1 < period || endIdx >= values.length) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += values[i];
  return sum / period;
}

type Kline = [number, string, string, string, string, string, number, string, number, string, string, string];

interface MaSideResult {
  type: 'LONG_MA_SUPPORT' | 'SHORT_MA_RESIST';
  maName: 'MA5' | 'MA10' | 'MA20';
  maValue: number;
  distancePct: number;
  score: number;
  volumeBoost: boolean;
}

/**
 * 识别"回踩均线支撑"（做多）或"反抽均线压力"（做空）机会。
 * 规则：
 *  - 趋势背景：多头排列(MA5>MA10>MA20) 或 MA20 上行 → 只找做多；反之只找做空
 *  - 近 3 根 K 线内价格触碰某条均线（未大幅击穿）
 *  - 现价已离开均线一定幅度（企稳/受阻确认）
 *  - 评分 ≥3 分才输出（基础 2 分 + 排列/斜率/反转K线实体/放量/均线聚拢各 1 分）
 */
export function analyzeMa(
  tf: ScannerTF,
  symbol: string,
  base: string,
  kl: Kline[],
  meta: { change24h: number; quoteVolume24h: number; now: number },
): MaSignal | null {
  const n = kl.length;
  if (n < 60) return null;

  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  for (const k of kl) {
    closes.push(Number(k[4]));
    highs.push(Number(k[2]));
    lows.push(Number(k[3]));
  }
  const price = closes[n - 1];
  if (!Number.isFinite(price) || price <= 0) return null;

  const ma5 = sma(closes, 5, n - 1);
  const ma10 = sma(closes, 10, n - 1);
  const ma20 = sma(closes, 20, n - 1);
  const ma20Prev = sma(closes, 20, n - 6);
  if (ma5 == null || ma10 == null || ma20 == null || ma20Prev == null) return null;
  if ([ma5, ma10, ma20].some((v) => !Number.isFinite(v) || v <= 0)) return null;

  const alignment: MaSignal['alignment'] =
    ma5 > ma10 && ma10 > ma20 ? 'BULL' : ma5 < ma10 && ma10 < ma20 ? 'BEAR' : 'MIXED';
  const ma20Rising = ma20 > ma20Prev;
  const ma20Falling = ma20 < ma20Prev;

  // 20 根 K 线平均成交量（不含最新一根）
  let volSum = 0;
  for (let i = n - 21; i < n - 1; i++) volSum += Number(kl[i][5]);
  const avgVol20 = volSum / 20;

  const trySide = (dir: 1 | -1): MaSideResult | null => {
    const isLong = dir === 1;
    const contextOk = isLong ? alignment === 'BULL' || ma20Rising : alignment === 'BEAR' || ma20Falling;
    if (!contextOk) return null;

    const mas: Array<['MA5' | 'MA10' | 'MA20', number]> = [
      ['MA5', ma5],
      ['MA10', ma10],
      ['MA20', ma20],
    ];
    const band = BAND[tf];
    const bounce = BOUNCE[tf];

    for (const [name, ma] of mas) {
      // 近 3 根 K 线内触碰均线（做多：下探至均线附近且未深破；做空：上冲至均线附近且未大幅越过）
      let touched = false;
      for (let i = n - 3; i < n; i++) {
        if (isLong) {
          if (lows[i] <= ma * (1 + band) && lows[i] >= ma * (1 - 3 * band)) {
            touched = true;
            break;
          }
        } else {
          if (highs[i] >= ma * (1 - band) && highs[i] <= ma * (1 + 3 * band)) {
            touched = true;
            break;
          }
        }
      }
      if (!touched) continue;

      // 企稳/受阻确认：现价已离开均线
      if (isLong && price < ma * (1 + bounce)) continue;
      if (!isLong && price > ma * (1 - bounce)) continue;

      // 反转 K 线实体强度
      const o = Number(kl[n - 1][1]);
      const cl = Number(kl[n - 1][4]);
      const hi = Number(kl[n - 1][2]);
      const lo = Number(kl[n - 1][3]);
      const range = hi - lo;
      const bodyRatio = range > 0 ? Math.abs(cl - o) / range : 0;
      const reversalOk = isLong ? cl > o && bodyRatio >= 0.3 : cl < o && bodyRatio >= 0.3;

      const vol = Number(kl[n - 1][5]);
      const volumeBoost = avgVol20 > 0 && vol >= avgVol20 * 1.3;

      // 均线聚拢（两条均线贴合 → 支撑/压力区更强）
      const cluster =
        Math.abs(ma5 - ma10) / ma10 < 0.002 || Math.abs(ma10 - ma20) / ma20 < 0.003;

      let score = 2;
      if (isLong && alignment === 'BULL') score++;
      if (!isLong && alignment === 'BEAR') score++;
      if (isLong && ma20Rising) score++;
      if (!isLong && ma20Falling) score++;
      if (reversalOk) score++;
      if (volumeBoost) score++;
      if (cluster) score++;
      score = Math.min(5, score);
      if (score < 3) continue;

      return {
        type: isLong ? 'LONG_MA_SUPPORT' : 'SHORT_MA_RESIST',
        maName: name,
        maValue: ma,
        distancePct: ((price - ma) / ma) * 100,
        score,
        volumeBoost,
      };
    }
    return null;
  };

  const long = trySide(1);
  const short = trySide(-1);
  const best =
    long && short
      ? long.score !== short.score
        ? long.score > short.score
          ? long
          : short
        : Math.abs(long.distancePct) <= Math.abs(short.distancePct)
          ? long
          : short
      : (long ?? short);
  if (!best) return null;

  return {
    id: `${symbol}|${tf}|${best.type}`,
    symbol,
    base,
    tf,
    type: best.type,
    maName: best.maName,
    maValue: best.maValue,
    price,
    distancePct: best.distancePct,
    score: best.score,
    alignment,
    volumeBoost: best.volumeBoost,
    change24h: meta.change24h,
    quoteVolume24h: meta.quoteVolume24h,
    detectedAt: meta.now,
  };
}

/**
 * 4h 大级别支撑/压力：摆动高低点（左右各 2 根确认的分形）+ 窗口极值，
 * 0.6% 内聚类为 S/R 区域，取现价最近的一条支撑与一条压力。
 */
export function analyzeLevels(
  symbol: string,
  base: string,
  meta: { price: number; change24h: number; quoteVolume24h: number },
  kl: Kline[],
): SymbolLevels | null {
  const closed = kl.slice(0, -1); // 剔除未走完的 K 线
  if (closed.length < 30) return null;
  const price = meta.price;
  if (!Number.isFinite(price) || price <= 0) return null;

  const highs = closed.map((k) => Number(k[2]));
  const lows = closed.map((k) => Number(k[3]));

  const raw: Array<{ price: number; touches: number }> = [];
  const m = closed.length;
  for (let i = 2; i < m - 2; i++) {
    if (
      highs[i] >= highs[i - 1] &&
      highs[i] >= highs[i - 2] &&
      highs[i] >= highs[i + 1] &&
      highs[i] >= highs[i + 2]
    ) {
      raw.push({ price: highs[i], touches: 1 });
    }
    if (
      lows[i] <= lows[i - 1] &&
      lows[i] <= lows[i - 2] &&
      lows[i] <= lows[i + 1] &&
      lows[i] <= lows[i + 2]
    ) {
      raw.push({ price: lows[i], touches: 1 });
    }
  }
  raw.push({ price: Math.max(...highs), touches: 1 }); // 窗口最高
  raw.push({ price: Math.min(...lows), touches: 1 }); // 窗口最低

  raw.sort((a, b) => a.price - b.price);
  const clusters: Array<{ price: number; touches: number }> = [];
  for (const lv of raw) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(lv.price - last.price) / last.price < 0.006) {
      last.price = (last.price * last.touches + lv.price) / (last.touches + 1);
      last.touches += 1;
    } else {
      clusters.push({ price: lv.price, touches: lv.touches });
    }
  }

  const supports = clusters.filter((c) => c.price <= price * 0.999);
  const resists = clusters.filter((c) => c.price >= price * 1.001);
  const nearest = (arr: Array<{ price: number; touches: number }>) =>
    arr.reduce<(typeof arr)[number] | null>(
      (best, c) =>
        best == null || Math.abs(c.price - price) < Math.abs(best.price - price) ? c : best,
      null,
    );

  const sup = nearest(supports);
  const res = nearest(resists);

  return {
    symbol,
    base,
    price,
    change24h: meta.change24h,
    quoteVolume24h: meta.quoteVolume24h,
    support: sup
      ? { price: sup.price, touches: sup.touches, distancePct: ((sup.price - price) / price) * 100 }
      : null,
    resist: res
      ? { price: res.price, touches: res.touches, distancePct: ((res.price - price) / price) * 100 }
      : null,
  };
}
