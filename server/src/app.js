import http from 'node:http';
import { config, isMockLLM, payProvider } from './config.js';
import { createRouter, fail, HttpError, readJson, readRaw, sendJson, serveStatic } from './lib/http.js';
import { requireAdmin, requireUser, signToken } from './lib/auth.js';
import { ensureUserByOpenid, getUser, publicUser, updateProfile } from './lib/users.js';
import { bindReferrer, referralChainOf, referralSummary, settlePending } from './lib/referral.js';
import { complete } from './lib/llm.js';
import { appendMessage, listMessages, maybeSummarize } from './lib/conversation.js';
import { buildMemoryText, clearMemories, deleteMemory, extractMemory, listMemories } from './lib/memory.js';
import { createPlan, generateLessonAudio, generateWeek, getLessonRow, lessonRowJson, listPlans, planDetail } from './lib/planner.js';
import {
  billingQuote,
  closeStaleSessions,
  endSession,
  heartbeat,
  listLedger,
  listSessions,
  meOverview,
  startSession,
  topup,
  walletView,
  withdraw,
} from './lib/billing.js';
import { activateMembership } from './lib/users.js';
import { ttsInfo } from './lib/tts.js';
import {
  closeExpiredOrders,
  createTopupOrder,
  getOrderForUser,
  handlePayNotify,
  handleRefundNotify,
  listOrders,
  mockPay,
  refundOrder,
} from './lib/payment.js';

const PLAN_INTENT = /(方案|计划|课表|规划|安排一下|排个|定制)/;

/* ------------------------------------------------------------------ 登录 */

async function wechatCode2Session(code) {
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', config.wechat.appId);
  url.searchParams.set('secret', config.wechat.secret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => ({}));
  if (!data.openid) throw fail(401, 'WX_LOGIN_FAILED', data.errmsg || '微信登录失败');
  return data.openid;
}

/* ------------------------------------------------------------------ 路由 */

