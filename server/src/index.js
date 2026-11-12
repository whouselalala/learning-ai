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

// 生产环境绝不允许"模拟支付"：钱会凭空到账
if (process.env.NODE_ENV === 'production' && payProvider !== 'wechat') {
  console.error('\n[致命] 生产环境必须配置微信支付（PAY_PROVIDER=wechat 且参数齐全），不能用模拟支付。');
  console.error('缺失参数：' + payConfigProblem().join('、'));
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
  console.log(`  支付通道    ${payProvider === 'wechat' ? '微信支付 APIv3（结算到对公账户）' : '模拟支付（仅演示，生产会拒绝启动）'}`);
  console.log(`  语音合成    ${config.tts.provider} / ${config.tts.voice}`);
  console.log(`  免费体验    ${Math.round(config.trialSeconds / 60)} 分钟（累计，不按次重置）`);
  console.log(`  会员计费    ${(config.priceFenPerMinute / 100).toFixed(2)} 元/分钟`);
  console.log(`  推荐佣金    ${config.referral.mode} 模式，阶梯 ${config.referral.ladderBp.map((b) => `${b / 100}%`).join(' / ')}，单笔封顶 ${config.referral.capTotalBp / 100}%`);
  console.log(`  数据文件    ${config.dbFile}`);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在关闭…`);
    server.close(() => process.exit(0));
  });
}
