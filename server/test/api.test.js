process.env.DB_FILE = ':memory:';
process.env.TTS_PROVIDER = 'mock';
process.env.TRIAL_SECONDS = '60';
process.env.MIN_WITHDRAW_FEN = '100';
// 接口测试里把「计入序号」的门槛降到 8 元，一笔 10 分钟消费即可达标
process.env.REFERRAL_QUALIFY_FEN = '800';
process.env.ADMIN_SECRET = 'test-admin';
process.env.TOKEN_SECRET = 'test-secret';

import test from 'node:test';
import assert from 'node:assert/strict';

const { getDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

const { server } = createApp();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const db = getDb();

test.after(() => server.close());

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

async function login(code, extra = {}) {
  const res = await call('POST', '/api/auth/login', { body: { code, ...extra } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

/** 把会话开始时间往前拨，模拟真实听课 */
function backdate(sessionId, seconds) {
  db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(Date.now() - seconds * 1000 - 2000, sessionId);
}

/** 把 60 秒体验额度听完，让后续会话进入会员计费 */
async function burnTrial(token) {
  const s = await call('POST', '/api/sessions', { token, body: {} });
  backdate(s.body.session.sessionId, 60);
  await call('POST', `/api/sessions/${s.body.session.sessionId}/end`, { token, body: { playedSeconds: 60 } });
}

test('健康检查与公开配置', async () => {
  const health = await call('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const cfg = await call('GET', '/api/config');
  assert.equal(cfg.body.priceFenPerMinute, 80);
  assert.equal(cfg.body.trialSeconds, 60);
  assert.deepEqual(cfg.body.referral.ladder, [2000, 5000, 7000]);
  assert.equal(cfg.body.referral.qualifyFen, 800);
  assert.match(cfg.body.referral.qualifyLabel, /8 元/);
});

test('未登录访问受保护接口返回 401', async () => {
  const res = await call('GET', '/api/me');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'UNAUTHORIZED');
});

test('登录即注册，带邀请码自动绑定推荐人', async () => {
  const a = await login('api_a');
  assert.ok(a.token);
  assert.equal(a.created, true);
  assert.match(a.user.inviteCode, /^[A-Z0-9]{6}$/);

  const b = await login('api_b', { inviteCode: a.user.inviteCode });
  assert.equal(b.created, true);
  assert.equal(b.referral.id, a.user.id);

  const again = await login('api_a');
  assert.equal(again.created, false, '同一 openid 不会重复注册');
});

test('对话会写长期记忆，并能生成学习方案', async () => {
  const { token } = await login('api_chat');
  const res = await call('POST', '/api/chat', {
    token,
    body: { text: '我高二，数学函数和导数总丢分，每天能学 40 分钟，想冲 120 分' },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.reply.length > 20);
  assert.ok(res.body.memories.length >= 3);
  assert.equal(res.body.plan, null);

  const planRes = await call('POST', '/api/chat', { token, body: { text: '帮我排一个 4 周的提升方案', wantPlan: true } });
  assert.equal(planRes.status, 200);
  assert.ok(planRes.body.plan.id);
  assert.equal(planRes.body.plan.weeks, 4);

  const detail = await call('GET', `/api/plans/${planRes.body.plan.id}`, { token });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.weeks.length, 4);

  const week = await call('POST', `/api/plans/${planRes.body.plan.id}/weeks/1/lessons`, { token });
  assert.equal(week.status, 200);
  assert.equal(week.body.lessons.length, 3);
  assert.ok(week.body.lessons[0].title.length > 0);

  const lessonId = week.body.lessons[0].id;
  const audio = await call('POST', `/api/lessons/${lessonId}/audio`, { token });
  assert.equal(audio.status, 200);
  assert.ok(audio.body.lesson.script.length > 300);
  assert.equal(audio.body.lesson.audioAvailable, false, 'MOCK 模式不生成音频文件，但讲稿可用');
});

test('60 分钟体验 → 会员 → 0.8 元/分钟 的完整闸门', async () => {
  const { token } = await login('api_pay');

  const quote = await call('GET', '/api/billing/quote', { token });
  assert.equal(quote.body.quote.trialSecondsLeft, 60);

  const s1 = await call('POST', '/api/sessions', { token, body: {} });
  assert.equal(s1.status, 200);
  assert.equal(s1.body.session.funding, 'trial');
  backdate(s1.body.session.sessionId, 60);

  const hb = await call('POST', `/api/sessions/${s1.body.session.sessionId}/heartbeat`, { token, body: { playedSeconds: 30 } });
  assert.equal(hb.status, 200);

  const end1 = await call('POST', `/api/sessions/${s1.body.session.sessionId}/end`, { token, body: { playedSeconds: 60 } });
  assert.equal(end1.status, 200);
  assert.equal(end1.body.receipt.trialSeconds, 60);
  assert.equal(end1.body.receipt.costFen, 0);

  const blocked = await call('POST', '/api/sessions', { token, body: {} });
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.error.code, 'NEED_MEMBERSHIP');

  const activated = await call('POST', '/api/membership/activate', { token, body: {} });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.user.isMember, true);

  const noMoney = await call('POST', '/api/sessions', { token, body: {} });
  assert.equal(noMoney.status, 402);
  assert.equal(noMoney.body.error.code, 'NEED_TOPUP');

  const top = await call('POST', '/api/billing/topup', { token, body: { amountFen: 2000 } });
  assert.equal(top.status, 200);
  assert.equal(top.body.wallet.cashFen, 2000);

  const s2 = await call('POST', '/api/sessions', { token, body: {} });
  assert.equal(s2.status, 200);
  assert.equal(s2.body.session.funding, 'wallet');
  backdate(s2.body.session.sessionId, 600);

  const end2 = await call('POST', `/api/sessions/${s2.body.session.sessionId}/end`, { token, body: { playedSeconds: 600 } });
  assert.equal(end2.body.receipt.paidSeconds, 600);
  assert.equal(end2.body.receipt.costFen, 800, '10 分钟 = 8.00 元');
  assert.equal(end2.body.receipt.wallet.cashFen, 1200);

  const ledger = await call('GET', '/api/me/ledger', { token });
  const kinds = ledger.body.items.map((i) => i.kind);
  assert.ok(kinds.includes('topup'));
  assert.ok(kinds.includes('consume'));
  assert.ok(kinds.includes('trial'));
});

test('被推荐人消费，推荐人拿到 20% 佣金，T+7 后结算可提现', async () => {
  const owner = await login('api_owner');
  const buyer = await login('api_buyer', { inviteCode: owner.user.inviteCode });

  await burnTrial(buyer.token);
  await call('POST', '/api/membership/activate', { token: buyer.token, body: {} });
  await call('POST', '/api/billing/topup', { token: buyer.token, body: { amountFen: 2000 } });
  const start = await call('POST', '/api/sessions', { token: buyer.token, body: {} });
  assert.equal(start.status, 200);
  backdate(start.body.session.sessionId, 600);
  const end = await call('POST', `/api/sessions/${start.body.session.sessionId}/end`, {
    token: buyer.token,
    body: { playedSeconds: 600 },
  });
  assert.equal(end.body.receipt.costFen, 800);
  assert.equal(end.body.receipt.commission.totalFen, 160);

  const ref = await call('GET', '/api/referral', { token: owner.token });
  assert.equal(ref.status, 200);
  assert.equal(ref.body.mode, 'cycle');
  assert.equal(ref.body.totalTeam, 1);
  assert.equal(ref.body.directCount, 1);
  assert.equal(ref.body.members[0].ordinal, 1, '第 1 个直推会员');
  assert.equal(ref.body.members[0].rateBp, 2000, '第 1 个按 20%');
  assert.equal(ref.body.members[0].id, buyer.user.id);
  assert.equal(ref.body.members[0].pendingFen, 160);
  assert.equal(ref.body.byRate[0].pendingFen, 160);

  const noAuth = await call('POST', '/api/admin/settle-commissions', { body: { all: true } });
  assert.equal(noAuth.status, 403);

  const settle = await call('POST', '/api/admin/settle-commissions', {
    body: { all: true },
    headers: { 'x-admin-secret': 'test-admin' },
  });
  assert.equal(settle.status, 200);
  assert.ok(settle.body.settled >= 1);

  const after = await call('GET', '/api/referral', { token: owner.token });
  assert.equal(after.body.members[0].settledFen, 160);
  assert.ok(after.body.wallet.commissionFen >= 160);

  const wd = await call('POST', '/api/billing/withdraw', { token: owner.token, body: { amountFen: 160 } });
  assert.equal(wd.status, 200);
});

test('参数校验：空对话、超长文本、非法充值金额', async () => {
  const { token } = await login('api_bad');
  assert.equal((await call('POST', '/api/chat', { token, body: { text: '  ' } })).status, 400);
  assert.equal((await call('POST', '/api/chat', { token, body: { text: 'x'.repeat(2100) } })).status, 400);
  assert.equal((await call('POST', '/api/billing/topup', { token, body: { amountFen: 1 } })).status, 400);
  assert.equal((await call('GET', '/api/plans/not-exist', { token })).status, 404);
});

test('支付全链路：下单 → 支付 → 幂等 → 退款 → 回调拒绝伪签名', async () => {
  const { token } = await login('api_payer');

  const created = await call('POST', '/api/pay/order', { token, body: { amountFen: 2000 } });
  assert.equal(created.status, 200);
  assert.equal(created.body.payParams.provider, 'mock');
  const orderId = created.body.order.id;
  assert.equal(created.body.order.status, 'pending');

  const paid = await call('POST', '/api/pay/mock-pay', { token, body: { orderId } });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.wallet.cashFen, 2000);

  const again = await call('POST', '/api/pay/mock-pay', { token, body: { orderId } });
  assert.equal(again.body.alreadyPaid, true);
  assert.equal(again.body.wallet.cashFen, 2000, '重复支付不会重复加钱');

  const q = await call('GET', `/api/pay/orders/${orderId}`, { token });
  assert.equal(q.body.order.status, 'paid');

  // 伪造/缺失签名的回调必须被拒绝
  const badNotify = await call('POST', '/api/pay/notify', {
    headers: { 'wechatpay-timestamp': '1', 'content-type': 'application/json' },
    body: { event_type: 'TRANSACTION.SUCCESS' },
  });
  assert.equal(badNotify.status, 400);
  assert.equal(badNotify.body.code, 'FAIL');

  const noAuthRefund = await call('POST', '/api/admin/refund', { body: { orderId, amountFen: 500 } });
  assert.equal(noAuthRefund.status, 403);

  const refund = await call('POST', '/api/admin/refund', {
    body: { orderId, amountFen: 500, reason: '用户申请' },
    headers: { 'x-admin-secret': 'test-admin' },
  });
  assert.equal(refund.status, 200);
  assert.equal(refund.body.refund.status, 'success');

  const over = await call('POST', '/api/admin/refund', {
    body: { orderId, amountFen: 99999 },
    headers: { 'x-admin-secret': 'test-admin' },
  });
  assert.equal(over.status, 400);

  const me = await call('GET', '/api/me', { token });
  assert.equal(me.body.wallet.cashFen, 1500);

  const order = await call('GET', `/api/pay/orders/${orderId}`, { token });
  assert.equal(order.body.order.status, 'partial_refunded');
  assert.equal(order.body.order.refundedFen, 500);

  const adminOrders = await call('GET', '/api/admin/orders?status=partial_refunded', {
    headers: { 'x-admin-secret': 'test-admin' },
  });
  assert.equal(adminOrders.status, 200);
  assert.ok(adminOrders.body.items.some((o) => o.id === orderId));
});
