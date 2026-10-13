// TradFi 股票代币识别单元测试
import { isStockBase, isExcludedBase, STOCK_TICKERS } from '../src/lib/market/stock-tokens';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}`); }
}

// 股票代币（B 后缀）
check('MSTRB 是股票', isStockBase('MSTRB') === true);
check('CRCLB 是股票', isStockBase('CRCLB') === true);
check('SPCSXB? 非股票代码表内→false', isStockBase('SPCSXB') === false);
check('SOXLB 是股票', isStockBase('SOXLB') === true);
check('NVDAB 是股票', isStockBase('NVDAB') === true);
// 未来新上市股票代币动态覆盖（代码表内 + B 后缀）
check('TSLAB 动态识别', isStockBase('TSLAB') === true);
// ETF
check('SPYB/QQQB 是股票(ETF)', isStockBase('SPYB') && isStockBase('QQQB'));
// 无 B 后缀裸代码不存在于币安，但函数语义上应命中
check('MSTR 命中代码表', isStockBase('MSTR') === true);
// 加密币不受影响
check('BTC 不是股票', isStockBase('BTC') === false);
check('S 不是股票', isStockBase('S') === false);
check('SBET 是股票(SBET 代码表内)', isStockBase('SBET') === true);
check('ORDI 不是股票(ORDI 不在表内，虽有 B 结尾? 否)', isStockBase('ORDI') === false);
// B 结尾但截断后不是股票代码：如 GLMR→GLMR 不以 B 结尾? 检查 HUMBB/HUMA+B 场景
check('HUMAB(胡马+B) 非表内→false', isStockBase('HUMAB') === false);
// 剔除函数：股票+贵金属+稳定币
check('isExcludedBase(MSTRB)', isExcludedBase('MSTRB'));
check('isExcludedBase(XAUT)', isExcludedBase('XAUT'));
check('isExcludedBase(PAXGB)', isExcludedBase('PAXGB'));
check('isExcludedBase(RLUSD)', isExcludedBase('RLUSD'));
check('isExcludedBase(BTC)=false', isExcludedBase('BTC') === false);
check('isExcludedBase(ETH)=false', isExcludedBase('ETH') === false);

console.log(`股票代币识别测试: ${pass} 通过 / ${fail} 失败 (代码表 ${STOCK_TICKERS?.size ?? 'n/a'})`);
process.exit(fail > 0 ? 1 : 0);
