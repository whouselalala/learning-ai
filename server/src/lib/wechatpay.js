import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.js';

/**
 * 微信支付 APIv3 极简客户端（零依赖，node:crypto 手写签名/验签/解密）。
 *
 * 资金流说明：
 *   用户付款 → 微信支付 → 【商户号绑定的对公账户】T+1 结算。
 *   平台只负责下单、验签、记账，全程不碰资金，不做"二清"。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readPem(p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(ROOT, p);
  return fs.readFileSync(abs, 'utf8');
}

export class WechatPay {
  constructor(options) {
    this.appId = options.appId;
    this.mchId = options.mchId;
    this.serialNo = options.serialNo;
    this.privateKey = options.privateKeyPem
      ? crypto.createPrivateKey(options.privateKeyPem)
      : null;
    this.platformPublicKey = options.platformPublicKeyPem
      ? crypto.createPublicKey(options.platformPublicKeyPem)
      : null;
    this.platformPublicKeyId = options.platformPublicKeyId || '';
    this.apiV3Key = options.apiV3Key || '';
    this.baseUrl = (options.baseUrl || 'https://api.mch.weixin.qq.com').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl || fetch;
  }

  /* ---------------------------------------------------------- 签名/验签 */

  /** RSA-SHA256（PKCS#1 v1.5），微信支付要求的就是这个 */
  sign(message) {
    if (!this.privateKey) throw new Error('缺少商户私钥（WXPAY_PRIVATE_KEY_PATH）');
    return crypto.sign('RSA-SHA256', Buffer.from(message, 'utf8'), this.privateKey).toString('base64');
  }

  verify(message, signature) {
    if (!this.platformPublicKey) throw new Error('缺少微信支付平台公钥（WXPAY_PLATFORM_PUBLIC_KEY_PATH）');
    return crypto.verify(
      'RSA-SHA256',
      Buffer.from(message, 'utf8'),
      this.platformPublicKey,
      Buffer.from(signature, 'base64'),
    );
  }

  /** 组装 Authorization 头 */
  authorization(method, urlPath, body = '') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = this.sign(message);
    return (
      `WECHATPAY2-SHA256-RSA2048 mchid="${this.mchId}",nonce_str="${nonce}",` +
      `signature="${signature}",timestamp="${timestamp}",serial_no="${this.serialNo}"`
    );
  }

  /* -------------------------------------------------------------- 请求 */

  async request(method, urlPath, bodyObj) {
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const res = await this.fetchImpl(`${this.baseUrl}${urlPath}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: this.authorization(method, urlPath, body),
        'User-Agent': 'learning-ai/0.1',
      },
      body: body || undefined,
      signal: AbortSignal.timeout(20000),
    });

    const text = await res.text();
    if (res.headers && typeof res.headers.get === 'function') {
      const sig = res.headers.get('wechatpay-signature');
      if (sig) {
        const ts = res.headers.get('wechatpay-timestamp') || '';
        const nonce = res.headers.get('wechatpay-nonce') || '';
        const ok = this.verify(`${ts}\n${nonce}\n${text}\n`, sig);
        if (!ok) throw new Error('微信支付响应验签失败');
      }
    }

    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      const err = new Error(`微信支付 ${res.status}: ${data.message || text.slice(0, 200)}`);
      err.code = data.code;
      err.httpStatus = res.status;
      throw err;
    }
    return data;
  }

  /* -------------------------------------------------------- 回调与解密 */

  /** 验证异步通知签名；不通过必须拒绝 */
  verifyNotify(headers, rawBody) {
    const h = (k) => headers[k] || headers[k.toLowerCase()];
    const timestamp = h('wechatpay-timestamp');
    const nonce = h('wechatpay-nonce');
    const signature = h('wechatpay-signature');
    if (!timestamp || !nonce || !signature) throw new Error('回调缺少验签头');

    const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(skew) || skew > 300) throw new Error('回调时间戳超出 5 分钟，拒绝处理');

    const ok = this.verify(`${timestamp}\n${nonce}\n${rawBody}\n`, signature);
    if (!ok) throw new Error('回调验签失败');
    return true;
  }

  /** AES-256-GCM 解密回调 resource */
  decryptResource(resource) {
    if (!this.apiV3Key || this.apiV3Key.length !== 32) throw new Error('WXPAY_APIV3_KEY 必须是 32 位');
    const data = Buffer.from(resource.ciphertext, 'base64');
    const authTag = data.subarray(data.length - 16);
    const encrypted = data.subarray(0, data.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(this.apiV3Key), Buffer.from(resource.nonce));
    decipher.setAuthTag(authTag);
    if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data));
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  }

  /* --------------------------------------------------------- 支付接口 */

  /** JSAPI/小程序下单 */
  async createJsapiOrder({ outTradeNo, description, amountFen, openid, notifyUrl, expireAt }) {
    const payload = {
      appid: this.appId,
      mchid: this.mchId,
      description: description.slice(0, 127),
      out_trade_no: outTradeNo,
      notify_url: notifyUrl,
      amount: { total: amountFen, currency: 'CNY' },
      payer: { openid },
    };
    if (expireAt) payload.time_expire = new Date(expireAt).toISOString().replace(/\.\d{3}Z$/, '+00:00');
    return this.request('POST', '/v3/pay/transactions/jsapi', payload);
  }

  /** 小程序端调起支付需要的签名参数 */
  jsapiPayParams(prepayId) {
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const pkg = `prepay_id=${prepayId}`;
    const message = `${this.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
    return {
      timeStamp,
      nonceStr,
      package: pkg,
      signType: 'RSA',
      paySign: this.sign(message),
    };
  }

  async queryOrder(outTradeNo) {
    return this.request(
      'GET',
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(this.mchId)}`,
    );
  }

  async closeOrder(outTradeNo) {
    return this.request('POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`, {
      mchid: this.mchId,
    });
  }

  /** 退款（原路退回，钱从对公账户协议扣回） */
  async refund({ outTradeNo, outRefundNo, refundFen, totalFen, reason }) {
    return this.request('POST', '/v3/refund/domestic/refunds', {
      out_trade_no: outTradeNo,
      out_refund_no: outRefundNo,
      reason: (reason || '').slice(0, 80),
      amount: { refund: refundFen, total: totalFen, currency: 'CNY' },
    });
  }
}

