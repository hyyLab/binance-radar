// ---------- MA(7) 沿线趋势 · 客户端安全辅助 ----------
// 独立于服务端引擎（ma7.ts 依赖 collector/数据库），仅含纯数据与格式化，
// 客户端组件可安全导入，不会把服务端依赖打进 bundle。

import type { Ma7Phase } from './market/types';

/** 趋势阶段元信息：FRESH(≤3h) / EARLY(3~10h) / MATURE(>10h)，按折算成线时长 */
export const PHASE_META: Record<Ma7Phase, { label: string; desc: string }> = {
  FRESH: { label: '刚启动', desc: '成线 ≤ 3 小时' },
  EARLY: { label: '早期', desc: '成线 3 ~ 10 小时' },
  MATURE: { label: '延续中', desc: '成线 > 10 小时' },
};

/** 折算成线时长（分钟）→ 中文可读 */
export function fmtRideDuration(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return '—';
  if (min < 60) return `${Math.round(min)} 分钟`;
  if (min < 60 * 24) return `${(min / 60).toFixed(1)} 小时`;
  return `${(min / (60 * 24)).toFixed(1)} 天`;
}

/** 折算成线时长（分钟）→ 紧凑格式（移动端） */
export function fmtRideDurationShort(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 60 * 24) return `${(min / 60).toFixed(1)}h`;
  return `${(min / (60 * 24)).toFixed(1)}d`;
}
