/**
 * 端到端冒烟：对着已经启动的服务跑一遍核心接口。
 * 用法：node server/scripts/smoke.js  （可加 BASE_URL=http://127.0.0.1:8787）
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const rand = () => Math.random().toString(36).slice(2, 8);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const ok = (label, extra = '') => console.log(`  ✔ ${label}${extra ? ' · ' + extra : ''}`);

const health = await call('GET', '/api/health');
console.log(`服务 ${BASE} · LLM=${health.llm} · TTS=${health.tts.provider}`);

const cfg = await call('GET', '/api/config');
ok('公开配置', `${cfg.priceLabel} / 体验 ${cfg.trialLabel}`);

const owner = await call('POST', '/api/auth/login', { body: { code: `smoke_owner_${rand()}`, nickname: '推荐人' } });
ok('注册推荐人', `邀请码 ${owner.user.inviteCode}`);

const buyer = await call('POST', '/api/auth/login', {
  body: { code: `smoke_buyer_${rand()}`, nickname: '学生小陈', inviteCode: owner.user.inviteCode },
});
ok('注册学生并绑定推荐人', buyer.referral ? `上级 ${buyer.referral.nickname}` : '未绑定');

const chat = await call('POST', '/api/chat', {
  token: buyer.token,
  body: { text: '我高二，数学函数和导数总丢分，每天能学 40 分钟，想冲 120 分', wantPlan: true },
});
ok('对话 + 记忆抽取 + 方案生成', `记忆 ${chat.memories.length} 条 / 方案《${chat.plan.title}》`);

const week = await call('POST', `/api/plans/${chat.plan.id}/weeks/1/lessons`, { token: buyer.token });
ok('生成第一周课程', `${week.lessons.length} 节：${week.lessons[0].title}`);

const audio = await call('POST', `/api/lessons/${week.lessons[0].id}/audio`, { token: buyer.token });
ok('生成讲稿/音频', `${audio.lesson.script.length} 字 · ${audio.lesson.audioAvailable ? audio.lesson.audioUrl : '仅文本'}`);

const session = await call('POST', '/api/sessions', { token: buyer.token, body: { lessonId: week.lessons[0].id } });
ok('开始听课', `${session.session.funding === 'trial' ? '免费体验' : '会员计费'} · 体验余 ${session.session.trialSecondsLeft}s`);

const beat = await call('POST', `/api/sessions/${session.session.sessionId}/heartbeat`, {
  token: buyer.token,
  body: { playedSeconds: 3 },
});
ok('心跳计时', `服务端 ${beat.serverSeconds}s`);

const end = await call('POST', `/api/sessions/${session.session.sessionId}/end`, {
  token: buyer.token,
  body: { playedSeconds: 3 },
});
ok('结算', `体验 ${end.receipt.trialSeconds}s / 扣费 ${end.receipt.costFen} 分`);

const ref = await call('GET', '/api/referral', { token: owner.token });
ok('推荐中心', `团队 ${ref.totalTeam} 人 · 待结算 ${(ref.pendingFen / 100).toFixed(2)} 元`);

const me = await call('GET', '/api/me', { token: buyer.token });
ok('个人中心', `记忆 ${me.memories.length} 条 · 余额 ${(me.wallet.cashFen / 100).toFixed(2)} 元`);

console.log('\n冒烟通过。浏览器演示台：' + BASE + '/');
