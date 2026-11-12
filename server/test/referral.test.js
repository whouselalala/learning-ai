process.env.DB_FILE = ':memory:';
process.env.TTS_PROVIDER = 'mock';

import test from 'node:test';
import assert from 'node:assert/strict';

const { getDb, now } = await import('../src/db.js');
const { ensureUserByOpenid, activateMembership } = await import('../src/lib/users.js');
const {
  bindReferrer,
  payCommissions,
  settlePending,
  referralSummary,
  uplineChain,
  rateForDepth,
  rateForOrdinal,
  rateForSequence,
  referralOrdinal,
  commissionPreview,
} = await import('../src/lib/referral.js');
const { endSession, topup, withdraw, walletView } = await import('../src/lib/billing.js');
const { id } = await import('../src/lib/ids.js');
const { config } = await import('../src/config.js');

const db = getDb();
const rand = () => Math.random().toString(36).slice(2, 10);

// 大多数用例只验证计提逻辑本身，把「满 100 元才计入序号」的门槛关掉；
// 门槛行为由单独的用例覆盖。
config.referral.qualifyFen = 0;

function newUser(openid) {
  return ensureUserByOpenid(openid, { nickname: openid }).user;
}

function consume(userId, seconds) {
  const startedAt = now() - seconds * 1000 - 1500;
  const sessionId = id('ses');
  db.prepare(
    `INSERT INTO sessions (id, user_id, lesson_id, started_at, last_beat_at, status)
     VALUES (?, ?, NULL, ?, ?, 'active')`,
  ).run(sessionId, userId, startedAt, now() - 100);
  return endSession(sessionId, userId, seconds);
}

function withMode(mode, fn) {
  const prev = config.referral.mode;
  config.referral.mode = mode;
  try {
    return fn();
  } finally {
    config.referral.mode = prev;
  }
}

/** 烧完体验额度 + 开通会员 + 充值，之后每 600 秒消费 800 分 */
function ready(user, cashFen = 20000) {
  consume(user.id, 3600);
  activateMembership(user.id);
  topup(user.id, { amountFen: cashFen });
}

/** owner 依次推荐 count 个会员，返回 [owner, m1, m2, ...] */
function buildReferrals(count) {
  const owner = newUser(`own_${rand()}`);
  const members = [];
  for (let i = 1; i <= count; i += 1) {
    const m = newUser(`ref_${rand()}`);
    bindReferrer(m.id, owner.invite_code);
    members.push(m);
  }
  return [owner, ...members];
}

/* ---------------------------------------------------------------- 比例 */

test('cycle 模式：每 3 个会员一轮，20% → 50% → 70% 循环', () => {
  assert.equal(rateForOrdinal(1), 2000);
  assert.equal(rateForOrdinal(2), 5000);
  assert.equal(rateForOrdinal(3), 7000);
  assert.equal(rateForOrdinal(4), 2000, '第 4 个重新回到 20%');
  assert.equal(rateForOrdinal(5), 5000);
  assert.equal(rateForOrdinal(6), 7000);
  assert.equal(rateForOrdinal(7), 2000);
  assert.equal(rateForOrdinal(9), 7000);
  assert.equal(rateForOrdinal(10), 2000);
  assert.equal(rateForOrdinal(0), 0);
});

test('depth / sequence 旧口径仍然可用', () => {
  assert.equal(rateForDepth(1), 2000);
  assert.equal(rateForDepth(2), 5000);
  assert.equal(rateForDepth(3), 7000);
  assert.equal(rateForDepth(4), 7000);

  assert.equal(rateForSequence(1), 2000);
  assert.equal(rateForSequence(2), 5000);
  assert.equal(rateForSequence(3), 7000);
  assert.equal(rateForSequence(4), 7000, 'sequence 不回落到 20%');
});

test('序号在「达标」时才分配，注册早但没消费不占位', () => {
  const owner = newUser(`own_${rand()}`);
  const placeholder = newUser(`ph_${rand()}`);
  const real = newUser(`re_${rand()}`);
  bindReferrer(placeholder.id, owner.invite_code);
  bindReferrer(real.id, owner.invite_code);

  assert.equal(referralOrdinal(owner.id, placeholder.id), 0, '没消费 → 未达标，序号 0');
  assert.equal(referralOrdinal(owner.id, real.id), 0);

  ready(real);
  consume(real.id, 600);
  assert.equal(referralOrdinal(owner.id, real.id), 1, '真实用户拿到第 1 个序号');
  assert.equal(referralOrdinal(owner.id, placeholder.id), 0, '占位小号没消费，永远不占序号');

  const preview = commissionPreview(real.id, 1000);
  assert.equal(preview.length, 1);
  assert.equal(preview[0].earnerId, owner.id);
  assert.equal(preview[0].rateBp, 2000);
  assert.equal(preview[0].amountFen, 200);

  assert.deepEqual(commissionPreview(placeholder.id, 1000), [], '未达标不分佣');
});

/* ---------------------------------------------------------------- 分佣 */

