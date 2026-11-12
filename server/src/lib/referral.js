import { getDb, tx, now } from '../db.js';
import { config } from '../config.js';
import { fail } from './http.js';
import { id } from './ids.js';
import { getUser, getUserByInviteCode, publicUser } from './users.js';

const MAX_DEPTH = 50;

/* ------------------------------------------------------------ 比例规则 */

/** depth 模式：按层级取比例（直推 20%、二级 50%、三级及以后 100%） */
export function rateForDepth(depth) {
  const ladder = config.referral.ladderBp;
  if (depth <= ladder.length) return ladder[depth - 1];
  return config.referral.infiniteBp;
}

/**
 * cycle 模式（默认）：按「我是他的第几个直推会员」取比例，每 3 个一轮循环。
 * 第 1 个 → 20%，第 2 个 → 50%，第 3 个 → 100%，
 * 第 4 个 → 20%，第 5 个 → 50%，第 6 个 → 100% ……
 */
export function rateForOrdinal(ordinal) {
  const ladder = config.referral.ladderBp;
  if (!ladder.length || ordinal <= 0) return 0;
  return ladder[(ordinal - 1) % ladder.length];
}

/** sequence 模式（旧口径）：递增到最高档后不再回落 */
export function rateForSequence(ordinal) {
  const ladder = config.referral.ladderBp;
  if (!ladder.length || ordinal <= 0) return 0;
  if (ordinal <= ladder.length) return ladder[ordinal - 1];
  return config.referral.infiniteBp;
}

export const rateLabel = (rateBp) => `${rateBp / 100}%`;

/* ------------------------------------------------------------ 推荐关系 */

/** 我在推荐关系树上的所有上级：[{id, depth}]，depth=1 为直接推荐人 */
export function uplineChain(userId) {
  const db = getDb();
  const chain = [];
  const seen = new Set([userId]);
  let cursor = db.prepare('SELECT referrer_id FROM users WHERE id = ?').get(userId)?.referrer_id;
  let depth = 1;
  while (cursor && depth <= MAX_DEPTH && !seen.has(cursor)) {
    chain.push({ id: cursor, depth });
    seen.add(cursor);
    cursor = db.prepare('SELECT referrer_id FROM users WHERE id = ?').get(cursor)?.referrer_id;
    depth += 1;
  }
  return chain;
}

/** 直接推荐人 id */
export function directReferrerId(userId) {
  return getDb().prepare('SELECT referrer_id FROM users WHERE id = ?').get(userId)?.referrer_id || null;
}

/**
 * payer 是 earner 的第几个「已达标」直推会员。
 * 序号在「累计消费满 REFERRAL_QUALIFY_FEN」那一刻分配（见 billing.qualifyIfNeeded），
 * 未达标返回 0，表示还不参与分佣。
 */
export function referralOrdinal(earnerId, payerId) {
  const row = getDb()
    .prepare('SELECT referrer_id, qualified_at, qualify_ordinal FROM users WHERE id = ?')
    .get(payerId);
  if (!row || row.referrer_id !== earnerId || !row.qualified_at) return 0;
  return row.qualify_ordinal || 0;
}

/** 某会员已直接推荐的会员数 */
export function referralCount(userId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE referrer_id = ?').get(userId).c;
}

/** 某个付费者会让谁、按什么比例拿钱（不落库，便于预览与测试） */
export function commissionPreview(payerId, baseFen = 10000) {
  return candidatesFor(payerId).map((c) => ({
    earnerId: c.earnerId,
    depth: c.depth,
    ordinal: c.ordinal,
    rateBp: c.rateBp,
    rateLabel: rateLabel(c.rateBp),
    amountFen: Math.floor((baseFen * c.rateBp) / 10000),
  }));
}

function candidatesFor(payerId) {
  const cfg = config.referral;
  const db = getDb();
  const payer = db
    .prepare('SELECT id, referrer_id, qualified_at, qualify_ordinal FROM users WHERE id = ?')
    .get(payerId);
  if (!payer || !payer.referrer_id) return [];
  // 累计消费没到门槛：推荐人暂时拿不到佣金
  if (!payer.qualified_at) return [];

  if (cfg.mode === 'depth') {
    return uplineChain(payerId).map((n) => ({
      earnerId: n.id,
      depth: n.depth,
      ordinal: 0,
      rateBp: rateForDepth(n.depth),
    }));
  }

  const ordinal = payer.qualify_ordinal || 0;
  const rateBp = cfg.mode === 'sequence' ? rateForSequence(ordinal) : rateForOrdinal(ordinal);
  return [{ earnerId: payer.referrer_id, depth: 1, ordinal, rateBp }];
}

