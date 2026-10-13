// ---------- 数字 / 时间格式化（客户端安全） ----------

export function fmtPrice(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '—';
  const abs = Math.abs(p);
  if (abs >= 10_000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 100) return p.toFixed(2);
  if (abs >= 1) return p.toFixed(4);
  if (abs >= 0.01) return p.toFixed(5);
  // 极小价格：保留 4 位有效数字
  return p.toPrecision(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

/** 成交额 → 万 / 亿（中文单位） */
export function fmtVol(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  if (v >= 1000) return Math.round(v).toLocaleString('en-US');
  return v.toFixed(0);
}

/** 成交数量：按量级动态精度 */
export function fmtQty(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 100_000) return Math.round(v).toLocaleString('en-US');
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (abs >= 1) return v.toFixed(3);
  if (abs >= 0.01) return v.toFixed(5);
  return v.toPrecision(4);
}

export function fmtMult(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(1) + '×';
}

export function fmtTime(iso: string | number): string {
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

/** 紧凑时分（HH:MM）：事件标签 / 小空间标注触发时间用 */
export function fmtHM(iso: string | number): string {
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}

/** 紧凑相对时间（事件标签用）：纯秒数累计，如 45秒前 / 1740秒前（不显示刚刚/分钟） */
export function fmtAgoShort(ts: number | null | undefined): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  return `${s}秒前`;
}

export function pctClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return 'text-muted-foreground';
  return v > 0 ? 'text-up' : 'text-down';
}

/** 轻量图表价格精度 */
export function pricePrecision(p: number): { precision: number; minMove: number } {
  const abs = Math.abs(p);
  if (abs >= 10_000) return { precision: 2, minMove: 0.01 };
  if (abs >= 100) return { precision: 2, minMove: 0.01 };
  if (abs >= 1) return { precision: 4, minMove: 0.0001 };
  if (abs >= 0.01) return { precision: 5, minMove: 0.00001 };
  return { precision: 8, minMove: 0.00000001 };
}
