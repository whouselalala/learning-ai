process.env.DB_FILE = ':memory:';
process.env.TTS_PROVIDER = 'mock';

import test from 'node:test';
import assert from 'node:assert/strict';

const { getDb, now } = await import('../src/db.js');
const { ensureUserByOpenid, activateMembership } = await import('../src/lib/users.js');
const { endSession, startSession, heartbeat, topup, walletView, trialSecondsLeft } = await import('../src/lib/billing.js');
const { id } = await import('../src/lib/ids.js');

const db = getDb();

function newUser(openid) {
  return ensureUserByOpenid(openid, { nickname: openid }).user;
}

/** 直接造一条“过去 N 秒”的会话再结算，绕开真实等待 */
function consume(userId, seconds) {
  const startedAt = now() - seconds * 1000 - 1500;
  const sessionId = id('ses');
  db.prepare(
    `INSERT INTO sessions (id, user_id, lesson_id, started_at, last_beat_at, status)
     VALUES (?, ?, NULL, ?, ?, 'active')`,
  ).run(sessionId, userId, startedAt, now() - 100);
  return endSession(sessionId, userId, seconds);
}

test('60 分钟体验：按秒累计，体验内不扣钱', () => {
  const u = newUser('t_trial');
  const r1 = consume(u.id, 600);
  assert.equal(r1.trialSeconds, 600);
  assert.equal(r1.paidSeconds, 0);
  assert.equal(r1.costFen, 0);
  assert.equal(r1.wallet.trialSecondsLeft, 3000);
  assert.equal(r1.funding, 'trial');

  const r2 = consume(u.id, 3000);
  assert.equal(r2.trialSeconds, 3000);
  assert.equal(r2.costFen, 0);
  assert.equal(r2.wallet.trialSecondsLeft, 0);
});

test('体验用完后：非会员不能开课，绕过入口也不会被扣钱', () => {
  const u = newUser('t_gate');
  consume(u.id, 3600);
  assert.throws(() => startSession(u.id), (err) => err.code === 'NEED_MEMBERSHIP' && err.status === 402);

  const r = consume(u.id, 120);
  assert.equal(r.paidSeconds, 0);
  assert.equal(r.costFen, 0);
  assert.equal(r.status, 'insufficient');
  assert.equal(r.shortfallSeconds, 120);
});

test('会员计费：0.8 元/分钟，按秒精确到分', () => {
  const u = newUser('t_member');
  consume(u.id, 3600);
  activateMembership(u.id);
  topup(u.id, { amountFen: 2000 });

  const ten = consume(u.id, 600);
  assert.equal(ten.paidSeconds, 600);
  assert.equal(ten.costFen, 800, '10 分钟应扣 8.00 元');
  assert.equal(ten.wallet.cashFen, 1200);

  const thirty = consume(u.id, 30);
  assert.equal(thirty.costFen, 40, '30 秒应扣 0.40 元');

  const one = consume(u.id, 1);
  assert.equal(one.costFen, 1, '不足 1 分按 1 分收，避免白听');
});

test('余额不足：只扣得起的部分，并标记 insufficient', () => {
  const u = newUser('t_poor');
  consume(u.id, 3600);
  activateMembership(u.id);
  topup(u.id, { amountFen: 1000 });
  db.prepare('UPDATE wallets SET cash_fen = 50 WHERE user_id = ?').run(u.id);

  const r = consume(u.id, 300);
  assert.equal(r.status, 'insufficient');
  assert.ok(r.paidSeconds > 0 && r.paidSeconds < 300);
  assert.ok(r.costFen <= 50);
  assert.ok(r.shortfallSeconds > 0);
  assert.equal(walletView(u.id).cashFen, 50 - r.costFen);
});

test('一次会话最多结算 4 小时，防止计时被挂住', () => {
  const u = newUser('t_cap');
  topup(u.id, { amountFen: 100000 });
  activateMembership(u.id);
  db.prepare('UPDATE wallets SET trial_seconds_used = 3600 WHERE user_id = ?').run(u.id);
  const r = consume(u.id, 10 * 3600);
  assert.equal(r.paidSeconds, 4 * 3600);
  assert.equal(r.costFen, 4 * 60 * 80);
});

test('钱包视图字段与体验余额一致', () => {
  const u = newUser('t_view');
  consume(u.id, 1200);
  const view = walletView(u.id);
  assert.equal(view.trialSecondsLeft, trialSecondsLeft({ trial_seconds_used: 1200 }));
  assert.equal(view.trialSecondsLeft, 2400);
  assert.equal(view.priceFenPerMinute, 80);
});

test('心跳到点会通知客户端停止，避免非会员挂机白听', () => {
  // 非会员：只留 5 秒体验，听了 10 秒就该停
  const u = newUser('t_stop_trial');
  consume(u.id, 3595);
  const s = startSession(u.id);
  db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(Date.now() - 10000, s.sessionId);
  const hb = heartbeat(s.sessionId, u.id, 10);
  assert.equal(hb.shouldStop, true);
  assert.equal(hb.stopReason, 'NEED_MEMBERSHIP');
  assert.equal(hb.trialSecondsLeft, 0);
  endSession(s.sessionId, u.id, 10);

  // 会员：余额只够 20 分，听了 60 秒（应扣 80 分）也该停
  const m = newUser('t_stop_cash');
  consume(m.id, 3600);
  activateMembership(m.id);
  topup(m.id, { amountFen: 1000 });
  db.prepare('UPDATE wallets SET cash_fen = 20 WHERE user_id = ?').run(m.id);
  const s2 = startSession(m.id);
  db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(Date.now() - 60000, s2.sessionId);
  const hb2 = heartbeat(s2.sessionId, m.id, 60);
  assert.equal(hb2.shouldStop, true);
  assert.equal(hb2.stopReason, 'LOW_BALANCE');
  const r2 = endSession(s2.sessionId, m.id, 60);
  assert.equal(r2.status, 'insufficient');
  assert.ok(r2.costFen <= 20);
});
