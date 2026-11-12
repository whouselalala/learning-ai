process.env.DB_FILE = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { WechatPay } = await import('../src/lib/wechatpay.js');

const API_V3_KEY = '01234567890123456789012345678901';

function keypair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

const merchant = keypair();
const platform = keypair();

function makeClient(overrides = {}) {
  return new WechatPay({
    appId: 'wx_test_appid',
    mchId: '1900000001',
    serialNo: 'MERCHANT_SERIAL_01',
    privateKeyPem: merchant.privateKey,
    platformPublicKeyPem: platform.publicKey,
    apiV3Key: API_V3_KEY,
    ...overrides,
  });
}

function parseAuth(header) {
  const get = (k) => header.match(new RegExp(`${k}="([^"]*)"`))[1];
  return {
    mchid: get('mchid'),
    nonce: get('nonce_str'),
    signature: get('signature'),
    timestamp: get('timestamp'),
    serial: get('serial_no'),
  };
}

test('Authorization 头格式正确，且能用商户公钥验签', () => {
  const client = makeClient();
  const body = JSON.stringify({ appid: 'wx_test_appid' });
  const header = client.authorization('POST', '/v3/pay/transactions/jsapi', body);

  assert.ok(header.startsWith('WECHATPAY2-SHA256-RSA2048 '));
  const a = parseAuth(header);
  assert.equal(a.mchid, '1900000001');
  assert.equal(a.serial, 'MERCHANT_SERIAL_01');
  assert.match(a.timestamp, /^\d{10}$/);

  const message = `POST\n/v3/pay/transactions/jsapi\n${a.timestamp}\n${a.nonce}\n${body}\n`;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(message), merchant.publicKey, Buffer.from(a.signature, 'base64'));
  assert.equal(ok, true);
});

test('回调验签：正常通过，篡改内容或重放都会失败', () => {
  const client = makeClient();
  const rawBody = JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', id: 'evt_1' });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = 'notify_nonce_123';
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`), platform.privateKey)
    .toString('base64');

  const headers = {
    'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce,
    'wechatpay-signature': signature,
    'wechatpay-serial': 'PLATFORM_KEY_ID',
  };

  assert.equal(client.verifyNotify(headers, rawBody), true);

  // 篡改 body
  assert.throws(() => client.verifyNotify(headers, rawBody.replace('SUCCESS', 'FAIL')), /验签失败/);
  // 缺少验签头
  assert.throws(() => client.verifyNotify({}, rawBody), /缺少验签头/);
  // 重放：10 分钟前的时间戳
  const oldTs = String(Math.floor(Date.now() / 1000) - 600);
  const oldSig = crypto
    .sign('RSA-SHA256', Buffer.from(`${oldTs}\n${nonce}\n${rawBody}\n`), platform.privateKey)
    .toString('base64');
  assert.throws(
    () => client.verifyNotify({ ...headers, 'wechatpay-timestamp': oldTs, 'wechatpay-signature': oldSig }, rawBody),
    /超出 5 分钟/,
  );
});

test('回调解密：AES-256-GCM 能还原出明文 JSON', () => {
  const client = makeClient();
  const nonce = Buffer.from('abcdefghijkl');
  const aad = 'transaction';
  const plain = JSON.stringify({ out_trade_no: 'TP2026001', amount: { total: 2000 }, trade_state: 'SUCCESS' });

  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY), nonce);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');

  const decoded = client.decryptResource({ ciphertext, nonce: nonce.toString(), associated_data: aad });
  assert.deepEqual(decoded, JSON.parse(plain));

  // 换一个 key 必须解不开
  const wrong = makeClient({ apiV3Key: 'ffffffffffffffffffffffffffffffff' });
  assert.throws(() => wrong.decryptResource({ ciphertext, nonce: nonce.toString(), associated_data: aad }));
});

test('小程序调起支付的签名参数可被验证', () => {
  const client = makeClient();
  const params = client.jsapiPayParams('wx_prepay_123');
  assert.equal(params.signType, 'RSA');
  assert.equal(params.package, 'prepay_id=wx_prepay_123');

  const message = `wx_test_appid\n${params.timeStamp}\n${params.nonceStr}\n${params.package}\n`;
  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(message),
    merchant.publicKey,
    Buffer.from(params.paySign, 'base64'),
  );
  assert.equal(ok, true);
});

test('下单请求体会带上 appid/mchid/金额/openid/回调地址', async () => {
  const calls = [];
  const client = makeClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ prepay_id: 'wx_prepay_abc' }),
      };
    },
  });

  const out = await client.createJsapiOrder({
    outTradeNo: 'TP2026002',
    description: '习声AI 学习时长充值 20.00 元',
    amountFen: 2000,
    openid: 'o_test_openid',
    notifyUrl: 'https://api.example.com/api/pay/notify',
  });

  assert.equal(out.prepay_id, 'wx_prepay_abc');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/v3/pay/transactions/jsapi'));
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.appid, 'wx_test_appid');
  assert.equal(body.mchid, '1900000001');
  assert.deepEqual(body.amount, { total: 2000, currency: 'CNY' });
  assert.equal(body.payer.openid, 'o_test_openid');
  assert.equal(body.notify_url, 'https://api.example.com/api/pay/notify');
  assert.ok(calls[0].init.headers.Authorization.startsWith('WECHATPAY2-SHA256-RSA2048'));
});

test('响应验签失败时拒绝采信（防中间人篡改）', async () => {
  const client = makeClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (k) => (k === 'wechatpay-signature' ? 'ZmFrZQ==' : k === 'wechatpay-timestamp' ? '1' : 'x'),
      },
      text: async () => JSON.stringify({ prepay_id: 'wx_forged' }),
    }),
  });
  await assert.rejects(
    () =>
      client.createJsapiOrder({
        outTradeNo: 'TP1',
        description: 'x',
        amountFen: 1000,
        openid: 'o1',
        notifyUrl: 'https://example.com/n',
      }),
    /验签失败/,
  );
});