export function buildRouter() {
  const r = createRouter();

  r.get('/api/health', (req, res) => {
    sendJson(res, 200, { ok: true, llm: isMockLLM ? 'mock' : 'deepseek', tts: ttsInfo(), time: Date.now() });
  });

  // 公开配置：给小程序首页/会员页展示文案用
  r.get('/api/config', (req, res) => {
    const ladder = config.referral.ladderBp;
    const pct = (i) => (ladder[i] === undefined ? '—' : `${ladder[i] / 100}%`);
    const mode = config.referral.mode;
    const ruleText =
      mode === 'cycle'
        ? `每推荐 3 个会员为一轮：第 1 个 ${pct(0)}、第 2 个 ${pct(1)}、第 3 个 ${pct(2)}，第 4 个重新回到 ${pct(0)}，循环计算`
        : mode === 'depth'
          ? `按层级：直推 ${pct(0)}、二级 ${pct(1)}、三级及以后 ${pct(2)}`
          : `按第几个会员递增：第 1 个 ${pct(0)}、第 2 个 ${pct(1)}、第 3 个及以后 ${pct(2)}`;
    const qualifyFen = config.referral.qualifyFen;

    sendJson(res, 200, {
      ok: true,
      priceFenPerMinute: config.priceFenPerMinute,
      priceLabel: `${(config.priceFenPerMinute / 100).toFixed(2)} 元/分钟`,
      trialSeconds: config.trialSeconds,
      trialLabel: `${Math.round(config.trialSeconds / 60)} 分钟`,
      minTopupFen: config.minTopupFen,
      minWithdrawFen: config.minWithdrawFen,
      referral: {
        mode,
        ladder,
        ladderLabel: ladder.map((b, i) => `第 ${i + 1} 个 ${b / 100}%`),
        ruleText,
        qualifyFen,
        qualifyLabel: qualifyFen > 0 ? `累计消费满 ${qualifyFen / 100} 元才计入序号` : '首单消费即计入序号',
        capTotalBp: config.referral.capTotalBp,
        settleDays: config.referral.settleDays,
      },
      pay: {
        provider: payProvider,
        label: payProvider === 'wechat' ? '微信支付' : '模拟支付（演示）',
        minTopupFen: config.minTopupFen,
        dailyLimitFen: 200000,
        orderTtlSec: config.pay.orderTtlSec,
      },
      llmMode: isMockLLM ? 'mock' : 'deepseek',
    });
  });

  r.post('/api/auth/login', async (req, res) => {
    const body = await readJson(req);
    const code = String(body.code || '').trim();
    if (!code) throw fail(400, 'MISSING_CODE', '缺少登录 code');

    let openid;
    const canUseWechat = config.wechat.appId && config.wechat.secret;
    if (canUseWechat && !code.startsWith('mock_')) {
      openid = await wechatCode2Session(code);
    } else {
      if (process.env.NODE_ENV === 'production') {
        throw fail(500, 'WX_NOT_CONFIGURED', '生产环境必须配置 WX_APPID / WX_SECRET');
      }
      openid = `mock_${code.slice(0, 40)}`;
    }

    const { user, created } = ensureUserByOpenid(openid, { nickname: body.nickname, avatar: body.avatar });
    let referral = null;
    let referralError = null;
    if (created && body.inviteCode) {
      try {
        referral = bindReferrer(user.id, String(body.inviteCode));
      } catch (err) {
        referralError = err.message;
      }
    }
    sendJson(res, 200, {
      ok: true,
      token: signToken(user.id),
      created,
      user: publicUser(getUser(user.id)),
      referral,
      referralError,
      overview: meOverview(user.id),
    });
  });

  /* ---------------------------------------------------------------- 我的 */

  r.get('/api/me', (req, res) => {
    const uid = requireUser(req);
    const overview = meOverview(uid);
    sendJson(res, 200, {
      ok: true,
      ...overview,
      memories: listMemories(uid),
      memoryText: buildMemoryText(uid),
      llmMode: isMockLLM ? 'mock' : 'deepseek',
    });
  });

  r.patch('/api/me', async (req, res) => {
    const uid = requireUser(req);
    const body = await readJson(req);
    const user = updateProfile(uid, body);
    sendJson(res, 200, { ok: true, user: publicUser(user) });
  });

  r.get('/api/me/memories', (req, res) => {
    const uid = requireUser(req);
    sendJson(res, 200, { ok: true, memories: listMemories(uid) });
  });

  r.delete('/api/me/memories', (req, res) => {
    const uid = requireUser(req);
    const removed = clearMemories(uid);
    sendJson(res, 200, { ok: true, removed });
  });

  r.delete('/api/me/memories/:id', (req, res, params) => {
    const uid = requireUser(req);
    const removed = deleteMemory(uid, params.id);
    sendJson(res, 200, { ok: true, removed: Boolean(removed) });
  });

  r.get('/api/me/ledger', (req, res) => {
    const uid = requireUser(req);
    sendJson(res, 200, { ok: true, items: listLedger(uid) });
  });

  r.get('/api/me/sessions', (req, res) => {
    const uid = requireUser(req);
    sendJson(res, 200, { ok: true, items: listSessions(uid) });
  });

  /* ---------------------------------------------------------------- 对话 */

  r.get('/api/chat/history', (req, res) => {
    const uid = requireUser(req);
    sendJson(res, 200, { ok: true, messages: listMessages(uid, 60) });
  });

  r.post('/api/chat', async (req, res) => {
    const uid = requireUser(req);
    const body = await readJson(req);
    const text = String(body.text || '').trim();
    if (!text) throw fail(400, 'EMPTY_TEXT', '说点什么吧');
    if (text.length > 2000) throw fail(400, 'TEXT_TOO_LONG', '一次最多 2000 字');

    appendMessage(uid, 'user', text);
    const memory = await extractMemory(uid, text);
    const memoryText = buildMemoryText(uid);

    const wantsPlan = body.wantPlan === true || PLAN_INTENT.test(text);
    let plan = null;
    let reply = '';
    let llmMode = isMockLLM ? 'mock' : 'deepseek';

    if (wantsPlan) {
      const created = await createPlan(uid, { goal: text, text });
      plan = created.plan;
      llmMode = created.llmMode;
      reply = `方案已经排好了：${plan.title}。共 ${plan.weeks} 周，每周 ${plan.sessionsPerWeek} 节音频课，每节 ${plan.minutesPerSession} 分钟。第一周先做「${plan.milestones[0]?.focus || '基础诊断'}」，产出是「${plan.milestones[0]?.deliverable || '一份薄弱点清单'}」。你可以点下面的按钮，把第一周的课直接生成成音频，走路的时候听。`;
    } else {
      const out = await complete('chat', { text, memoryText, historyText: listMessages(uid, 8).map((m) => `${m.role === 'user' ? '学习者' : '教练'}：${m.content}`).join('\n') });
      reply = out.text.trim();
      llmMode = out.mode;
    }

    appendMessage(uid, 'assistant', reply, plan?.id || null);
    await maybeSummarize(uid);

    sendJson(res, 200, {
      ok: true,
      reply,
      plan,
      llmMode,
      memories: memory.added,
      memoryText,
      wallet: walletView(uid),
    });
  });

  /* ---------------------------------------------------------------- 方案 */

  r.get('/api/plans', (req, res) => {
    const uid = requireUser(req);
    sendJson(res, 200, { ok: true, plans: listPlans(uid) });
  });

  r.post('/api/plans', async (req, res) => {
    const uid = requireUser(req);
    const body = await readJson(req);
    const created = await createPlan(uid, body);
    sendJson(res, 200, { ok: true, plan: created.plan, llmMode: created.llmMode });
  });

  r.get('/api/plans/:id', (req, res, params) => {
    const uid = requireUser(req);
    sendJson(res, 200, { ok: true, ...planDetail(uid, params.id) });
  });

  r.post('/api/plans/:id/weeks/:week/lessons', async (req, res, params) => {
    const uid = requireUser(req);
    const out = await generateWeek(uid, params.id, Number(params.week));
    sendJson(res, 200, { ok: true, ...out });
  });

  r.get('/api/lessons/:id', (req, res, params) => {
    const uid = requireUser(req);
    sendJson(res, 200, { ok: true, lesson: lessonRowJson(getLessonRow(uid, params.id)) });
  });

  r.post('/api/lessons/:id/audio', async (req, res, params) => {
    const uid = requireUser(req);
    const lesson = await generateLessonAudio(uid, params.id);
    sendJson(res, 200, { ok: true, lesson });
  });

  /* ---------------------------------------------------------- 计费与会员 */

  r.get('/api/billing/quote', (req, res) => {
    const uid = requireUser(req);
    sendJson(res, 200, { ok: true, quote: billingQuote(uid), wallet: walletView(uid) });
  });

  r.post('/api/membership/activate', (req, res) => {
    const uid = requireUser(req);
    const user = activateMembership(uid);
    sendJson(res, 200, { ok: true, user: publicUser(user), wallet: walletView(uid), quote: billingQuote(uid) });
  });

  // 老接口：演示环境的直接到账。真实支付改用 /api/pay/order + 回调入账
  r.post('/api/billing/topup', async (req, res) => {
    if (payProvider === 'wechat' || process.env.NODE_ENV === 'production') {
      throw fail(403, 'USE_PAY_ORDER', '请使用 /api/pay/order 发起微信支付，入账以支付回调为准');
    }
    const uid = requireUser(req);
    const body = await readJson(req);
    const out = topup(uid, { amountFen: body.amountFen, channel: body.channel || 'mock' });
    sendJson(res, 200, { ok: true, ...out, quote: billingQuote(uid) });
  });

  /* ------------------------------------------------------------ 支付 */

  /** 创建充值订单：返回订单 + 拉起支付所需参数 */
  r.post('/api/pay/order', async (req, res) => {
    const uid = requireUser(req);
    const body = await readJson(req);
    const out = await createTopupOrder(uid, {
      amountFen: body.amountFen,
      clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    });
    sendJson(res, 200, { ok: true, ...out, wallet: walletView(uid), quote: billingQuote(uid) });
  });

  /** 前端轮询订单状态（支付完成后确认） */
  r.get('/api/pay/orders/:id', (req, res, params) => {
    const uid = requireUser(req);
    sendJson(res, 200, { ok: true, order: getOrderForUser(params.id, uid), wallet: walletView(uid) });
  });

  /** 演示：模拟支付成功（真实通道下 403） */
  r.post('/api/pay/mock-pay', async (req, res) => {
    const uid = requireUser(req);
    const body = await readJson(req);
    const out = mockPay(uid, body.orderId);
    sendJson(res, 200, { ok: true, ...out, quote: billingQuote(uid) });
  });

  /** 微信支付结果通知（必须用原文验签） */
  r.post('/api/pay/notify', async (req, res) => {
    const rawBody = await readRaw(req);
    try {
      const out = handlePayNotify({ headers: req.headers, rawBody });
      // 微信要求返回 200 + SUCCESS，否则会重试
      sendJson(res, 200, { code: 'SUCCESS', message: '成功', ...out });
    } catch (err) {
      console.error('[pay-notify]', err.message);
      sendJson(res, 400, { code: 'FAIL', message: err.message });
    }
  });

  /** 微信退款结果通知 */
  r.post('/api/pay/refund-notify', async (req, res) => {
    const rawBody = await readRaw(req);
    try {
      handleRefundNotify({ headers: req.headers, rawBody });
      sendJson(res, 200, { code: 'SUCCESS', message: '成功' });
    } catch (err) {
      console.error('[refund-notify]', err.message);
      sendJson(res, 400, { code: 'FAIL', message: err.message });
    }
  });

  r.post('/api/billing/withdraw', async (req, res) => {
    const uid = requireUser(req);
    const body = await readJson(req);
    const out = withdraw(uid, body.amountFen, body.channel);
    sendJson(res, 200, { ok: true, ...out });
  });

  /* ------------------------------------------------------------ 听课时长 */

  r.post('/api/sessions', async (req, res) => {
    const uid = requireUser(req);
    const body = await readJson(req);
    const session = startSession(uid, body.lessonId || null);
    sendJson(res, 200, { ok: true, session });
  });

  r.post('/api/sessions/:id/heartbeat', async (req, res, params) => {
    const uid = requireUser(req);
    const body = await readJson(req);
    sendJson(res, 200, { ok: true, ...heartbeat(params.id, uid, body.playedSeconds) });
  });

  r.post('/api/sessions/:id/end', async (req, res, params) => {
    const uid = requireUser(req);
    const body = await readJson(req);
    const receipt = endSession(params.id, uid, body.playedSeconds);
    sendJson(res, 200, { ok: true, receipt, quote: billingQuote(uid) });
  });

  /* ---------------------------------------------------------------- 推荐 */

  r.get('/api/referral', (req, res) => {
    const uid = requireUser(req);
    sendJson(res, 200, { ok: true, ...referralSummary(uid), wallet: walletView(uid) });
  });

  r.get('/api/referral/chain', (req, res) => {
    const uid = requireUser(req);
    sendJson(res, 200, { ok: true, chain: referralChainOf(uid) });
  });

  /* ---------------------------------------------------------------- 运营 */

  r.post('/api/admin/settle-commissions', async (req, res) => {
    requireAdmin(req);
    const body = await readJson(req).catch(() => ({}));
    const out = settlePending({ all: Boolean(body.all) });
    sendJson(res, 200, { ok: true, ...out });
  });

  r.post('/api/admin/close-stale-sessions', (req, res) => {
    requireAdmin(req);
    const out = closeStaleSessions();
    sendJson(res, 200, { ok: true, closed: out.length, items: out });
  });

  r.get('/api/admin/orders', (req, res, params, query) => {
    requireAdmin(req);
    sendJson(res, 200, { ok: true, items: listOrders({ status: query.get('status') || undefined, limit: Number(query.get('limit')) || 50 }) });
  });

  r.post('/api/admin/refund', async (req, res) => {
    requireAdmin(req);
    const body = await readJson(req);
    const out = await refundOrder({
      orderId: body.orderId,
      amountFen: body.amountFen,
      reason: body.reason || '运营退款',
      operator: body.operator || 'admin',
    });
    sendJson(res, 200, { ok: true, ...out });
  });

  r.post('/api/admin/close-orders', async (req, res) => {
    requireAdmin(req);
    const out = await closeExpiredOrders();
    sendJson(res, 200, { ok: true, ...out });
  });

  return r;
}