/** 绑定推荐人（注册时一次性，绑定后不可改） */
export function bindReferrer(userId, code) {
  if (!code) return null;
  const db = getDb();
  const user = getUser(userId);
  if (!user) throw fail(404, 'USER_NOT_FOUND', '用户不存在');
  if (user.referrer_id) throw fail(409, 'ALREADY_BOUND', '已经绑定过推荐人，不能修改');
  const referrer = getUserByInviteCode(code.trim());
  if (!referrer) throw fail(404, 'INVITE_CODE_NOT_FOUND', '邀请码不存在');
  if (referrer.id === userId) throw fail(400, 'SELF_REFERRAL', '不能填写自己的邀请码');
  if (uplineChain(referrer.id).some((n) => n.id === userId)) {
    throw fail(400, 'REFERRAL_CYCLE', '推荐关系成环，已拒绝');
  }
  db.prepare('UPDATE users SET referrer_id = ? WHERE id = ?').run(referrer.id, userId);
  return publicUser(referrer);
}

/* ------------------------------------------------------------ 佣金结算 */

/**
 * 按一笔真实消费（会员扣课时费）结算推荐佣金。
 * depth 模式可能有多层，逐层分配并受 capTotalBp 限制；
 * cycle / sequence 模式只有直接推荐人拿钱，比例由「第几个直推会员」决定。
 * @returns {{items: Array, totalFen: number, capped: boolean}}
 */
