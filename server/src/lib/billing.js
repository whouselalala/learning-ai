import { getDb, tx, now } from '../db.js';
import { config, fenPerSecond } from '../config.js';
import { fail } from './http.js';
import { id, outTradeNo } from './ids.js';
import { getUser, isMember, publicUser } from './users.js';
import { payCommissions } from './referral.js';

const MAX_SESSION_SEC = 4 * 3600;

function ensureWalletWith(db, userId) {
  db.prepare(
    `INSERT INTO wallets (user_id, cash_fen, commission_fen, frozen_fen, trial_seconds_used, total_spent_fen, total_earned_fen, updated_at)
     VALUES (?, 0, 0, 0, 0, 0, 0, ?)
     ON CONFLICT(user_id) DO NOTHING`,
  ).run(userId, now());
}

export function getWallet(userId) {
  const db = getDb();
  let row = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  if (!row) {
    ensureWalletWith(db, userId);
    row = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  }
  return row;
}

export const ensureWallet = getWallet;

export function trialSecondsLeft(wallet) {
  return Math.max(0, config.trialSeconds - (wallet?.trial_seconds_used || 0));
}

/** 给前端用的钱包与计费视图 */
export function walletView(userId) {
  const user = getUser(userId);
  const w = getWallet(userId);
  return {
    cashFen: w.cash_fen,
    commissionFen: w.commission_fen,
    frozenFen: w.frozen_fen,
    trialSeconds: config.trialSeconds,
    trialSecondsUsed: w.trial_seconds_used,
    trialSecondsLeft: trialSecondsLeft(w),
    totalSpentFen: w.total_spent_fen,
    totalEarnedFen: w.total_earned_fen,
    priceFenPerMinute: config.priceFenPerMinute,
    minTopupFen: config.minTopupFen,
    minWithdrawFen: config.minWithdrawFen,
    isMember: isMember(user),
  };
}

export function billingQuote(userId) {
  const view = walletView(userId);
  return {
    trialSeconds: view.trialSeconds,
    trialSecondsLeft: view.trialSecondsLeft,
    priceFenPerMinute: view.priceFenPerMinute,
    priceLabel: `${(config.priceFenPerMinute / 100).toFixed(2)} 元/分钟`,
    isMember: view.isMember,
    cashFen: view.cashFen,
    affordableMinutes: Math.floor(view.cashFen / config.priceFenPerMinute),
    needMembership: !view.isMember && view.trialSecondsLeft <= 0,
  };
}

function addLedger(db, { userId, kind, balanceKind, amountFen, balanceAfterFen, refType, refId, memo }) {
  db.prepare(
    `INSERT INTO ledger (id, user_id, kind, balance_kind, amount_fen, balance_after_fen, ref_type, ref_id, memo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id('lg'), userId, kind, balanceKind, amountFen, balanceAfterFen, refType || null, refId || null, memo || null, now());
}

/**
 * 开始一次听课：先检查是否还能听（体验额度或会员余额），再开计时会话。
 * 服务端记录 started_at，结算时用服务端时间做上限，客户端上报只能更少不能更多。
 */
export function startSession(userId, lessonId = null) {
  const user = getUser(userId);
  if (!user) throw fail(404, 'USER_NOT_FOUND', '用户不存在');
  closeStaleSessions(userId);

  const w = ensureWallet(userId);
  const left = trialSecondsLeft(w);

  if (left <= 0 && !isMember(user)) {
    throw fail(402, 'NEED_MEMBERSHIP', '60 分钟免费体验已用完，开通会员后可继续学习', {
      code: 'NEED_MEMBERSHIP',
      trialSecondsLeft: 0,
      priceFenPerMinute: config.priceFenPerMinute,
    });
  }
  if (left <= 0 && w.cash_fen < Math.ceil(fenPerSecond * 10)) {
    throw fail(402, 'NEED_TOPUP', '会员余额不足，请先充值后继续', {
      code: 'NEED_TOPUP',
      cashFen: w.cash_fen,
      minTopupFen: config.minTopupFen,
    });
  }

  const db = getDb();
  const sessionId = id('ses');
  const ts = now();
  db.prepare(
    `INSERT INTO sessions (id, user_id, lesson_id, started_at, last_beat_at, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
  ).run(sessionId, userId, lessonId, ts, ts);

  return {
    sessionId,
    funding: left > 0 ? 'trial' : 'wallet',
    trialSecondsLeft: left,
    priceFenPerMinute: config.priceFenPerMinute,
    cashFen: w.cash_fen,
  };
}

export function heartbeat(sessionId, userId, playedSeconds = null) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!row) throw fail(404, 'SESSION_NOT_FOUND', '听课会话不存在');
  if (row.status !== 'active') return { status: row.status, serverSeconds: row.server_seconds };

  const ts = now();
  const serverSeconds = Math.min(MAX_SESSION_SEC, Math.round((ts - row.started_at) / 1000));
  const reported = Number.isFinite(playedSeconds) ? Math.max(row.reported_seconds, Math.floor(playedSeconds)) : row.reported_seconds;
  db.prepare('UPDATE sessions SET last_beat_at = ?, server_seconds = ?, reported_seconds = ? WHERE id = ?').run(
    ts,
    serverSeconds,
    Math.min(reported, serverSeconds + 5),
    sessionId,
  );

  const w = getWallet(userId);
  const left = trialSecondsLeft(w);
  const member = isMember(getUser(userId));
  const estimateFen = Math.max(0, Math.round(Math.max(0, serverSeconds - left) * fenPerSecond));
  // 体验额度按秒消耗，心跳到点必须让客户端停下，否则非会员可以一直“挂着听”
  const quotaLeft = Math.max(0, left - serverSeconds);
  const shouldStop = member ? estimateFen >= w.cash_fen : quotaLeft <= 0;
  return {
    status: 'active',
    serverSeconds,
    trialSecondsLeft: quotaLeft,
    estimateCostFen: member ? estimateFen : 0,
    cashFen: w.cash_fen,
    lowBalance: shouldStop,
    shouldStop,
    stopReason: shouldStop ? (member ? 'LOW_BALANCE' : 'NEED_MEMBERSHIP') : null,
  };
}

