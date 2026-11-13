import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { fail } from './http.js';

const apiOrigin = 'https://api.weixin.qq.com';
const hmac = (key, data) => createHmac('sha256', key).update(data).digest('hex');
let tokenCache;

export function virtualPayConfigProblems() {
  const { env, offerId, appKey, products } = config.pay.virtual;
  const problems = [];
  if (![0, 1].includes(env)) problems.push('VIRTUAL_PAY_ENV 必须为 0 或 1');
  if (!offerId) problems.push('VIRTUAL_PAY_OFFER_ID');
  if (!appKey) problems.push(env === 0 ? 'VIRTUAL_PAY_APP_KEY_PROD' : 'VIRTUAL_PAY_APP_KEY_SANDBOX');
  if (!products || typeof products !== 'object' || Array.isArray(products) || !Object.keys(products).length ||
      Object.entries(products).some(([amount, productId]) =>
        !/^[1-9]\d*$/.test(amount) || Number(amount) < config.minTopupFen || Number(amount) > 100000 ||
        typeof productId !== 'string' || !productId.trim()) ||
      new Set(Object.values(products)).size !== Object.keys(products).length) {
    problems.push('VIRTUAL_PAY_PRODUCTS_JSON 必须为分价到不同商品 ID 的映射');
  }
  if (!config.wechat.appId || !config.wechat.secret) problems.push('WX_APPID / WX_SECRET');
  return problems;
}

export function virtualParams({ amount, tradeNo, sessionKey }) {
  const problems = virtualPayConfigProblems();
  if (problems.length) throw fail(503, 'PAY_NOT_CONFIGURED', problems.join('、'));
  const { env, offerId, appKey, products } = config.pay.virtual;
  const productId = products[amount];
  if (!productId) throw fail(400, 'UNKNOWN_PRODUCT', '请选择已配置的听课额度商品');
  if (!sessionKey) throw fail(409, 'WX_LOGIN_REQUIRED', '请重新微信登录后支付');
  const signData = JSON.stringify({
    offerId, buyQuantity: 1, env, currencyType: 'CNY', productId,
    goodsPrice: amount, outTradeNo: tradeNo, attach: tradeNo,
  });
  return {
    provider: 'virtual',
    mode: 'short_series_goods',
    signData,
    paySig: hmac(appKey, 'requestVirtualPayment&' + signData),
    signature: hmac(sessionKey, signData),
  };
}

async function accessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.value;
  const response = await fetch(apiOrigin + '/cgi-bin/stable_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credential', appid: config.wechat.appId,
      secret: config.wechat.secret, force_refresh: false,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error('获取微信接口凭证失败');
  tokenCache = { value: data.access_token, expiresAt: Date.now() + Math.max(0, data.expires_in - 300) * 1000 };
  return tokenCache.value;
}

async function xpay(path, fields, env) {
  const body = JSON.stringify({ ...fields, env });
  const url = new URL(path, apiOrigin);
  url.searchParams.set('access_token', await accessToken());
  url.searchParams.set('pay_sig', hmac(config.pay.virtual.appKey, path + '&' + body));
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (data.errcode === 40001 || data.errcode === 42001) tokenCache = undefined;
  if (!response.ok || (data.errcode !== undefined && data.errcode !== 0)) {
    throw new Error('微信虚拟支付接口失败，错误码 ' + (data.errcode ?? response.status));
  }
  return data;
}

export async function queryVirtualOrder(order, openid) {
  const result = await xpay('/xpay/query_order', { openid, order_id: order.out_trade_no }, order.virtual_env);
  return result.order;
}

export function acknowledgeVirtualGoods(order) {
  return xpay('/xpay/notify_provide_goods', { order_id: order.out_trade_no }, order.virtual_env);
}