export function payCommissions({ payerId, sessionId, baseFen }) {
  const cfg = config.referral;
  if (!Number.isFinite(baseFen) || baseFen <= 0) return { items: [], totalFen: 0, capped: false };

  const candidates = candidatesFor(payerId);
  if (!candidates.length) return { items: [], totalFen: 0, capped: false };

  const db = getDb();
  const totalCap = Math.floor((baseFen * cfg.capTotalBp) / 10000);
  let paid = 0;
  let capped = false;
  const items = [];
  const ts = now();

  for (const node of candidates) {
    if (node.rateBp <= 0) continue;
    const desired = Math.floor((baseFen * node.rateBp) / 10000);
    if (desired <= 0) continue;
    const remaining = totalCap - paid;
    if (remaining <= 0) {
      capped = true;
      break;
    }
    const amount = Math.min(desired, remaining);
    if (amount < desired) capped = true;

    db.prepare(
      `INSERT INTO commissions (id, earner_id, payer_id, session_id, depth, ordinal, rate_bp, base_fen, amount_fen, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id('cm'), node.earnerId, payerId, sessionId || null, node.depth, node.ordinal || 0, node.rateBp, baseFen, amount, ts);

    items.push({
      earnerId: node.earnerId,
      depth: node.depth,
      ordinal: node.ordinal || 0,
      rateBp: node.rateBp,
      amountFen: amount,
      capped: amount < desired,
    });
    paid += amount;
    if (paid >= totalCap) break;
  }

  return { items, totalFen: paid, capped };
}

/** T+N 后把 pending 佣金转入可提现余额 */
export function settlePending({ all = false } = {}) {
  const db = getDb();
  const cutoff = all ? Number.MAX_SAFE_INTEGER : now() - config.referral.settleDays * 86400_000;
  const rows = db
    .prepare(`SELECT * FROM commissions WHERE status = 'pending' AND created_at <= ? ORDER BY earner_id`)
    .all(cutoff);
  if (!rows.length) return { settled: 0, amountFen: 0 };

  return tx((txDb) => {
    let amountFen = 0;
    const ts = now();
    for (const row of rows) {
      const wallet = txDb.prepare('SELECT commission_fen FROM wallets WHERE user_id = ?').get(row.earner_id);
      const before = wallet?.commission_fen || 0;
      const after = before + row.amount_fen;
      txDb
        .prepare(
          `INSERT INTO wallets (user_id, cash_fen, commission_fen, frozen_fen, trial_seconds_used, total_spent_fen, total_earned_fen, updated_at)
           VALUES (?, 0, ?, 0, 0, 0, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET commission_fen = ?, total_earned_fen = total_earned_fen + ?, updated_at = ?`,
        )
        .run(row.earner_id, after, row.amount_fen, ts, after, row.amount_fen, ts);
      txDb
        .prepare(
          `INSERT INTO ledger (id, user_id, kind, balance_kind, amount_fen, balance_after_fen, ref_type, ref_id, memo, created_at)
           VALUES (?, ?, 'commission', 'commission', ?, ?, 'commission', ?, ?, ?)`,
        )
        .run(id('lg'), row.earner_id, row.amount_fen, after, row.id, `推荐佣金结算（${rateLabel(row.rate_bp)}）`, ts);
      txDb.prepare(`UPDATE commissions SET status = 'settled', settled_at = ? WHERE id = ?`).run(ts, row.id);
      amountFen += row.amount_fen;
    }
    return { settled: rows.length, amountFen };
  });
}

/* ------------------------------------------------------------ 推荐中心 */

function memberRateByMode(ordinal) {
  if (config.referral.mode === 'depth') return rateForDepth(1);
  if (config.referral.mode === 'sequence') return rateForSequence(ordinal);
  return rateForOrdinal(ordinal);
}

/**
 * 推荐中心数据：我的直推名单（按序号带比例）、团队规模、各档收入、最近佣金。
 */
export function referralSummary(userId) {
  const db = getDb();
  const user = getUser(userId);
  if (!user) throw fail(404, 'USER_NOT_FOUND', '用户不存在');

  const qualifyFen = config.referral.qualifyFen;
  const directRows = db
    .prepare(
      `SELECT u.id, u.nickname, u.avatar, u.created_at, u.qualified_at, u.qualify_ordinal,
              COALESCE(w.total_spent_fen, 0) AS spent_fen
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
        WHERE u.referrer_id = ?
        ORDER BY (u.qualified_at IS NULL), u.qualify_ordinal ASC, u.rowid ASC`,
    )
    .all(userId);

  const earnings = db
    .prepare(
      `SELECT payer_id, status, rate_bp, SUM(amount_fen) AS fen, COUNT(*) AS cnt
         FROM commissions WHERE earner_id = ? GROUP BY payer_id, status, rate_bp`,
    )
    .all(userId);

  const members = directRows.map((m) => {
    const rows = earnings.filter((e) => e.payer_id === m.id);
    const sum = (status) => rows.filter((r) => r.status === status).reduce((a, r) => a + r.fen, 0);
    const qualified = Boolean(m.qualified_at);
    const ordinal = qualified ? m.qualify_ordinal || 0 : 0;
    const rateBp = qualified ? memberRateByMode(ordinal) : 0;
    return {
      id: m.id,
      nickname: m.nickname,
      avatar: m.avatar,
      createdAt: m.created_at,
      qualified,
      qualifiedAt: m.qualified_at || null,
      qualifyFen,
      cumulativeFen: m.spent_fen,
      progressPct: qualifyFen > 0 ? Math.min(100, Math.round((m.spent_fen / qualifyFen) * 100)) : 100,
      ordinal,
      rateBp,
      rateLabel: qualified ? rateLabel(rateBp) : '未达标',
      paidFen: m.spent_fen,
      pendingFen: sum('pending'),
      settledFen: sum('settled'),
    };
  });

  // 团队规模仍然按层级 BFS，只用于展示“团队共多少人”
  const levels = [];
  let frontier = [userId];
  const seen = new Set([userId]);
  for (let depth = 1; depth <= 3; depth += 1) {
    const found = [];
    for (const parent of frontier) {
      found.push(...db.prepare('SELECT id, nickname, avatar, created_at FROM users WHERE referrer_id = ?').all(parent));
    }
    const fresh = found.filter((m) => !seen.has(m.id));
    fresh.forEach((m) => seen.add(m.id));
    levels.push({ depth, count: fresh.length });
    frontier = fresh.map((m) => m.id);
    if (!frontier.length) break;
  }

  const rateSet = [...new Set(config.referral.ladderBp)].sort((a, b) => a - b);
  const byRate = rateSet.map((r) => {
    const group = members.filter((m) => m.qualified && m.rateBp === r);
    return {
      rateBp: r,
      label: rateLabel(r),
      memberCount: group.length,
      pendingFen: group.reduce((s, m) => s + m.pendingFen, 0),
      settledFen: group.reduce((s, m) => s + m.settledFen, 0),
    };
  });

  const recent = db
    .prepare(
      `SELECT c.*, u.nickname AS payer_name FROM commissions c
         JOIN users u ON u.id = c.payer_id
        WHERE c.earner_id = ? ORDER BY c.created_at DESC, c.rowid DESC LIMIT 20`,
    )
    .all(userId)
    .map((r) => ({
      id: r.id,
      depth: r.depth,
      ordinal: r.ordinal,
      rateBp: r.rate_bp,
      rateLabel: rateLabel(r.rate_bp),
      baseFen: r.base_fen,
      amountFen: r.amount_fen,
      status: r.status,
      payerName: r.payer_name,
      createdAt: r.created_at,
    }));

  return {
    inviteCode: user.invite_code,
    sharePath: `/pages/index/index?inviteCode=${user.invite_code}`,
    mode: config.referral.mode,
    ladder: config.referral.ladderBp,
    ladderLabel: config.referral.ladderBp.map((b, i) => `第 ${i + 1} 个 ${b / 100}%`),
    capTotalBp: config.referral.capTotalBp,
    qualifyFen,
    directCount: members.length,
    qualifiedCount: members.filter((m) => m.qualified).length,
    members,
    totalTeam: levels.reduce((s, l) => s + l.count, 0),
    levels,
    byRate,
    pendingFen: members.reduce((s, m) => s + m.pendingFen, 0),
    settledFen: members.reduce((s, m) => s + m.settledFen, 0),
    recent,
  };
}

/** 运营侧：一条推荐链的明细（用于排查/对账） */
export function referralChainOf(userId) {
  return uplineChain(userId).map((n) => ({ ...n, user: publicUser(getUser(n.id)), rateBp: rateForDepth(n.depth) }));
}
