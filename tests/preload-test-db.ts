// ---------- bun test 全局 preload（bunfig.toml [test].preload） ----------
// 在任何测试文件加载前把 DATABASE_URL 指到趋势交易独立测试库——
// 消除「测试文件加载顺序不可控导致 @/lib/db 单例绑错库」的问题。
// 说明：trend-watch/repo.test.ts 自建 client（datasources 显式指定），不受影响；
//       service/lifecycle 测试用 fake 注入或纯函数，不触库。
process.env.DATABASE_URL = 'file:/home/z/my-project/db/trend-trade-test.db';
export {};
