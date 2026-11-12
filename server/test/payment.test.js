process.env.DB_FILE = ':memory:';
process.env.PAY_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import test from 'node:test';
import assert from 'node:assert/strict';

const { getDb, now } = await import('../src/db.js');
const { ensureUserByOpenid } = await import('../src/lib/users.js');
const { walletView, topup } = await import('../src/lib/billing.js');
const {
  createTopupOrder,
  mockPay,
  markOrderPaid,
  refundOrder,
  closeExpiredOrders,
  getOrderForUser,
  listOrders,
} = await import('../src/lib/payment.js');

const db = getDb();
const rand = () => Math.random().toString(36).slice(2, 9);
const newUser = () => ensureUserByOpenid(`pay_${rand()}`, { nickname: '支付测试' }).user;

test('下单金额校验：下限 10 元、上限 1000 元', async () => {
  const u = newUser();
  await assert.rejects(() => createTopupOrder(u.id, { amountFen: 100 }), (e) => e.code === 'AMOUNT_TOO_SMALL');
  await assert.rejects(() => createTopupOrder(u.id, { amountFen: 100001 }), (e) => e.code === 'AMOUNT_TOO_LARGE');
  await assert.rejects(() => createTopupOrder(u.id, { amountFen: 'abc' }), (e) => e.code === 'BAD_AMOUNT');

  const { order, payParams } = await createTopupOrder(u.id, { amountFen: 2000 });
  assert.equal(order.status, 'pending');
  assert.equal(order.amountFen, 2000);
  assert.equal(payParams.provider, 'mock');
  assert.match(order.outTradeNo, /^TP/);
});

test('模拟支付：入账、订单状态、流水三处一致', async () => {
  const u = newUser();
  const { order } = await createTopupOrder(u.id, { amountFen: 2000 });
  const out = mockPay(u.id, order.id);

  assert.equal(out.paid, true);
  assert.equal(out.alreadyPaid, false);
  assert.equal(out.order.status, 'paid');
  assert.equal(walletView(u.id).cashFen, 2000);

  const ledger = db.prepare('SELECT * FROM ledger WHERE user_id = ? ORDER BY rowid DESC').all(u.id);
  assert.equal(ledger[0].kind, 'topup');
  assert.equal(ledger[0].amount_fen, 2000);
  assert.equal(ledger[0].balance_after_fen, 2000);
});

test('重复支付回调/重复点击：不会重复加钱', async () => {
  const u = newUser();
  const { order } = await createTopupOrder(u.id, { amountFen: 3000 });
  mockPay(u.id, order.id);
  const again = mockPay(u.id, order.id);

  assert.equal(again.alreadyPaid, true);
  assert.equal(walletView(u.id).cashFen, 3000);

  const paid = markOrderPaid(order.id, { transactionId: 'WX123', paidFen: 3000 });
  assert.equal(paid.alreadyPaid, true);
  assert.equal(walletView(u.id).cashFen, 3000);
});

test('回调金额与订单不一致：转 exception，不入账', async () => {
  const u = newUser();
  const { order } = await createTopupOrder(u.id, { amountFen: 2000 });
  assert.throws(() => markOrderPaid(order.id, { transactionId: 'WX_BAD', paidFen: 1 }), (e) => e.code === 'AMOUNT_MISMATCH');
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  assert.equal(row.status, 'exception');
  assert.equal(walletView(u.id).cashFen, 0);
});

test('退款：只能退未消费余额，分次退款状态正确', async () => {
  const u = newUser();
  const { order } = await createTopupOrder(u.id, { amountFen: 3000 });
  mockPay(u.id, order.id);

  const r1 = await refundOrder({ orderId: order.id, amountFen: 1000, reason: '用户申请' });
  assert.equal(r1.refund.status, 'success');
  assert.equal(walletView(u.id).cashFen, 2000);
  assert.equal(getOrderForUser(order.id, u.id).status, 'partial_refunded');
  assert.equal(getOrderForUser(order.id, u.id).refundedFen, 1000);

  const refundLedger = db.prepare(`SELECT * FROM ledger WHERE user_id = ? AND kind = 'refund'`).all(u.id);
  assert.equal(refundLedger.length, 1);
  assert.equal(refundLedger[0].amount_fen, -1000);

  await refundOrder({ orderId: order.id, amountFen: 2000, reason: '用户申请' });
  assert.equal(walletView(u.id).cashFen, 0);
  assert.equal(getOrderForUser(order.id, u.id).status, 'refunded');

  await assert.rejects(
    () => refundOrder({ orderId: order.id, amountFen: 100 }),
    (e) => e.code === 'ORDER_NOT_REFUNDABLE',
  );
});

test('退款超过订单余额 / 超过用户未消费余额都会被拒绝', async () => {
  const u = newUser();
  const { order } = await createTopupOrder(u.id, { amountFen: 2000 });
  mockPay(u.id, order.id);

  await assert.rejects(() => refundOrder({ orderId: order.id, amountFen: 3000 }), (e) => e.code === 'REFUND_TOO_LARGE');

  // 模拟用户已经把余额花掉
  db.prepare('UPDATE wallets SET cash_fen = 100 WHERE user_id = ?').run(u.id);
  await assert.rejects(
    () => refundOrder({ orderId: order.id, amountFen: 500 }),
    (e) => e.code === 'INSUFFICIENT_BALANCE',
  );
});

test('超时订单可被关闭，关闭后不能再支付', async () => {
  const u = newUser();
  const { order } = await createTopupOrder(u.id, { amountFen: 1000 });
  db.prepare('UPDATE orders SET expire_at = ? WHERE id = ?').run(now() - 1000, order.id);

  const out = await closeExpiredOrders();
  assert.ok(out.closed >= 1);
  assert.equal(getOrderForUser(order.id, u.id).status, 'closed');
  assert.throws(() => mockPay(u.id, order.id), (e) => e.code === 'ORDER_NOT_PENDING');
});

test('单日充值上限 2000 元', async () => {
  const u = newUser();
  // 直接造两笔已支付大额订单
  for (let i = 0; i < 2; i += 1) {
    const id = `ord_${rand()}`;
    db.prepare(
      `INSERT INTO orders (id, user_id, kind, amount_fen, status, channel, out_trade_no, created_at, paid_at)
       VALUES (?, ?, 'topup', 100000, 'paid', 'mock', ?, ?, ?)`,
    ).run(id, u.id, `TPX${rand()}`, now(), now());
  }
  await assert.rejects(() => createTopupOrder(u.id, { amountFen: 1000 }), (e) => e.code === 'DAILY_LIMIT');
});

test('演示充值接口仍可用（mock 通道）', () => {
  const u = newUser();
  const out = topup(u.id, { amountFen: 1500 });
  assert.equal(out.amountFen, 1500);
  assert.equal(walletView(u.id).cashFen, 1500);
});

test('订单列表能按状态筛选', () => {
  const items = listOrders({ status: 'paid', limit: 10 });
  assert.ok(Array.isArray(items));
  assert.ok(items.every((o) => o.status === 'paid'));
});
