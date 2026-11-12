/**
 * 演示数据：跑通「注册 → 绑定推荐关系 → 开通会员 → 充值 → 生成方案 → 生成音频课 → 听课扣费 → 循环佣金」。
 * 重点演示两条规则：
 *   1. 累计消费满 100 元才计入序号（没达标不占位、不分佣）
 *   2. 每 3 个达标会员为一轮：20% → 50% → 90% → 20% …
 * 用法：npm run seed
 */
import path from 'node:path';

process.env.DB_FILE = process.env.DB_FILE || path.resolve(import.meta.dirname, '..', '..', 'data', 'app.db');
process.env.TTS_PROVIDER = process.env.TTS_PROVIDER || 'mock';

const { getDb, now } = await import('../src/db.js');
const { ensureUserByOpenid, activateMembership } = await import('../src/lib/users.js');
const { bindReferrer, referralSummary, rateForOrdinal, rateLabel } = await import('../src/lib/referral.js');
const { topup, endSession, walletView, listLedger } = await import('../src/lib/billing.js');
const { createPlan, generateWeek, generateLessonAudio, planDetail } = await import('../src/lib/planner.js');
const { config } = await import('../src/config.js');
const { id } = await import('../src/lib/ids.js');

const db = getDb();
const money = (fen) => `${(fen / 100).toFixed(2)} 元`;
const fmtMin = (sec) => (sec % 60 === 0 ? String(sec / 60) : (sec / 60).toFixed(1));

function createUser(openid, nickname) {
  return ensureUserByOpenid(openid, { nickname }).user;
}

/** 造一段“过去 N 秒”的听课记录，直接结算 */
function consume(userId, seconds) {
  const startedAt = now() - seconds * 1000 - 1200;
  const sessionId = id('ses');
  db.prepare(
    `INSERT INTO sessions (id, user_id, lesson_id, started_at, last_beat_at, status)
     VALUES (?, ?, NULL, ?, ?, 'active')`,
  ).run(sessionId, userId, startedAt, now() - 500);
  return endSession(sessionId, userId, seconds);
}

function ready(user, cashFen = 15000) {
  consume(user.id, 3600); // 先烧完 60 分钟体验
  activateMembership(user.id);
  topup(user.id, { amountFen: cashFen });
}

console.log(`推荐规则：累计消费满 ${money(config.referral.qualifyFen)} 才计入序号；`
  + `每 3 个一轮 ${config.referral.ladderBp.map((b) => `${b / 100}%`).join(' → ')} 循环`);

console.log('\n① 注册 1 个推荐人 + 6 个直推会员');
const owner = createUser('seed_owner', '王老师（推荐人）');
const students = [];
for (let i = 1; i <= 6; i += 1) {
  const s = createUser(`seed_s${i}`, `学生${i}号`);
  bindReferrer(s.id, owner.invite_code);
  students.push(s);
}
console.log(`   ${students.map((s) => s.nickname).join('、')}`);

console.log('\n② 逐个消费（0.8 元/分钟；累计满 50 元才会计入序号）');
// 学生1 分两段，演示“达标前 0 佣金、达标当笔开始计提”
// 30 分钟 24 元（未达标）+ 32.5 分钟 26 元 = 累计 50 元（达标）
const legs = [
  [1800, 1950],
  [3750],
  [3750],
  [3750],
  [3750],
  [3750],
];
const totalCost = { value: 0 };
const totalCommission = { value: 0 };

for (let i = 0; i < students.length; i += 1) {
  const s = students[i];
  ready(s);
  let cumulative = 0;
  for (const seconds of legs[i]) {
    const r = consume(s.id, seconds);
    cumulative += r.costFen;
    totalCost.value += r.costFen;
    totalCommission.value += r.commission.totalFen;
    const row = db.prepare('SELECT qualified_at, qualify_ordinal FROM users WHERE id = ?').get(s.id);
    const qualified = Boolean(row.qualified_at);
    const rateText = qualified ? `${rateLabel(rateForOrdinal(row.qualify_ordinal))}（第 ${row.qualify_ordinal} 个）` : '未达标';
    console.log(
      `   ${s.nickname}：听 ${fmtMin(seconds)} 分钟 → 消费 ${money(r.costFen)}，累计 ${money(cumulative)}` +
        ` → ${qualified ? '已达标' : '未达标'}，${qualified ? rateText : '不分佣'}，佣金 ${money(r.commission.totalFen)}`,
    );
  }
}

console.log(
  `\n   合计消费 ${money(totalCost.value)}，佣金 ${money(totalCommission.value)}，` +
    `平台留存 ${money(totalCost.value - totalCommission.value)}（${((1 - totalCommission.value / totalCost.value) * 100).toFixed(1)}%）`,
);

console.log('\n③ 推荐中心视角');
const summary = referralSummary(owner.id);
console.log(`   直推 ${summary.directCount} 人，已达标 ${summary.qualifiedCount} 人，待结算 ${money(summary.pendingFen)}`);
for (const m of summary.members) {
  console.log(`   第 ${String(m.ordinal).padStart(2, ' ')} 个 · ${m.nickname} · ${m.rateLabel.padEnd(4)} · 累计 ${money(m.cumulativeFen)} · 佣金 ${money(m.pendingFen + m.settledFen)}`);
}
for (const b of summary.byRate) {
  console.log(`   ${b.label} 档：${b.memberCount} 人，${money(b.pendingFen + b.settledFen)}`);
}

console.log('\n④ 抽一个学生生成方案 + 第一周音频课');
const { plan } = await createPlan(students[0].id, {
  goal: '高二数学，函数和导数总丢分，想冲 120 分，每天能学 40 分钟',
  weeks: 4,
});
const week = await generateWeek(students[0].id, plan.id, 1);
const audio = await generateLessonAudio(students[0].id, week.lessons[0].id);
console.log(`   ${plan.title}（${plan.weeks} 周 / 每周 ${plan.sessionsPerWeek} 节）`);
console.log(`   第一周：${week.lessons.map((l) => l.title).join('；')}`);
console.log(`   首节课音频：${audio.audioAvailable ? audio.audioUrl : '未生成（本机语音不可用，降级为文本 + 计时）'}，时长 ${audio.durationSec}s`);

console.log('\n⑤ 学生1号 的账单流水');
for (const item of listLedger(students[0].id).slice(0, 6)) {
  console.log(`   ${new Date(item.createdAt).toLocaleString('zh-CN')} ${item.kind.padEnd(10)} ${money(item.amountFen)} → 余额 ${money(item.balanceAfterFen)}`);
}

const detail = planDetail(students[0].id, plan.id);
console.log(`\n⑥ 方案详情：${detail.weeks.length} 周，已完成 ${detail.progress.completedLessons}/${detail.progress.totalLessons || 0} 节`);
console.log(`   学生1号钱包：${JSON.stringify(walletView(students[0].id))}`);
console.log(`\n演示台可用任意称呼登录（会创建新账号）；推荐人邀请码：${owner.invite_code}`);