/**
 * 累计消费达标后才计入推荐序号：
 * 未达标前推荐人一分钱拿不到，达标那一刻起按「第几个达标的直推」计提。
 * 这样"注册小号占第 3 个位置"就没有意义了——占位必须先真金白银消费满门槛。
 */
function qualifyIfNeeded(txDb, userId, at) {
  const u = txDb.prepare('SELECT id, referrer_id, qualified_at FROM users WHERE id = ?').get(userId);
  if (!u || !u.referrer_id || u.qualified_at) return;
  const spent = txDb.prepare('SELECT total_spent_fen FROM wallets WHERE user_id = ?').get(userId)?.total_spent_fen || 0;
  const threshold = config.referral.qualifyFen;
  if (threshold > 0 && spent < threshold) return;
  const ordinal =
    txDb.prepare('SELECT COUNT(*) AS c FROM users WHERE referrer_id = ? AND qualified_at IS NOT NULL').get(u.referrer_id).c + 1;
  txDb.prepare('UPDATE users SET qualified_at = ?, qualify_ordinal = ? WHERE id = ?').run(at, ordinal, userId);
}

function settleSession(row, { userId, playedSeconds, endedAt }) {
  const db = getDb();
  const serverSeconds = Math.max(0, Math.min(MAX_SESSION_SEC, Math.round((endedAt - row.started_at) / 1000)));
  const reported = Number.isFinite(playedSeconds)
    ? Math.max(0, Math.floor(playedSeconds))
    : row.reported_seconds || serverSeconds;
  const billable = Math.max(0, Math.min(reported, serverSeconds + 15, MAX_SESSION_SEC));

  const user = getUser(userId);
  const w = getWallet(userId);
  const trialLeft = trialSecondsLeft(w);
  const trialPart = Math.min(billable, trialLeft);
  const wantPaid = Math.max(0, billable - trialPart);

  const member = isMember(user);
  const maxAffordableSec = Math.floor(w.cash_fen / fenPerSecond);
  const paidSeconds = member ? Math.min(wantPaid, maxAffordableSec) : 0;
  let costFen = Math.min(w.cash_fen, Math.round(paidSeconds * fenPerSecond));
  if (paidSeconds > 0 && costFen === 0) costFen = 1;

  const shortfall = wantPaid - paidSeconds;
  const status = shortfall > 0 ? 'insufficient' : 'closed';

  const result = tx((txDb) => {
    ensureWalletWith(txDb, userId);
    const cur = txDb.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
    const newTrialUsed = cur.trial_seconds_used + trialPart;
    const newCash = cur.cash_fen - costFen;

    txDb
      .prepare(
        `UPDATE wallets SET trial_seconds_used = ?, cash_fen = ?, total_spent_fen = total_spent_fen + ?, updated_at = ? WHERE user_id = ?`,
      )
      .run(newTrialUsed, newCash, costFen, endedAt, userId);

    if (trialPart > 0) {
      addLedger(txDb, {
        userId,
        kind: 'trial',
        balanceKind: 'trial',
        amountFen: 0,
        balanceAfterFen: Math.max(0, config.trialSeconds - newTrialUsed),
        refType: 'session',
        refId: row.id,
        memo: `体验课 ${trialPart} 秒（剩余 ${Math.max(0, config.trialSeconds - newTrialUsed)} 秒）`,
      });
    }
    if (costFen > 0) {
      addLedger(txDb, {
        userId,
        kind: 'consume',
        balanceKind: 'cash',
        amountFen: -costFen,
        balanceAfterFen: newCash,
        refType: 'session',
        refId: row.id,
        memo: `会员听课 ${paidSeconds} 秒 × ${(config.priceFenPerMinute / 100).toFixed(2)} 元/分钟`,
      });
    }

    txDb
      .prepare(
        `UPDATE sessions SET ended_at = ?, last_beat_at = ?, server_seconds = ?, reported_seconds = ?, billed_seconds = ?,
                trial_seconds = ?, paid_seconds = ?, cost_fen = ?, status = ? WHERE id = ?`,
      )
      .run(endedAt, endedAt, serverSeconds, reported, trialPart + paidSeconds, trialPart, paidSeconds, costFen, status, row.id);

    // 只有真金白银的消费才产生推荐佣金，体验课不产生
    if (costFen > 0) qualifyIfNeeded(txDb, userId, endedAt);
    const commission =
      costFen > 0
        ? payCommissions({ payerId: userId, sessionId: row.id, baseFen: costFen })
        : { items: [], totalFen: 0, capped: false };

    return { commission };
  });

  return {
    sessionId: row.id,
    billableSeconds: trialPart + paidSeconds,
    trialSeconds: trialPart,
    paidSeconds,
    costFen,
    shortfallSeconds: shortfall,
    status,
    funding: trialPart > 0 && paidSeconds > 0 ? 'mixed' : paidSeconds > 0 ? 'wallet' : 'trial',
    commission: { count: result.commission.items.length, totalFen: result.commission.totalFen, capped: result.commission.capped },
    wallet: walletView(userId),
  };
}

