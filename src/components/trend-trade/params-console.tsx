'use client';

// ---------- 参数控制台（Task 57-c：用户可自行更改自动开仓参数） ----------
// 数据源 = overview config.params（服务端 PARAM_DEFS 定义 + 当前生效值）：
// 泛化渲染（分组/类型/范围/说明全部来自服务端定义），未来新增参数无需改本组件。
// 保存 = setRuntimeParams（全量值；服务端严格校验后持久化并热生效，轮次状态保留）；
// 恢复默认 = resetRuntimeParams。1m 趋势确认固定需 3 根已收盘 K 线（平台状态机，不在可调范围）。
// 结构：外层 Dialog + 内层表单仅在 open 时挂载——草稿状态在挂载时初始化一次，
// 5s 轮询刷新 overview 不会中途重置用户未保存的编辑。

import { useMemo, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import type { RuntimeParamItem } from '@/hooks/use-trend-trade';

export function ParamsConsole({
  open,
  onOpenChange,
  params,
  busy,
  onSave,
  onReset,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  params: RuntimeParamItem[];
  busy: boolean;
  /** 全量保存（键 → 值）；错误文案由服务端返回、调用方 toast */
  onSave: (values: Record<string, number | boolean>) => void;
  /** 恢复代码默认值 */
  onReset: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(680px,96vw)] max-h-[88vh] overflow-y-auto">
        <DialogTitle className="flex items-center gap-1.5 text-lg font-bold">
          <SlidersHorizontal className="h-4 w-4 text-gold" /> 自动开仓参数控制台
        </DialogTitle>
        <DialogDescription className="text-xs">
          保存后<b>立即生效</b>（无需重启；轮次状态保留）。灰色小字为参数含义；「已自定义」=
          当前值与代码默认不同。1m 趋势确认固定需 3 根已收盘 K 线（平台状态机设计，不在可调范围）。
        </DialogDescription>
        {open && (
          <ParamsForm params={params} busy={busy} onSave={onSave} onReset={onReset} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ParamsForm({
  params,
  busy,
  onSave,
  onReset,
}: {
  params: RuntimeParamItem[];
  busy: boolean;
  onSave: (values: Record<string, number | boolean>) => void;
  onReset: () => void;
}) {
  // 挂载时初始化一次（number 用字符串编辑，避免中途 NaN）
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() => {
    const next: Record<string, string | boolean> = {};
    for (const p of params) next[p.key] = p.type === 'number' ? String(p.value) : Boolean(p.value);
    return next;
  });

  // 分组（保持服务端定义顺序）
  const groups = useMemo(() => {
    const out: { group: string; items: RuntimeParamItem[] }[] = [];
    for (const p of params) {
      const g = out.find((x) => x.group === p.group);
      if (g) g.items.push(p);
      else out.push({ group: p.group, items: [p] });
    }
    return out;
  }, [params]);

  const dirtyCount = params.filter((p) => {
    const d = draft[p.key];
    if (p.type === 'number') return d !== undefined && Number(d) !== p.default;
    return d !== undefined && d !== p.default;
  }).length;

  const save = () => {
    const values: Record<string, number | boolean> = {};
    for (const p of params) {
      const d = draft[p.key];
      if (p.type === 'number') {
        const n = Number(d);
        values[p.key] = Number.isFinite(n) ? n : p.value;
      } else {
        values[p.key] = d === undefined ? Boolean(p.value) : Boolean(d);
      }
    }
    onSave(values);
  };

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.group} className="rounded-lg border border-border/60 bg-secondary/10 p-2.5">
          <div className="mb-1.5 text-[11px] font-bold text-foreground/80">{g.group}</div>
          <div className="space-y-2.5">
            {g.items.map((p) => {
              const d = draft[p.key];
              const curNum = p.type === 'number' ? Number(d) : NaN;
              const invalid =
                p.type === 'number' &&
                (!Number.isFinite(curNum) ||
                  (p.min != null && curNum < p.min) ||
                  (p.max != null && curNum > p.max));
              const differs = p.type === 'number' ? Number(d) !== p.default : d !== p.default;
              return (
                <div key={p.key} className="flex items-start gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
                      {p.label}
                      {p.overridden && (
                        <span className="rounded bg-gold/15 px-1 py-px text-[9px] font-bold text-gold">已自定义</span>
                      )}
                      {differs && !p.overridden && (
                        <span className="rounded bg-up/15 px-1 py-px text-[9px] font-bold text-up">保存后生效</span>
                      )}
                      <span className="font-normal text-muted-foreground">{p.desc}</span>
                    </div>
                    {p.effect && (
                      <div className="mt-0.5 text-[10px] text-muted-foreground/75">↕ {p.effect}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {p.type === 'number' ? (
                      <>
                        <Input
                          value={typeof d === 'string' ? d : String(d ?? '')}
                          onChange={(e) =>
                            setDraft((s) => ({ ...s, [p.key]: e.target.value.replace(/[^\d.]/g, '') }))
                          }
                          inputMode="decimal"
                          aria-label={p.label}
                          className={cn(
                            'h-7 w-[92px] text-right font-mono text-[11px] tabular-nums',
                            invalid && 'border-down',
                          )}
                        />
                        <span className="w-6 text-[10px] text-muted-foreground">{p.unit ?? ''}</span>
                        <button
                          className="rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground hover:text-gold disabled:opacity-40"
                          disabled={!p.overridden || busy}
                          onClick={() => setDraft((s) => ({ ...s, [p.key]: String(p.default) }))}
                          title={`恢复默认 ${typeof p.default === 'number' ? p.default : p.default}`}
                        >
                          默认
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="text-[10px] text-muted-foreground">{d === false ? '关' : '开'}</span>
                        <Switch
                          checked={d !== false}
                          disabled={busy}
                          onCheckedChange={(v) => setDraft((s) => ({ ...s, [p.key]: v }))}
                          aria-label={p.label}
                        />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2">
        <button
          className="rounded border border-border px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground hover:border-down/50 hover:text-down disabled:opacity-40"
          disabled={busy}
          onClick={onReset}
          title="恢复全部参数为代码默认值（二次确认回开、冷却回默认；轮次状态保留）"
        >
          恢复全部默认
        </button>
        <div className="ml-auto text-[10px] text-muted-foreground">
          {dirtyCount > 0 ? (
            <span className="text-gold">{dirtyCount} 项与默认不同</span>
          ) : (
            '全部与代码默认一致'
          )}
        </div>
        <button
          className="rounded-md bg-gold px-4 py-1.5 text-xs font-bold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={busy || Object.values(draft).some((v) => v === '')}
          onClick={save}
        >
          {busy ? '保存中…' : '保存并生效'}
        </button>
      </div>
    </div>
  );
}
