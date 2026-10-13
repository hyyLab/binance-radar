import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 盈亏着色：正=涨色 / 负=跌色 / 零=弱化 */
export function pnlCls(v: number) {
  if (v > 0) return 'text-up';
  if (v < 0) return 'text-down';
  return 'text-muted-foreground';
}