export function endSession(sessionId, userId, playedSeconds = null) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!row) throw fail(404, 'SESSION_NOT_FOUND', '听课会话不存在');
  if (row.status !== 'active') {
    return {
      sessionId: row.id,
      billableSeconds: row.billed_seconds,
      trialSeconds: row.trial_seconds,
      paidSeconds: row.paid_seconds,
      costFen: row.cost_fen,
      status: row.status,
      alreadyClosed: true,
      wallet: walletView(userId),
    };
  }
  return settleSession(row, { userId, playedSeconds, endedAt: now() });
}

/** 心跳超时的会话按最后一次心跳结算，避免用户杀进程后一直占用计时 */
export function closeStaleSessions(userId = null, idleMs = 10 * 60 * 1000) {
  const db = getDb();
  const cutoff = now() - idleMs;
  const rows = userId
    ? db.prepare(`SELECT * FROM sessions WHERE status = 'active' AND user_id = ? AND last_beat_at < ?`).all(userId, cutoff)
    : db.prepare(`SELECT * FROM sessions WHERE status = 'active' AND last_beat_at < ?`).all(cutoff);
  const out = [];
  for (const row of rows) {
    try {
      out.push(settleSession(row, { userId: row.user_id, playedSeconds: row.reported_seconds, endedAt: row.last_beat_at }));
    } catch (err) {
      console.warn(`[billing] 关闭会话 ${row.id} 失败：${err.message}`);
    }
  }
  return out;
}

export function listLedger(userId, limit = 50) {
  return getDb()
    .prepare('SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      balanceKind: r.balance_kind,
      amountFen: r.amount_fen,
      balanceAfterFen: r.balance_after_fen,
      memo: r.memo,
      createdAt: r.created_at,
    }));
}

export function listSessions(userId, limit = 30) {
  return getDb()
    .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(userId, limit)
    .map((r) => ({
      id: r.id,
      lessonId: r.lesson_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      billedSeconds: r.billed_seconds,
      trialSeconds: r.trial_seconds,
      paidSeconds: r.paid_seconds,
      costFen: r.cost_fen,
      status: r.status,
    }));
}

