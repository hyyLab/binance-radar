// ---------- 模拟建仓引擎（Paper Trading） ----------
// 规则（对齐币安 USDT-M 合约，见 ./futures）：初始 10 USDT；最高 20x；最低保证金 2 USDT；
// Taker 手续费 0.05%（开/平仓都收，Maker 0.02% 备案）；
// 强平价按币安逐仓精确式（分层维持保证金率）；触及强平价自动清算（小名义价值下亏损全部保证金）

import { db } from '@/lib/db';
import { collector } from './collector';
import {
  PAPER_INITIAL_CAPITAL,
  PAPER_MAX_LEVERAGE,
  PAPER_MIN_MARGIN,
  PAPER_MIN_DEPOSIT,
  PAPER_MAX_DEPOSIT,
  TAKER_FEE,
  liqPriceFor,
} from './futures';
import type {
  PaperAccountDTO,
  PaperPositionDTO,
  PaperTradeDTO,
} from './types';

export { TAKER_FEE };
export const INITIAL_CAPITAL = PAPER_INITIAL_CAPITAL;
export const MAX_LEVERAGE = PAPER_MAX_LEVERAGE;
export const MIN_MARGIN = PAPER_MIN_MARGIN;
export const MAX_OPEN_POSITIONS = 20;
export const MIN_DEPOSIT = PAPER_MIN_DEPOSIT;
export const MAX_DEPOSIT = PAPER_MAX_DEPOSIT;
const ACCOUNT_NAME = 'default';

const CLOSE_ACTIONS = ['CLOSE_LONG', 'CLOSE_SHORT'];

export class PaperError extends Error {}

export class PaperEngine {
  private async getAccount() {
    let acc = await db.paperAccount.findUnique({ where: { name: ACCOUNT_NAME } });
    if (!acc) {
      acc = await db.paperAccount.create({
        data: { name: ACCOUNT_NAME, balance: INITIAL_CAPITAL },
      });
    }
    return acc;
  }

  /** 公开：获取（或初始化）默认账户 ID */
  async getAccountId(): Promise<string> {
    const acc = await this.getAccount();
    return acc.id;
  }

  private markPrice(symbol: string): number {
    const row = collector.getTickers().find((t) => t.symbol === symbol);
    return row ? row.price : 0;
  }

  /** 强平检查：标记价触及强平价 → 自动清算（每次查询/交易前执行） */
  private async liquidationCheck(accountId: string): Promise<void> {
    const open = await db.paperPosition.findMany({ where: { accountId, status: 'OPEN' } });
    for (const p of open) {
      const mark = this.markPrice(p.symbol);
      if (mark <= 0) continue;
      const hit = p.side === 'LONG' ? mark <= p.liqPrice : mark >= p.liqPrice;
      if (!hit) continue;
      await db.paperPosition.update({
        where: { id: p.id },
        data: { status: 'LIQUIDATED', exitPrice: p.liqPrice, pnl: -p.margin, closedAt: new Date() },
      });
      await db.paperTrade.create({
        data: {
          accountId,
          positionId: p.id,
          symbol: p.symbol,
          action: 'LIQUIDATE',
          price: p.liqPrice,
          qty: p.qty,
          fee: 0,
          pnl: -p.margin,
        },
      });
    }
  }

  private dirSign(side: string): 1 | -1 {
    return side === 'LONG' ? 1 : -1;
  }

