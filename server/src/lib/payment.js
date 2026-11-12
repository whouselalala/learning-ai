import { getDb, tx, now } from '../db.js';
import { config, payProvider } from '../config.js';
import { fail } from './http.js';
import { id, outTradeNo } from './ids.js';
import { getUser } from './users.js';
import { creditTopupIn, walletView } from './billing.js';
import { getWechatPay, payConfigProblem } from './wechatpay.js';

/**
 * 订单与支付。
 *
 * 资金路径（微信支付）：
 *   小程序 wx.requestPayment → 微信支付 → 商户号绑定的【公司对公账户】T+1 结算。
 *   平台只做下单、验签、记账；不代收、不沉淀资金（避免"二清"）。
 *
 * 订单状态：
 *   pending → paid → partial_refunded / refunded
 *   pending → closed（超时关闭）
 *   paid    → exception（回调金额不匹配，人工处理）
 */

const ORDER_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  CLOSED: 'closed',
  PARTIAL_REFUNDED: 'partial_refunded',
  REFUNDED: 'refunded',
  EXCEPTION: 'exception',
};

export function orderView(row) {
  if (!row) return null;
  return {
    id: row.id,
    outTradeNo: row.out_trade_no,
    status: row.status,
    kind: row.kind,
    subject: row.subject,
    amountFen: row.amount_fen,
    paidAmountFen: row.paid_amount_fen,
    refundedFen: row.refunded_fen || 0,
    channel: row.channel,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    expireAt: row.expire_at,
  };
}

function validateAmount(amountFen) {
  const amount = Math.floor(Number(amountFen));
  if (!Number.isFinite(amount) || amount <= 0) throw fail(400, 'BAD_AMOUNT', '充值金额不合法');
  if (amount < config.minTopupFen) throw fail(400, 'AMOUNT_TOO_SMALL', `最低充值 ${config.minTopupFen / 100} 元`);
  if (amount > 100000) throw fail(400, 'AMOUNT_TOO_LARGE', '单笔充值不能超过 1000 元');
  return amount;
}

/** 当日已支付金额，防止刷单/洗钱式充值 */
function todayPaidFen(userId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return getDb()
    .prepare(`SELECT COALESCE(SUM(amount_fen), 0) AS fen FROM orders WHERE user_id = ? AND status IN ('paid','partial_refunded','refunded') AND paid_at >= ?`)
    .get(userId, start.getTime()).fen;
}

/**
 * 创建充值订单并拉起支付。
 * @returns {{order, payParams: {provider:'mock'|'wechat', timeStamp?, nonceStr?, package?, signType?, paySign?}}}
 */
