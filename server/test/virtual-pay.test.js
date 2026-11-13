import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

Object.assign(process.env, {
  PAY_PROVIDER: 'virtual',
  VIRTUAL_PAY_ENV: '1',
  VIRTUAL_PAY_OFFER_ID: 'test-offer',
  VIRTUAL_PAY_APP_KEY_SANDBOX: 'test-app-key',
  VIRTUAL_PAY_PRODUCTS_JSON: '{"1000":"test-credits"}',
  WX_APPID: 'test-app',
  WX_SECRET: 'test-secret',
});

const { openDatabase, setDb, closeDb } = await import('../src/db.js');
const { ensureUserByOpenid } = await import('../src/lib/users.js');
const { createTopupOrder, confirmVirtualOrder, mockPay, refundOrder } = await import('../src/lib/payment.js');
const { walletView } = await import('../src/lib/billing.js');

test('虚拟支付必须经微信查单，核对金额并且只入账一次', async (t) => {
  const db = openDatabase(':memory:');
  setDb(db);
  t.after(closeDb);
  const { user } = ensureUserByOpenid('wx-user');
  db.prepare('UPDATE users SET wx_session_key = ? WHERE id = ?').run('test-session', user.id);
  const { order, payParams } = await createTopupOrder(user.id, { amountFen: 1000 });
  const hmac = (key, value) => createHmac('sha256', key).update(value).digest('hex');
  assert.equal(payParams.paySig, hmac('test-app-key', 'requestVirtualPayment&' + payParams.signData));
  assert.equal(payParams.signature, hmac('test-session', payParams.signData));
  assert.equal(JSON.parse(payParams.signData).productId, 'test-credits');
  assert.throws(() => mockPay(user.id, order.id), { code: 'MOCK_DISABLED' });
  await assert.rejects(confirmVirtualOrder('other-user', order.id), { code: 'ORDER_NOT_FOUND' });

  let status = 1;
  let paid = 999;
  let acknowledgments = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.pathname === '/cgi-bin/stable_token') {
      return Response.json({ access_token: 'token', expires_in: 7200 });
    }
    assert.equal(url.searchParams.get('pay_sig'), hmac('test-app-key', url.pathname + '&' + options.body));
    assert.equal(JSON.parse(options.body).order_id, order.outTradeNo);
    if (url.pathname === '/xpay/query_order') {
      return Response.json({ order: { order_id: order.outTradeNo, status, paid_fee: paid } });
    }
    assert.equal(url.pathname, '/xpay/notify_provide_goods');
    acknowledgments += 1;
    return Response.json({ errcode: 0 });
  });
  assert.equal((await confirmVirtualOrder(user.id, order.id)).status, 'pending');
  status = 2;
  await assert.rejects(confirmVirtualOrder(user.id, order.id), { code: 'AMOUNT_MISMATCH' });
  assert.equal(walletView(user.id).cashFen, 0);
  paid = 1000;
  assert.equal((await confirmVirtualOrder(user.id, order.id)).status, 'paid');
  await confirmVirtualOrder(user.id, order.id);
  assert.equal(walletView(user.id).cashFen, 1000);
  assert.equal(acknowledgments, 1);
  await assert.rejects(refundOrder({ orderId: order.id, amountFen: 1000 }), { code: 'REFUND_CHANNEL' });
});