test('6 个直推会员依次消费：20% / 50% / 70% / 20% / 50% / 70%', () => {
  const [owner, ...members] = buildReferrals(6);
  const results = members.map((m) => {
    ready(m);
    return consume(m.id, 600); // 每次 800 分
  });

  assert.deepEqual(
    results.map((r) => r.commission.totalFen),
    [160, 400, 560, 160, 400, 560],
  );

  const rows = db.prepare('SELECT * FROM commissions WHERE earner_id = ? ORDER BY ordinal').all(owner.id);
  assert.deepEqual(rows.map((r) => r.ordinal), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(rows.map((r) => r.rate_bp), [2000, 5000, 7000, 2000, 5000, 7000]);
  assert.ok(rows.every((r) => r.depth === 1), '只有直推产生佣金');
  assert.equal(rows.reduce((s, r) => s + r.amount_fen, 0), 2240);
});

test('cycle 模式不做多级分佣：上级的上级拿不到钱', () => {
  const [owner, m1] = buildReferrals(1);
  const grand = newUser(`g_${rand()}`);
  bindReferrer(grand.id, m1.invite_code);

  ready(grand);
  const r = consume(grand.id, 600);
  assert.equal(r.commission.totalFen, 160, 'grand 是 m1 的第 1 个直推 → 20% × 800');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM commissions WHERE earner_id = ?').get(owner.id).c, 0);
});

test('体验课不产生佣金，只有真实消费才分佣', () => {
  const [, m1] = buildReferrals(1);
  const trial = consume(m1.id, 600);
  assert.equal(trial.costFen, 0);
  assert.equal(trial.commission.totalFen, 0);
});

test('70% 档位：8 元消费分 5.6 元', () => {
  const [owner, m1, m2, m3] = buildReferrals(3);
  // 序号按「达标先后」分配，所以前两个必须先消费，第三个才是第 3 个
  for (const m of [m1, m2]) {
    ready(m);
    consume(m.id, 600);
  }
  ready(m3);
  const r = consume(m3.id, 600);
  assert.equal(r.commission.totalFen, 560);
  assert.equal(walletView(owner.id).cashFen, 0);
});

test('depth 模式：三级佣金合计封顶 100%', () => {
  withMode('depth', () => {
    const A = newUser(`a_${rand()}`);
    const B = newUser(`b_${rand()}`);
    const C = newUser(`c_${rand()}`);
    const D = newUser(`d_${rand()}`);
    bindReferrer(B.id, A.invite_code);
    bindReferrer(C.id, B.invite_code);
    bindReferrer(D.id, C.invite_code);

    ready(D);
    const r = consume(D.id, 600);
    assert.equal(r.costFen, 800);
    assert.equal(r.commission.totalFen, 800);
    assert.equal(r.commission.capped, true);

    const rows = db.prepare('SELECT * FROM commissions WHERE payer_id = ? ORDER BY depth').all(D.id);
    assert.deepEqual(rows.map((x) => x.amount_fen), [160, 400, 240]);
  });
});

test('sequence 模式：递增到 70% 后不再回落', () => {
  withMode('sequence', () => {
    const [, m1, m2, m3, m4] = buildReferrals(4);
    const out = [m1, m2, m3, m4].map((m) => {
      ready(m);
      return consume(m.id, 600).commission.totalFen;
    });
    assert.deepEqual(out, [160, 400, 560, 560]);
  });
});

/* ---------------------------------------------------------------- 结算 */

test('T+N 结算：pending 转入可提现余额，可发起提现', () => {
  const prevMinWithdraw = config.minWithdrawFen;
  config.minWithdrawFen = 100;
  try {
    const [owner, m1, m2] = buildReferrals(2);
    ready(m1);
    consume(m1.id, 600); // 20% → 160
    ready(m2);
    consume(m2.id, 600); // 50% → 400

    assert.equal(walletView(owner.id).commissionFen, 0, '未结算前不可提现');
    const settled = settlePending({ all: true });
    assert.ok(settled.amountFen >= 560);
    assert.equal(walletView(owner.id).commissionFen, 560);

    const w = withdraw(owner.id, 200);
    assert.equal(w.amountFen, 200);
    assert.equal(walletView(owner.id).commissionFen, 360);
    assert.equal(walletView(owner.id).frozenFen, 200);
    assert.throws(() => withdraw(owner.id, 10000), (err) => err.code === 'INSUFFICIENT_COMMISSION');
    assert.throws(() => withdraw(owner.id, 1), (err) => err.code === 'AMOUNT_TOO_SMALL');
  } finally {
    config.minWithdrawFen = prevMinWithdraw;
  }
});

/* ---------------------------------------------------------------- 关系 */

test('拒绝成环、自我推荐与重复绑定', () => {
  const A = newUser(`x_${rand()}`);
  const B = newUser(`y_${rand()}`);
  bindReferrer(B.id, A.invite_code);
  assert.throws(() => bindReferrer(A.id, B.invite_code), (err) => err.code === 'REFERRAL_CYCLE');
  assert.throws(() => bindReferrer(A.id, A.invite_code), (err) => err.code === 'SELF_REFERRAL');
  assert.throws(() => bindReferrer(B.id, A.invite_code), (err) => err.code === 'ALREADY_BOUND');
  assert.throws(() => bindReferrer(A.id, 'NOTEXIST'), (err) => err.code === 'INVITE_CODE_NOT_FOUND');
});

test('推荐中心：直推名单带序号与比例，统计正确', () => {
  const [owner, m1, m2, m3] = buildReferrals(3);
  ready(m1);
  consume(m1.id, 600); // 第 1 个达标 → 20% → 160
  ready(m2);
  consume(m2.id, 600); // 第 2 个 → 50% → 400
  ready(m3);
  consume(m3.id, 600); // 第 3 个 → 90% → 720

  const summary = referralSummary(owner.id);
  assert.equal(summary.mode, 'cycle');
  assert.equal(summary.directCount, 3);
  assert.equal(summary.qualifiedCount, 3);
  assert.deepEqual(summary.members.map((m) => m.ordinal), [1, 2, 3]);
  assert.deepEqual(summary.members.map((m) => m.rateBp), [2000, 5000, 7000]);
  assert.equal(summary.members[0].pendingFen, 160);
  assert.equal(summary.members[1].pendingFen, 400);
  assert.equal(summary.members[2].pendingFen, 560);
  assert.equal(summary.pendingFen, 1120);
  assert.equal(summary.byRate.find((b) => b.rateBp === 2000).pendingFen, 160);
  assert.equal(summary.byRate.find((b) => b.rateBp === 5000).pendingFen, 400);
  assert.equal(summary.byRate.find((b) => b.rateBp === 7000).pendingFen, 560);
  assert.equal(summary.recent[0].rateLabel, '70%');
});

test('没有上级时分佣为空', () => {
  const solo = newUser(`solo_${rand()}`);
  const out = payCommissions({ payerId: solo.id, sessionId: null, baseFen: 1000 });
  assert.equal(out.items.length, 0);
  assert.equal(out.totalFen, 0);
});

test('uplineChain 仍可上溯（排查/审计用）', () => {
  const A = newUser(`u1_${rand()}`);
  const B = newUser(`u2_${rand()}`);
  const C = newUser(`u3_${rand()}`);
  bindReferrer(B.id, A.invite_code);
  bindReferrer(C.id, B.invite_code);
  const chain = uplineChain(C.id);
  assert.deepEqual(chain.map((n) => n.depth), [1, 2]);
  assert.equal(chain[1].id, A.id);
});

test('累计消费满 50 元才计入序号，达标前推荐人一分不拿', () => {
  const prev = config.referral.qualifyFen;
  config.referral.qualifyFen = 5000; // 50 元
  try {
    const [owner, m1] = buildReferrals(1);
    ready(m1, 30000);

    // 先听 50 分钟 = 40 元，没到 50 元
    const a = consume(m1.id, 3000);
    assert.equal(a.costFen, 4000);
    assert.equal(a.commission.totalFen, 0, '未达标不分佣');
    assert.equal(referralOrdinal(owner.id, m1.id), 0);

    // 再听 75 分钟 = 60 元，累计 100 元 → 达标，这一笔开始计提
    const b = consume(m1.id, 4500);
    assert.equal(b.costFen, 6000);
    assert.equal(b.commission.totalFen, 1200, '达标当笔按 20% 计提');
    assert.equal(referralOrdinal(owner.id, m1.id), 1);

    const row = db.prepare('SELECT qualify_ordinal, qualified_at FROM users WHERE id = ?').get(m1.id);
    assert.equal(row.qualify_ordinal, 1);
    assert.ok(row.qualified_at > 0);

    // 第二个会员一次消费满 100 元 → 序号 2 → 50%
    const m2 = newUser(`q2_${rand()}`);
    bindReferrer(m2.id, owner.invite_code);
    ready(m2, 30000);
    const c = consume(m2.id, 7500);
    assert.equal(c.costFen, 10000);
    assert.equal(c.commission.totalFen, 5000);
    assert.equal(referralOrdinal(owner.id, m2.id), 2);

    // 第三个会员只消费 40 元 → 不占序号、不计提
    const m3 = newUser(`q3_${rand()}`);
    bindReferrer(m3.id, owner.invite_code);
    ready(m3, 10000);
    consume(m3.id, 3000);

    const summary = referralSummary(owner.id);
    assert.equal(summary.directCount, 3);
    assert.equal(summary.qualifiedCount, 2);
    const third = summary.members.find((m) => m.id === m3.id);
    assert.equal(third.qualified, false);
    assert.equal(third.rateLabel, '未达标');
    assert.equal(third.ordinal, 0);
    assert.equal(third.progressPct, 80);
    assert.equal(third.pendingFen, 0);
    assert.equal(summary.pendingFen, 1200 + 5000);
  } finally {
    config.referral.qualifyFen = prev;
  }
});