export async function createTopupOrder(userId, { amountFen, clientIp } = {}) {
  const amount = validateAmount(amountFen);
  const user = getUser(userId);
  if (!user) throw fail(404, 'USER_NOT_FOUND', '用户不存在');

  const dailyLimit = 200000; // 2000 元/日
  if (todayPaidFen(userId) + amount > dailyLimit) {
    throw fail(400, 'DAILY_LIMIT', `单日充值上限 ${dailyLimit / 100} 元，请明天再试`);
  }

  const db = getDb();
  const orderId = id('ord');
  const tradeNo = outTradeNo('TP');
  const ts = now();
  const expireAt = ts + config.pay.orderTtlSec * 1000;
  const subject = `习声AI 学习时长充值 ${(amount / 100).toFixed(2)} 元`;

  db.prepare(
    `INSERT INTO orders (id, user_id, kind, subject, amount_fen, status, channel, out_trade_no, expire_at, created_at)
     VALUES (?, ?, 'topup', ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(orderId, userId, subject, amount, payProvider, tradeNo, expireAt, ts);

  if (payProvider !== 'wechat') {
    return {
      order: orderView(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)),
      payParams: { provider: 'mock' },
    };
  }

  const missing = payConfigProblem();
  if (missing.length) throw fail(500, 'PAY_NOT_CONFIGURED', `支付参数缺失：${missing.join('、')}`);
  if (!user.openid || String(user.openid).startsWith('mock_')) {
    throw fail(400, 'NO_WX_OPENID', '缺少微信 openid，请在小程序内发起支付');
  }

  const wx = getWechatPay();
  let data;
  try {
    data = await wx.createJsapiOrder({
      outTradeNo: tradeNo,
      description: subject,
      amountFen: amount,
      openid: user.openid,
      notifyUrl: config.pay.notifyUrl,
      expireAt,
    });
  } catch (err) {
    db.prepare(`UPDATE orders SET status = 'closed' WHERE id = ?`).run(orderId);
    throw fail(502, 'PAY_CREATE_FAILED', `微信下单失败：${err.message}`);
  }

  db.prepare('UPDATE orders SET prepay_id = ? WHERE id = ?').run(data.prepay_id || null, orderId);
  return {
    order: orderView(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)),
    payParams: { provider: 'wechat', appId: config.wechat.appId, ...wx.jsapiPayParams(data.prepay_id) },
  };
}

/** 标记已支付并给钱包入账（幂等） */
export function markOrderPaid(orderId, { transactionId = null, paidFen = null, notifyAt = null } = {}) {
  const db = getDb();
  const pre = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!pre) throw fail(404, 'ORDER_NOT_FOUND', '订单不存在');
  if ([ORDER_STATUS.PAID, ORDER_STATUS.PARTIAL_REFUNDED, ORDER_STATUS.REFUNDED].includes(pre.status)) {
    return { alreadyPaid: true, order: orderView(pre) };
  }
  if (pre.status !== ORDER_STATUS.PENDING) {
    throw fail(409, 'ORDER_NOT_PENDING', `订单状态为 ${pre.status}，不能支付`);
  }
  // 金额不一致：先落异常状态（事务里抛出会被回滚，所以放在事务外），转人工
  if (paidFen != null && Number(paidFen) !== Number(pre.amount_fen)) {
    db.prepare(
      `UPDATE orders SET status = 'exception', transaction_id = ?, paid_amount_fen = ?, notify_at = ? WHERE id = ?`,
    ).run(transactionId, paidFen, notifyAt || now(), orderId);
    throw fail(409, 'AMOUNT_MISMATCH', '回调金额与订单金额不一致，已转人工处理');
  }

  return tx((txDb) => {
    const order = txDb.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if ([ORDER_STATUS.PAID, ORDER_STATUS.PARTIAL_REFUNDED, ORDER_STATUS.REFUNDED].includes(order.status)) {
      return { alreadyPaid: true, order: orderView(order) };
    }
    if (order.status !== ORDER_STATUS.PENDING) {
      throw fail(409, 'ORDER_NOT_PENDING', `订单状态为 ${order.status}，不能支付`);
    }
    txDb.prepare('UPDATE orders SET transaction_id = ?, paid_amount_fen = ?, notify_at = ? WHERE id = ?').run(
      transactionId,
      paidFen ?? order.amount_fen,
      notifyAt || now(),
      orderId,
    );
    creditTopupIn(txDb, { userId: order.user_id, orderId: order.id, amountFen: order.amount_fen });
    return { alreadyPaid: false, order: orderView(txDb.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)) };
  });
}

/** 演示环境：直接把订单标记为已支付（生产禁用） */
export function mockPay(userId, orderId) {
  if (payProvider === 'wechat') throw fail(403, 'MOCK_DISABLED', '当前使用真实微信支付，禁止模拟支付');
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
  if (!order) throw fail(404, 'ORDER_NOT_FOUND', '订单不存在');
  const out = markOrderPaid(order.id, { transactionId: `MOCK${Date.now()}`, paidFen: order.amount_fen });
  return { paid: true, alreadyPaid: out.alreadyPaid, order: out.order, wallet: walletView(userId) };
}

/* -------------------------------------------------------------- 回调 */

/**
 * 微信支付结果通知。
 * 必须：验签 → 解密 → 校验 mchid/appid → 幂等入账 → 返回 200。
 */
export function handlePayNotify({ headers, rawBody }) {
  const wx = getWechatPay();
  wx.verifyNotify(headers, rawBody);

  const event = JSON.parse(rawBody);
  if (event.event_type !== 'TRANSACTION.SUCCESS') return { ok: true, ignored: event.event_type };

  const data = wx.decryptResource(event.resource);
  if (data.trade_state !== 'SUCCESS') return { ok: true, ignored: data.trade_state };
  if (data.mchid !== config.pay.wxpay.mchId) throw fail(400, 'MCHID_MISMATCH', '商户号不匹配');
  if (data.appid !== config.wechat.appId) throw fail(400, 'APPID_MISMATCH', 'appid 不匹配');

  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE out_trade_no = ?').get(data.out_trade_no);
  if (!order) {
    // 本地没有这笔订单：不返回成功，让微信重试，同时留给人工核对
    throw fail(404, 'ORDER_NOT_FOUND', `未找到订单 ${data.out_trade_no}`);
  }

  const out = markOrderPaid(order.id, {
    transactionId: data.transaction_id,
    paidFen: data.amount?.total,
    notifyAt: now(),
  });
  return { ok: true, alreadyPaid: out.alreadyPaid, orderId: order.id };
}

/* -------------------------------------------------------------- 退款 */

/**
 * 退款：只退「尚未消费的余额」，原路退回对公账户再回到用户支付渠道。
 * 已消费的课时费退款需要单独的"课时退款"流程（未实现，见文档）。
 */
export async function refundOrder({ orderId, amountFen, reason = '', operator = 'admin' }) {
  const amount = Math.floor(Number(amountFen));
  if (!Number.isFinite(amount) || amount <= 0) throw fail(400, 'BAD_AMOUNT', '退款金额不合法');

  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw fail(404, 'ORDER_NOT_FOUND', '订单不存在');
  if (![ORDER_STATUS.PAID, ORDER_STATUS.PARTIAL_REFUNDED].includes(order.status)) {
    throw fail(409, 'ORDER_NOT_REFUNDABLE', `订单状态为 ${order.status}，不能退款`);
  }

  const remaining = order.amount_fen - (order.refunded_fen || 0);
  if (amount > remaining) throw fail(400, 'REFUND_TOO_LARGE', `最多可退 ${(remaining / 100).toFixed(2)} 元`);

  const wallet = walletView(order.user_id);
  if (amount > wallet.cashFen) {
    throw fail(400, 'INSUFFICIENT_BALANCE', `用户未消费余额只有 ${(wallet.cashFen / 100).toFixed(2)} 元，已消耗部分需走课时退款流程`);
  }

  const refundId = id('rf');
  const outRefundNo = outTradeNo('RF');
  const ts = now();
  db.prepare(
    `INSERT INTO refunds (id, order_id, user_id, amount_fen, reason, status, out_refund_no, operator, created_at)
     VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?)`,
  ).run(refundId, order.id, order.user_id, amount, reason, outRefundNo, operator, ts);

  if (payProvider !== 'wechat') {
    finalizeRefund(refundId, { refundId: `MOCK${Date.now()}` });
    return { refund: refundView(getDb().prepare('SELECT * FROM refunds WHERE id = ?').get(refundId)) };
  }

  try {
    const data = await getWechatPay().refund({
      outTradeNo: order.out_trade_no,
      outRefundNo,
      refundFen: amount,
      totalFen: order.amount_fen,
      reason,
    });
    db.prepare('UPDATE refunds SET refund_id = ? WHERE id = ?').run(data.refund_id || null, refundId);
    if (data.status === 'SUCCESS') finalizeRefund(refundId, { refundId: data.refund_id });
    return { refund: refundView(getDb().prepare('SELECT * FROM refunds WHERE id = ?').get(refundId)) };
  } catch (err) {
    db.prepare(`UPDATE refunds SET status = 'failed', finished_at = ? WHERE id = ?`).run(now(), refundId);
    throw fail(502, 'REFUND_FAILED', `微信退款失败：${err.message}`);
  }
}

function refundView(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    amountFen: row.amount_fen,
    status: row.status,
    reason: row.reason,
    outRefundNo: row.out_refund_no,
    refundId: row.refund_id,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** 退款成功：扣回余额、写流水、更新订单（幂等） */
export function finalizeRefund(refundId, { refundId: wxRefundId = null } = {}) {
  return tx((db) => {
    const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
    if (!refund) throw fail(404, 'REFUND_NOT_FOUND', '退款单不存在');
    if (refund.status === 'success') return { alreadyDone: true };

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(refund.order_id);
    const wallet = db.prepare('SELECT cash_fen FROM wallets WHERE user_id = ?').get(refund.user_id);
    if (!wallet || wallet.cash_fen < refund.amount_fen) {
      db.prepare(`UPDATE refunds SET status = 'failed', finished_at = ? WHERE id = ?`).run(now(), refundId);
      throw fail(409, 'INSUFFICIENT_BALANCE', '用户余额不足以退款（可能已消费），转人工处理');
    }

    const after = wallet.cash_fen - refund.amount_fen;
    const ts = now();
    db.prepare('UPDATE wallets SET cash_fen = ?, updated_at = ? WHERE user_id = ?').run(after, ts, refund.user_id);
    db.prepare(
      `INSERT INTO ledger (id, user_id, kind, balance_kind, amount_fen, balance_after_fen, ref_type, ref_id, memo, created_at)
       VALUES (?, ?, 'refund', 'cash', ?, ?, 'refund', ?, ?, ?)`,
    ).run(id('lg'), refund.user_id, -refund.amount_fen, after, refund.id, `退款 ${(refund.amount_fen / 100).toFixed(2)} 元`, ts);

    const refunded = (order.refunded_fen || 0) + refund.amount_fen;
    const status = refunded >= order.amount_fen ? ORDER_STATUS.REFUNDED : ORDER_STATUS.PARTIAL_REFUNDED;
    db.prepare('UPDATE orders SET refunded_fen = ?, status = ? WHERE id = ?').run(refunded, status, order.id);
    db.prepare(`UPDATE refunds SET status = 'success', refund_id = ?, finished_at = ? WHERE id = ?`).run(
      wxRefundId || refund.refund_id,
      ts,
      refundId,
    );
    return { alreadyDone: false };
  });
}

/** 微信退款结果通知（异步时用） */
export function handleRefundNotify({ headers, rawBody }) {
  const wx = getWechatPay();
  wx.verifyNotify(headers, rawBody);
  const event = JSON.parse(rawBody);
  if (!event.resource) return { ok: true, ignored: event.event_type };
  const data = wx.decryptResource(event.resource);
  const refund = getDb().prepare('SELECT * FROM refunds WHERE out_refund_no = ?').get(data.out_refund_no);
  if (!refund) return { ok: true, ignored: 'unknown_refund' };
  if (data.refund_status === 'SUCCESS') {
    finalizeRefund(refund.id, { refundId: data.refund_id });
  } else if (data.refund_status === 'ABNORMAL' || data.refund_status === 'CLOSED') {
    getDb().prepare(`UPDATE refunds SET status = 'failed', finished_at = ? WHERE id = ?`).run(now(), refund.id);
  }
  return { ok: true };
}

/* ------------------------------------------------------------ 运维辅助 */

/** 关闭超时未支付订单（定时任务调用） */
export async function closeExpiredOrders() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM orders WHERE status = 'pending' AND expire_at IS NOT NULL AND expire_at < ?`).all(now());
  let closed = 0;
  for (const order of rows) {
    if (payProvider === 'wechat') {
      try {
        await getWechatPay().closeOrder(order.out_trade_no);
      } catch {
        /* 已支付或已关闭都会报错，忽略 */
      }
    }
    const out = db.prepare(`UPDATE orders SET status = 'closed' WHERE id = ? AND status = 'pending'`).run(order.id);
    closed += out.changes;
  }
  return { scanned: rows.length, closed };
}

export function getOrderForUser(orderId, userId) {
  const row = getDb().prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
  if (!row) throw fail(404, 'ORDER_NOT_FOUND', '订单不存在');
  return orderView(row);
}

export function listOrders({ status, limit = 50 } = {}) {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...orderView(r), userId: r.user_id }));
}

export { ORDER_STATUS };
