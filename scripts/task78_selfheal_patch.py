#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Task 78 自愈机制：运行中连接遭遇 1032 readonly（平台快照替换 db 文件，Task 54/70/78
三次现场）时，自动 $disconnect() 触发 Prisma 惰性重连——重连会重新 open 当前路径文件
并重新校验/获取锁，实测可恢复写能力（scripts/task78_reconnect_probe.ts / probe2.ts 两轮验证）。

改动集中在 auto-trader.ts：
1. 新增私有方法 selfHealIfReadonly(e)：/readonly|1032/i 命中 → db.$disconnect() + 审计日志；
   无命中不动连接（零开销）。
2. 三处 catch（reconcile / tick / MAJOR P1 事件循环）fire-and-forget 调用——
   disconnect 后 finally 释放 ticking，下个 tick（10s 后）惰性重连，30 秒内自愈。
"""

import io
import sys

PATH = 'src/lib/market/trend-trade/auto-trader.ts'
with io.open(PATH, encoding='utf-8') as f:
    src = f.read()

SELF_HEAL_METHOD = """  /**
   * Task 78：readonly 自愈——平台快照替换 db 文件（内容/锁状态）会让运行中 Prisma 连接
   * 永久 1032 readonly（Task 54/70/78 三次现场；文件本身可直写）。实测 $disconnect() 后
   * 惰性重连可恢复写能力（重连重新 open 当前文件并校验锁，scripts/task78_reconnect_probe*.ts）。
   * 命中 readonly 错误即断开连接，下个 tick 惰性重连自愈；非 readonly 错误零开销返回。
   */
  private async selfHealIfReadonly(e: unknown): Promise<void> {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/readonly|1032/i.test(msg)) return;
    if (this.readonlyHealing) return; // 同一轮 healing 进行中，避免并发重复断开
    this.readonlyHealing = true;
    try {
      await db.$disconnect();
      logDecision('检测到数据库连接 readonly（平台快照替换文件），已断开等待惰性重连自愈（下个 tick 生效）');
    } catch {
      /* disconnect 失败忽略——下个 tick 重试 */
    } finally {
      // 给惰性重连留出窗口后复位；期间新错误也不会重复断开（连接已在重连路径上）
      setTimeout(() => (this.readonlyHealing = false), 5_000).unref?.();
    }
  }

"""

pairs = [
    # 1) 私有字段 readonlyHealing（放 lastError 声明旁）
    (
        """  private lastTickAt = 0;
  private lastError: string | null = null;""",
        """  private lastTickAt = 0;
  private lastError: string | null = null;
  /** Task 78：readonly 自愈去重（断开→惰性重连窗口期内不重复触发） */
  private readonlyHealing = false;""",
        'readonlyHealing 字段',
    ),
    # 2) selfHealIfReadonly 方法（插在 get lastErr() 前）
    (
        """  get lastErr(): string | null {
    return this.lastError;
  }""",
        SELF_HEAL_METHOD + """  get lastErr(): string | null {
    return this.lastError;
  }""",
        'selfHealIfReadonly 方法',
    ),
    # 3) reconcile catch
    (
        """    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[trend-auto] reconcile 失败：', this.lastError);
    }""",
        """    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[trend-auto] reconcile 失败：', this.lastError);
      void this.selfHealIfReadonly(e);
    }""",
        'reconcile catch 自愈',
    ),
    # 4) tick catch
    (
        """    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[trend-auto] tick 失败：', this.lastError);
    } finally {""",
        """    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[trend-auto] tick 失败：', this.lastError);
      void this.selfHealIfReadonly(e);
    } finally {""",
        'tick catch 自愈',
    ),
    # 5) MAJOR P1 catch（变量名 error）
    (
        """    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn('[trend-auto] MAJOR P1 事件循环失败：', this.lastError);
    } finally {""",
        """    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn('[trend-auto] MAJOR P1 事件循环失败：', this.lastError);
      void this.selfHealIfReadonly(error);
    } finally {""",
        'MAJOR P1 catch 自愈',
    ),
]

for old, new, tag in pairs:
    n = src.count(old)
    if n != 1:
        print(f'[FAIL] {tag}: 锚命中 {n} 处')
        sys.exit(1)
    src = src.replace(old, new)
    print(f'[OK] {tag}')

with io.open(PATH, 'w', encoding='utf-8') as f:
    f.write(src)
print('自愈机制补丁完成')