  async snapshot(): Promise<{
    account: PaperAccountDTO;
    positions: PaperPositionDTO[];
    history: PaperTradeDTO[];
    ts: number;
  }> {
    const acc = await this.getAccount();
    await this.liquidationCheck(acc.id);

    const openRows = await db.paperPosition.findMany({
      where: { accountId: acc.id, status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
    });
    const trades = await db.paperTrade.findMany({
      where: { accountId: acc.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    // 平仓行附带开仓手续费：从关联仓位取 openFee（开仓时已从余额扣除的费用，流水合并展示）
    const posIds = [
      ...new Set(
        trades
          .filter((t) => CLOSE_ACTIONS.includes(t.action))
          .map((t) => t.positionId)
          .filter((id): id is string => !!id),
      ),
    ];
    const openFeeMap = new Map<string, number>();
    if (posIds.length > 0) {
      const feeRows = await db.paperPosition.findMany({
        where: { id: { in: posIds } },
        select: { id: true, openFee: true },
      });
      for (const r of feeRows) openFeeMap.set(r.id, r.openFee);
    }

    let unrealized = 0;
    let marginUsed = 0;
    const positions: PaperPositionDTO[] = openRows.map((p) => {
      const mark = this.markPrice(p.symbol) || p.entryPrice;
      const sign = this.dirSign(p.side);
      const upnl = (mark - p.entryPrice) * p.qty * sign;
      unrealized += upnl;
      marginUsed += p.margin;
      return {
        id: p.id,
        symbol: p.symbol,
        base: p.base,
        side: p.side as 'LONG' | 'SHORT',
        leverage: p.leverage,
        margin: p.margin,
        qty: p.qty,
        entryPrice: p.entryPrice,
        markPrice: mark,
        liqPrice: p.liqPrice,
        notional: p.qty * mark,
        unrealizedPnl: upnl,
        roePct: p.margin > 0 ? (upnl / p.margin) * 100 : 0,
        openedAt: p.openedAt.toISOString(),
      };
    });

    const [realAgg, feeAgg, closedCount, liqCount, winCount] = await Promise.all([
      db.paperTrade.aggregate({
        where: { accountId: acc.id, action: { in: [...CLOSE_ACTIONS, 'LIQUIDATE'] } },
        _sum: { pnl: true },
      }),
      db.paperTrade.aggregate({ where: { accountId: acc.id }, _sum: { fee: true } }),
      db.paperPosition.count({ where: { accountId: acc.id, status: 'CLOSED' } }),
      db.paperPosition.count({ where: { accountId: acc.id, status: 'LIQUIDATED' } }),
      db.paperTrade.count({
        where: { accountId: acc.id, action: { in: CLOSE_ACTIONS }, pnl: { gt: 0 } },
      }),
    ]);

    const realizedPnl = realAgg._sum.pnl ?? 0;
    const feePaid = feeAgg._sum.fee ?? 0;
    const equity = acc.balance + marginUsed + unrealized;
    const decided = closedCount + liqCount;
    // ROI 本金基数 = 初始资金 + 累计充值（充值不算盈利）
    const principal = INITIAL_CAPITAL + acc.totalDeposited;

    const account: PaperAccountDTO = {
      balance: acc.balance,
      marginUsed,
      unrealizedPnl: unrealized,
      equity,
      initialCapital: INITIAL_CAPITAL,
      totalDeposited: acc.totalDeposited,
      realizedPnl,
      feePaid,
      winRate: decided > 0 ? (winCount / decided) * 100 : 0,
      closedCount,
      liquidatedCount: liqCount,
      roiPct: principal > 0 ? ((equity - principal) / principal) * 100 : 0,
    };

    const history: PaperTradeDTO[] = trades.map((t) => ({
      id: t.id,
      symbol: t.symbol,
      action: t.action as PaperTradeDTO['action'],
      price: t.price,
      qty: t.qty,
      fee: t.fee,
      pnl: t.pnl,
      createdAt: t.createdAt.toISOString(),
      openFee:
        CLOSE_ACTIONS.includes(t.action) && t.positionId
          ? openFeeMap.get(t.positionId)
          : undefined,
    }));

    return { account, positions, history, ts: Date.now() };
  }

  async open(input: {
    symbol: string;
    side: 'LONG' | 'SHORT';
    leverage: number;
    margin: number;
  }): Promise<PaperPositionDTO> {
    const symbol = input.symbol.toUpperCase();
    const price = this.markPrice(symbol);
    if (price <= 0) throw new PaperError('未知交易对或行情未就绪');
    if (!Number.isFinite(input.leverage) || input.leverage < 1 || input.leverage > MAX_LEVERAGE) {
      throw new PaperError(`杠杆需在 1-${MAX_LEVERAGE}x 之间`);
    }
    if (!Number.isFinite(input.margin) || input.margin < MIN_MARGIN) {
      throw new PaperError(`保证金至少 ${MIN_MARGIN} USDT`);
    }

    const acc = await this.getAccount();
    await this.liquidationCheck(acc.id);

    const dup = await db.paperPosition.findFirst({
      where: { accountId: acc.id, status: 'OPEN', symbol, side: input.side },
    });

    const openCount = await db.paperPosition.count({ where: { accountId: acc.id, status: 'OPEN' } });
    if (!dup && openCount >= MAX_OPEN_POSITIONS) {
      throw new PaperError(`最多同时持有 ${MAX_OPEN_POSITIONS} 个仓位`);
    }

    const fee = input.margin * input.leverage * TAKER_FEE;
    if (input.margin + fee > acc.balance) {
      throw new PaperError(
        `可用余额不足：需 ${input.margin.toFixed(2)} + 手续费 ${fee.toFixed(2)}，当前可用 ${acc.balance.toFixed(2)}`,
      );
    }

    const notional = input.margin * input.leverage;
    const qty = notional / price;

    // 同币同向已有持仓 → 加仓合并（加权均价重算开仓价，按合并后名义价值重算强平价）
    if (dup) {
      const mergedMargin = dup.margin + input.margin;
      const mergedQty = dup.qty + qty;
      const mergedEntry = (dup.entryPrice * dup.qty + price * qty) / mergedQty;
      const mergedNotional = mergedMargin * input.leverage;
      const mergedLiq = liqPriceFor({
        symbol,
        side: input.side,
        entry: mergedEntry,
        leverage: input.leverage,
        notional: mergedNotional,
      });
      await db.$transaction([
        db.paperPosition.update({
          where: { id: dup.id },
          data: {
            leverage: input.leverage,
            margin: mergedMargin,
            qty: mergedQty,
            entryPrice: mergedEntry,
            liqPrice: mergedLiq,
            openFee: dup.openFee + fee,
          },
        }),
        db.paperAccount.update({ where: { id: acc.id }, data: { balance: { decrement: input.margin + fee } } }),
        db.paperTrade.create({
          data: {
            accountId: acc.id,
            positionId: dup.id,
            symbol,
            action: input.side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
            price,
            qty,
            fee,
            pnl: 0,
          },
        }),
      ]);
      return {
        id: dup.id,
        symbol,
        base: dup.base,
        side: input.side,
        leverage: input.leverage,
        margin: mergedMargin,
        qty: mergedQty,
        entryPrice: mergedEntry,
        markPrice: price,
        liqPrice: mergedLiq,
        notional: mergedQty * price,
        unrealizedPnl: 0,
        roePct: 0,
        openedAt: dup.openedAt.toISOString(),
      };
    }

    const liqPrice = liqPriceFor({
      symbol,
      side: input.side,
      entry: price,
      leverage: input.leverage,
      notional,
    });

    const [pos] = await db.$transaction([
      db.paperPosition.create({
        data: {
          accountId: acc.id,
          symbol,
          base: symbol.replace(/USDT$/, ''),
          side: input.side,
          leverage: input.leverage,
          margin: input.margin,
          qty,
          entryPrice: price,
          liqPrice,
          openFee: fee,
        },
      }),
      db.paperAccount.update({ where: { id: acc.id }, data: { balance: { decrement: input.margin + fee } } }),
      db.paperTrade.create({
        data: {
          accountId: acc.id,
          symbol,
          action: input.side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
          price,
          qty,
          fee,
          pnl: 0,
        },
      }),
    ]);

    return {
      id: pos.id,
      symbol,
      base: pos.base,
      side: input.side,
      leverage: input.leverage,
      margin: input.margin,
      qty,
      entryPrice: price,
      markPrice: price,
      liqPrice,
      notional,
      unrealizedPnl: 0,
      roePct: 0,
      openedAt: pos.openedAt.toISOString(),
    };
  }

  async close(positionId: string): Promise<{ pnl: number; symbol: string; side: string; price: number }> {
    const acc = await this.getAccount();
    await this.liquidationCheck(acc.id);

    const pos = await db.paperPosition.findUnique({ where: { id: positionId } });
    if (!pos || pos.accountId !== acc.id) throw new PaperError('仓位不存在');
    if (pos.status !== 'OPEN') throw new PaperError('该仓位已平仓或已清算');

    const mark = this.markPrice(pos.symbol);
    if (mark <= 0) throw new PaperError('行情暂不可用，请稍后再试');

    const sign = this.dirSign(pos.side);
    const grossPnl = (mark - pos.entryPrice) * pos.qty * sign;
    const closeFee = mark * pos.qty * TAKER_FEE;
    // 净盈亏扣除双边手续费：开仓费（开仓时已从余额扣除）+ 平仓费（此处结算时扣除）
    const netPnl = grossPnl - closeFee - pos.openFee;

    await db.$transaction([
      db.paperPosition.update({
        where: { id: pos.id },
        data: {
          status: 'CLOSED',
          exitPrice: mark,
          pnl: netPnl,
          closeFee,
          closedAt: new Date(),
        },
      }),
      db.paperAccount.update({
        where: { id: acc.id },
        data: { balance: { increment: pos.margin + grossPnl - closeFee } },
      }),
      db.paperTrade.create({
        data: {
          accountId: acc.id,
          positionId: pos.id,
          symbol: pos.symbol,
          action: pos.side === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
          price: mark,
          qty: pos.qty,
          fee: closeFee,
          pnl: netPnl,
        },
      }),
    ]);

    return { pnl: netPnl, symbol: pos.symbol, side: pos.side, price: mark };
  }

  /** 充值：增加可用余额与本金基数（不计入盈亏） */
  async deposit(amount: number): Promise<{ balance: number; totalDeposited: number }> {
    if (!Number.isFinite(amount) || amount < MIN_DEPOSIT) {
      throw new PaperError(`单次充值至少 ${MIN_DEPOSIT} USDT`);
    }
    if (amount > MAX_DEPOSIT) {
      throw new PaperError(`单次充值不可超过 ${MAX_DEPOSIT.toLocaleString('en-US')} USDT`);
    }
    const acc = await this.getAccount();
    const updated = await db.paperAccount.update({
      where: { id: acc.id },
      data: {
        balance: { increment: amount },
        totalDeposited: { increment: amount },
      },
    });
    return { balance: updated.balance, totalDeposited: updated.totalDeposited };
  }

  /** 一键平仓所有持仓：逐仓按标记价市价平掉，跳过行情不可用的仓位 */
  async closeAll(): Promise<{
    closed: number;
    skipped: number;
    totalPnl: number;
    results: { symbol: string; side: string; pnl: number }[];
  }> {
    const acc = await this.getAccount();
    await this.liquidationCheck(acc.id);

    const open = await db.paperPosition.findMany({
      where: { accountId: acc.id, status: 'OPEN' },
      orderBy: { openedAt: 'asc' },
    });

    const results: { symbol: string; side: string; pnl: number }[] = [];
    let skipped = 0;
    let totalPnl = 0;

    for (const p of open) {
      // 逐仓复用 close（内部各自走事务，单仓失败不影响其余仓位）
      try {
        const r = await this.close(p.id);
        results.push({ symbol: r.symbol, side: r.side, pnl: r.pnl });
        totalPnl += r.pnl;
      } catch {
        skipped += 1;
      }
    }

    return { closed: results.length, skipped, totalPnl, results };
  }

  async reset(): Promise<void> {
    const acc = await this.getAccount();
    await db.$transaction([
      db.paperTrade.deleteMany({ where: { accountId: acc.id } }),
      db.paperPosition.deleteMany({ where: { accountId: acc.id } }),
      db.paperAccount.update({
        where: { id: acc.id },
        data: { balance: INITIAL_CAPITAL, totalDeposited: 0 },
      }),
    ]);
  }
}

const g = globalThis as typeof globalThis & {
  // v3: 平仓净盈亏改为双边手续费口径（净额扣开仓费）。bump key 以便 dev 热更新后重建引擎实例（本引擎无内存状态，安全）
  __binanceRadarPaper_v3?: PaperEngine;
};

export const paperEngine: PaperEngine = (g.__binanceRadarPaper_v3 ??= new PaperEngine());