let singleton = null;

export function getWechatPay() {
  if (singleton) return singleton;
  const cfg = config.pay.wxpay;
  singleton = new WechatPay({
    appId: config.wechat.appId,
    mchId: cfg.mchId,
    serialNo: cfg.serialNo,
    privateKeyPem: cfg.privateKeyPath ? readPem(cfg.privateKeyPath) : '',
    apiV3Key: cfg.apiV3Key,
    platformPublicKeyPem: cfg.platformPublicKeyPath ? readPem(cfg.platformPublicKeyPath) : '',
    platformPublicKeyId: cfg.platformPublicKeyId,
    baseUrl: cfg.baseUrl,
  });
  return singleton;
}

export function setWechatPayForTest(instance) {
  singleton = instance;
}

export function payConfigProblem() {
  const cfg = config.pay.wxpay;
  const missing = [];
  if (!config.wechat.appId) missing.push('WX_APPID');
  if (!cfg.mchId) missing.push('WXPAY_MCHID');
  if (!cfg.serialNo) missing.push('WXPAY_SERIAL_NO');
  if (!cfg.privateKeyPath) missing.push('WXPAY_PRIVATE_KEY_PATH');
  if (!cfg.apiV3Key || cfg.apiV3Key.length !== 32) missing.push('WXPAY_APIV3_KEY(32位)');
  if (!cfg.platformPublicKeyPath) missing.push('WXPAY_PLATFORM_PUBLIC_KEY_PATH');
  if (!config.pay.notifyUrl) missing.push('WXPAY_NOTIFY_URL');
  return missing;
}
