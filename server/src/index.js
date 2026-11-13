import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.warn(`[boot] .env 加载失败：${err.message}`);
  }
}

const { config, isMockLLM, payProvider } = await import('./config.js');
const { createApp } = await import('./app.js');
const { payConfigProblem } = await import('./lib/wechatpay.js');

const { virtualPayConfigProblems } = await import('./lib/virtual-pay.js');
const { reconcileVirtualOrders } = await import('./lib/payment.js');

const production = process.env.NODE_ENV === 'production';
const problems = [];
if (!['wechat', 'virtual', 'mock'].includes(payProvider)) problems.push('PAY_PROVIDER 无效');
if (payProvider === 'virtual') problems.push(...virtualPayConfigProblems());
if (production) {
  if (payProvider === 'mock') problems.push('生产环境必须配置真实支付');
  if (payProvider === 'wechat') problems.push(...payConfigProblem());
  if (payProvider === 'virtual' && config.pay.virtual.env !== 0) problems.push('生产环境必须使用虚拟支付现网');
  if (!config.wechat.appId || !config.wechat.secret) problems.push('WX_APPID / WX_SECRET');
  for (const name of ['TOKEN_SECRET', 'ADMIN_SECRET']) {
    if (!process.env[name] || process.env[name].length < 32 || process.env[name].startsWith('REPLACE_')) problems.push(name);
  }
}
if (problems.length) {
  console.error('[boot] 配置错误：' + problems.join('、'));
  process.exit(1);
}

const { server } = createApp();

server.listen(config.port, () => {
  const base = `http://127.0.0.1:${config.port}`;
  console.log('');
  console.log('  个性化学习 AI · 后端已启动');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  演示台      ${base}/`);
  console.log(`  健康检查    ${base}/api/health`);
  console.log(`  大模型      ${isMockLLM ? '离线规则引擎（未配置 DEEPSEEK_API_KEY）' : config.deepseek.model}`);
  console.log(`  支付通道    ${payProvider}`);
  console.log(`  语音合成    ${config.tts.provider} / ${config.tts.voice}`);
  console.log(`  免费体验    ${Math.round(config.trialSeconds / 60)} 分钟（累计，不按次重置）`);
  console.log(`  会员计费    ${(config.priceFenPerMinute / 100).toFixed(2)} 元/分钟`);
  console.log(`  推荐佣金    ${config.referral.mode} 模式，阶梯 ${config.referral.ladderBp.map((b) => `${b / 100}%`).join(' / ')}，单笔封顶 ${config.referral.capTotalBp / 100}%`);
  console.log(`  数据文件    ${config.dbFile}`);
  console.log('');
});

let reconciling = false;
const reconciliationTimer = payProvider === 'virtual' ? setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    await reconcileVirtualOrders();
  } catch (err) {
    console.error('[virtual-pay-reconcile]', err.message);
  } finally {
    reconciling = false;
  }
}, 60_000) : null;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在关闭…`);
    clearInterval(reconciliationTimer);
    server.close(() => process.exit(0));
  });
}
