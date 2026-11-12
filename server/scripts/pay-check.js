/**
 * 微信支付配置自检：node server/scripts/pay-check.js
 * 加 --live 会真调一次微信接口（查询一笔不存在的订单），用来验证「商户号+证书序列号+私钥」是否匹配。
 * 返回 ORDER_NOT_EXIST 就说明签名已经通了。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.warn(`[warn] .env 解析失败：${err.message}`);
  }
}

const { config, payProvider } = await import('../src/config.js');
const { payConfigProblem, getWechatPay } = await import('../src/lib/wechatpay.js');

const live = process.argv.includes('--live');
const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ' — ' + detail : ''}`);
}
function warn(label, detail = '') {
  results.push({ label, ok: true, warning: true, detail });
  console.log(`△ ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('微信支付配置自检');
console.log('─'.repeat(52));
console.log(`支付通道：${payProvider}`);

if (payProvider !== 'wechat') {
  console.log('\n当前是 mock 通道（未配置或显式指定）。生产环境会拒绝启动。');
  console.log('需要配置的环境变量：' + payConfigProblem().join('、'));
}

const missing = payConfigProblem();
check('配置项完整性', missing.length === 0, missing.length ? `缺少 ${missing.join('、')}` : '全部已填');

const cfg = config.pay.wxpay;
const readPem = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.resolve(ROOT, p), 'utf8');

if (cfg.privateKeyPath) {
  try {
    const key = crypto.createPrivateKey(readPem(cfg.privateKeyPath));
    check('商户私钥可解析', true, `${key.asymmetricKeyType} ${key.asymmetricKeyDetails?.modulusLength || ''} 位`);
  } catch (err) {
    check('商户私钥可解析', false, err.message);
  }
}

if (cfg.platformPublicKeyPath) {
  try {
    const key = crypto.createPublicKey(readPem(cfg.platformPublicKeyPath));
    check('平台公钥可解析', true, `${key.asymmetricKeyType} ${key.asymmetricKeyDetails?.modulusLength || ''} 位`);
  } catch (err) {
    check('平台公钥可解析', false, err.message);
  }
}

check('APIv3 密钥长度', (cfg.apiV3Key || '').length === 32, `当前 ${(cfg.apiV3Key || '').length} 位（需要 32 位）`);
check('商户号格式', /^\d{6,}$/.test(cfg.mchId || ''), cfg.mchId ? `mchid=${cfg.mchId}` : '未填写');
check('证书序列号格式', /^[0-9A-Fa-f]{16,}$/.test(cfg.serialNo || ''), cfg.serialNo || '未填写');
check(
  '回调地址是 HTTPS',
  /^https:\/\//i.test(config.pay.notifyUrl || ''),
  config.pay.notifyUrl || '未填写（微信要求 https，且不能带参数）',
);
check(
  '回调地址不带参数',
  !config.pay.notifyUrl || !config.pay.notifyUrl.includes('?'),
  config.pay.notifyUrl && config.pay.notifyUrl.includes('?') ? '请去掉 ? 后面的部分' : '',
);

if (payProvider === 'wechat' && live) {
  console.log('\n调用微信支付接口验证签名（查询一笔不存在的订单）…');
  try {
    const wx = getWechatPay();
    await wx.queryOrder(`PRECHECK${Date.now()}`);
    check('接口连通与签名', true, '意外查询到了订单？');
  } catch (err) {
    const code = err.code || '';
    if (code === 'ORDER_NOT_EXIST' || err.httpStatus === 404) {
      check('接口连通与签名', true, '返回 ORDER_NOT_EXIST，说明签名/证书序列号/商户号匹配');
    } else if (code === 'SIGN_ERROR' || err.httpStatus === 401) {
      check('接口连通与签名', false, '签名错误：检查私钥与证书序列号是否同一套');
    } else {
      check('接口连通与签名', false, `${err.httpStatus || ''} ${code || err.message}`);
    }
  }
} else if (payProvider === 'wechat') {
  console.log('\n（加 --live 可真实调用接口验证签名）');
}

const failed = results.filter((r) => !r.ok);
console.log('─'.repeat(52));
console.log(failed.length ? `有 ${failed.length} 项未通过，按上面提示逐项修` : '全部通过，可以上线验证 1 元支付了');
process.exit(failed.length ? 1 : 0);