/** 充值（演示走 mock 渠道；生产接微信支付后由回调调用 creditTopup） */
export function topup(userId, { amountFen, channel = 'mock' } = {}) {
  const amount = Math.floor(Number(amountFen));
  if (!Number.isFinite(amount) || amount <= 0) throw fail(400, 'BAD_AMOUNT', '充值金额不合法');
  if (amount < config.minTopupFen) throw fail(400, 'AMOUNT_TOO_SMALL', `最低充值 ${config.minTopupFen / 100} 元`);
  if (amount > 100000) throw fail(400, 'AMOUNT_TOO_LARGE', '单笔充值不能超过 1000 元');

  const db = getDb();
  const orderId = id('ord');
  const ts = now();
  const tradeNo = outTradeNo('TP');
  db.prepare(
    `INSERT INTO orders (id, user_id, kind, amount_fen, status, channel, out_trade_no, created_at, paid_at)
     VALUES (?, ?, 'topup', ?, 'pending', ?, ?, ?, NULL)`,
  ).run(orderId, userId, amount, channel, tradeNo, ts);

  creditTopup({ userId, orderId, amountFen: amount });
  return { orderId, outTradeNo: tradeNo, amountFen: amount, wallet: walletView(userId) };
}

/**
 * 支付成功后的入账（必须在调用方的事务里执行，保证"订单状态 + 钱包 + 流水"原子）。
 * 幂等：订单已支付则直接返回，不会重复加钱。
 */
export function creditTopupIn(txDb, { userId, orderId, amountFen }) {
  const order = txDb.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw fail(404, 'ORDER_NOT_FOUND', '订单不存在');
  if (order.status === 'paid' || order.status === 'partial_refunded' || order.status === 'refunded') {
    return { alreadyPaid: true };
  }
  if (Number(order.amount_fen) !== Number(amountFen)) {
    throw fail(400, 'AMOUNT_MISMATCH', '入账金额与订单金额不一致');
  }
  if (order.user_id !== userId) throw fail(400, 'ORDER_USER_MISMATCH', '订单与用户不匹配');

  ensureWalletWith(txDb, userId);
  const cur = txDb.prepare('SELECT cash_fen FROM wallets WHERE user_id = ?').get(userId);
  const after = cur.cash_fen + amountFen;
  const ts = now();
  txDb.prepare('UPDATE wallets SET cash_fen = ?, updated_at = ? WHERE user_id = ?').run(after, ts, userId);
  txDb.prepare(`UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, ?) WHERE id = ?`).run(ts, orderId);
  addLedger(txDb, {
    userId,
    kind: 'topup',
    balanceKind: 'cash',
    amountFen,
    balanceAfterFen: after,
    refType: 'order',
    refId: orderId,
    memo: `充值 ${(amountFen / 100).toFixed(2)} 元`,
  });
  return { alreadyPaid: false };
}

/** 独立事务版本（演示/测试直接调用） */
export function creditTopup(args) {
  return tx((txDb) => creditTopupIn(txDb, args));
}

/** 佣金提现：从可提现余额转入冻结，等待运营打款 */
export function withdraw(userId, amountFen, channel = 'wechat') {
  const amount = Math.floor(Number(amountFen));
  if (!Number.isFinite(amount) || amount <= 0) throw fail(400, 'BAD_AMOUNT', '提现金额不合法');
  if (amount < config.minWithdrawFen) throw fail(400, 'AMOUNT_TOO_SMALL', `最低提现 ${config.minWithdrawFen / 100} 元`);

  const db = getDb();
  return tx((txDb) => {
    ensureWalletWith(txDb, userId);
    const cur = txDb.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
    if (cur.commission_fen < amount) {
      throw fail(400, 'INSUFFICIENT_COMMISSION', '可提现佣金不足（佣金需 T+N 结算后才可提现）');
    }
    const ts = now();
    txDb
      .prepare('UPDATE wallets SET commission_fen = ?, frozen_fen = frozen_fen + ?, updated_at = ? WHERE user_id = ?')
      .run(cur.commission_fen - amount, amount, ts, userId);
    const wid = id('wd');
    txDb
      .prepare(`INSERT INTO withdrawals (id, user_id, amount_fen, status, channel, created_at) VALUES (?, ?, ?, 'pending', ?, ?)`)
      .run(wid, userId, amount, channel, ts);
    addLedger(txDb, {
      userId,
      kind: 'withdraw',
      balanceKind: 'commission',
      amountFen: -amount,
      balanceAfterFen: cur.commission_fen - amount,
      refType: 'withdrawal',
      refId: wid,
      memo: '佣金提现申请',
    });
    return { withdrawalId: wid, amountFen: amount, wallet: walletView(userId) };
  });
}

export function meOverview(userId) {
  const user = getUser(userId);
  return {
    user: publicUser(user),
    wallet: walletView(userId),
    quote: billingQuote(userId),
  };
}