/* ------------------------------------------------------------------ 服务 */

function errorPayload(err) {
  if (err instanceof HttpError) {
    return { status: err.status, body: { ok: false, error: { code: err.code, message: err.message, ...(err.extra || {}) } } };
  }
  return {
    status: 500,
    body: { ok: false, error: { code: 'INTERNAL_ERROR', message: err.message || '服务器内部错误' } },
  };
}

export function createApp() {
  const router = buildRouter();
  const webDemoDir = `${config.root}/web-demo`;

  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-token, x-admin-secret');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await router.handle(req, res);
        if (!handled) throw fail(404, 'NOT_FOUND', '接口不存在');
        return;
      }
      if (url.pathname.startsWith('/media/')) {
        const file = url.pathname.slice('/media/'.length);
        if (!serveStatic(req, res, config.mediaDir, file)) throw fail(404, 'MEDIA_NOT_FOUND', '音频不存在');
        return;
      }
      // 浏览器演示台
      const staticPath = url.pathname === '/' ? 'index.html' : url.pathname;
      if (serveStatic(req, res, webDemoDir, staticPath)) return;
      throw fail(404, 'NOT_FOUND', '页面不存在');
    } catch (err) {
      const { status, body } = errorPayload(err);
      if (status >= 500) console.error('[error]', err);
      if (!res.headersSent) sendJson(res, status, body);
      else res.end();
    }
  });

  return { server, router };
}
