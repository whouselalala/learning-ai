import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name, fallback) {
  const raw = str(name, '');
  if (raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function json(name, fallback) {
  const raw = str(name, '');
  if (raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[config] ${name} 不是合法 JSON，已回退默认值`);
    return fallback;
  }
}

const dataDir = path.resolve(ROOT, str('DATA_DIR', 'data'));

export const config = {
  root: ROOT,
  port: num('PORT', 8787),
  dataDir,
  dbFile: path.resolve(ROOT, str('DB_FILE', path.join(dataDir, 'app.db'))),
  mediaDir: path.resolve(ROOT, str('MEDIA_DIR', path.join(dataDir, 'media'))),
  tokenSecret: str('TOKEN_SECRET', 'dev-secret-change-me'),
  tokenTtlSec: num('TOKEN_TTL_SEC', 60 * 60 * 24 * 30),
  adminSecret: str('ADMIN_SECRET', 'dev-admin'),

  // 试用与计费（金额统一用“分”，时间统一用“秒”）
  trialSeconds: num('TRIAL_SECONDS', 60 * 60),
  priceFenPerMinute: num('PRICE_FEN_PER_MINUTE', 80),
  minTopupFen: num('MIN_TOPUP_FEN', 1000), // 10 元起充
  minWithdrawFen: num('MIN_WITHDRAW_FEN', 1000),

  deepseek: {
    apiKey: str('DEEPSEEK_API_KEY', ''),
    baseUrl: str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    model: str('DEEPSEEK_MODEL', 'deepseek-chat'),
    timeoutMs: num('DEEPSEEK_TIMEOUT_MS', 60000),
  },

  wechat: {
    appId: str('WX_APPID', ''),
    secret: str('WX_SECRET', ''),
  },

  // 支付：wechat = 微信支付 APIv3（企业商户号，结算到对公账户）；mock = 本地演示
  pay: {
    provider: str('PAY_PROVIDER', ''), // 留空自动判断：配齐微信支付参数就用 wechat，否则 mock
    notifyUrl: str('WXPAY_NOTIFY_URL', ''),
    orderTtlSec: num('PAY_ORDER_TTL_SEC', 2 * 60 * 60),
    wxpay: {
      mchId: str('WXPAY_MCHID', ''),
      serialNo: str('WXPAY_SERIAL_NO', ''),
      privateKeyPath: str('WXPAY_PRIVATE_KEY_PATH', ''),
      apiV3Key: str('WXPAY_APIV3_KEY', ''),
      platformPublicKeyPath: str('WXPAY_PLATFORM_PUBLIC_KEY_PATH', ''),
      platformPublicKeyId: str('WXPAY_PLATFORM_PUBLIC_KEY_ID', ''),
      baseUrl: str('WXPAY_BASE_URL', 'https://api.mch.weixin.qq.com'),
    },
  },

  tts: {
    provider: str('TTS_PROVIDER', 'sapi'),
    voice: str('TTS_VOICE', 'Microsoft Huihui Desktop'),
    rate: num('TTS_RATE', 0),
    httpUrl: str('TTS_HTTP_URL', ''),
    httpKey: str('TTS_HTTP_KEY', ''),
  },

  referral: {
    // cycle：按「我直推的第几个达标会员」循环取比例（第1个20%、第2个50%、第3个70%，第4个回到20%…）
    // depth：按推荐层级（直推20%、二级50%、三级及以后70%）
    // sequence：按第几个会员递增，但第3个以后一直 70%（旧口径，保留兼容）
    mode: str('REFERRAL_MODE', 'cycle'),
    ladderBp: json('REFERRAL_LADDER_BP', [2000, 5000, 7000]),
    infiniteBp: num('REFERRAL_INFINITE_BP', 7000),
    capTotalBp: num('REFERRAL_CAP_TOTAL_BP', 10000),
    settleDays: num('COMMISSION_SETTLE_DAYS', 7),
    // 累计消费满多少「分」才计入序号（默认 5000 分 = 50 元）；设 0 表示不设门槛
    qualifyFen: num('REFERRAL_QUALIFY_FEN', 5000),
  },
};

/** 计费单价：分/秒（保留 4 位小数，只在汇总时取整，避免逐秒四舍五入累积误差） */
export const fenPerSecond = config.priceFenPerMinute / 60;

/** 是否处于离线 Mock 模式（没有配 DeepSeek Key 时） */
export const isMockLLM = !config.deepseek.apiKey;

/**
 * 支付通道。配齐微信支付参数就用真通道，否则退化为 mock。
 * 生产环境绝不允许 mock（在 index.js 启动时会直接拒绝启动）。
 */
export const payProvider =
  config.pay.provider ||
  (config.pay.wxpay.mchId &&
  config.pay.wxpay.serialNo &&
  config.pay.wxpay.privateKeyPath &&
  config.pay.wxpay.apiV3Key &&
  config.wechat.appId
    ? 'wechat'
    : 'mock');

export const isMockPay = payProvider !== 'wechat';
