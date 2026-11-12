process.env.DB_FILE = ':memory:';
process.env.TTS_PROVIDER = 'mock';

import test from 'node:test';
import assert from 'node:assert/strict';

const { getDb } = await import('../src/db.js');
const { ensureUserByOpenid } = await import('../src/lib/users.js');
const { extractMemory, listMemories, buildMemoryText, upsertMemory, clearMemories, deleteMemory } =
  await import('../src/lib/memory.js');

const db = getDb();
const rand = () => Math.random().toString(36).slice(2, 10);
const newUser = (openid) => ensureUserByOpenid(openid, { nickname: openid }).user;

test('从一段自我介绍里抽取结构化画像', async () => {
  const u = newUser(`m_${rand()}`);
  const out = await extractMemory(u.id, '我高二，数学的函数和导数老是丢分，每天只有 40 分钟能学，想冲 120 分，比较喜欢听音频。');
  assert.ok(out.added.length >= 3, `至少抽到 3 条，实际 ${out.added.length}`);
  const kinds = new Set(listMemories(u.id).map((m) => m.kind));
  assert.ok(kinds.has('level'));
  assert.ok(kinds.has('weakness'));

  const text = buildMemoryText(u.id);
  assert.match(text, /学段|薄弱点/);
  assert.match(text, /高二/);
});

test('同一 kind+key 覆盖旧值而不是堆重复记录', () => {
  const u = newUser(`m_${rand()}`);
  upsertMemory(u.id, { kind: 'goal', key: 'exam', value: '期末数学进前 10', confidence: 0.8 });
  upsertMemory(u.id, { kind: 'goal', key: 'exam', value: '高考数学 120 分', confidence: 0.9 });

  const rows = listMemories(u.id).filter((m) => m.kind === 'goal' && m.key === 'exam');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '高考数学 120 分');
  assert.equal(rows[0].hitCount, 2);
  assert.ok(rows[0].confidence >= 0.9);
});

test('非法边界的记忆被拒绝写入', () => {
  const u = newUser(`m_${rand()}`);
  assert.equal(upsertMemory(u.id, { kind: 'hobby', key: 'x', value: 'y' }), null);
  assert.equal(upsertMemory(u.id, { kind: 'goal', key: '', value: 'y' }), null);
  assert.equal(upsertMemory(u.id, { kind: 'goal', key: 'x', value: '' }), null);
  assert.equal(listMemories(u.id).length, 0);
});

test('单用户记忆上限 80 条，超出的低价值记忆被淘汰', () => {
  const u = newUser(`m_${rand()}`);
  for (let i = 0; i < 95; i += 1) {
    upsertMemory(u.id, { kind: 'preference', key: `p${i}`, value: `偏好 ${i}`, confidence: 0.5 });
  }
  assert.ok(listMemories(u.id).length <= 80);
});

test('记忆按用户隔离，可单条删除或清空', async () => {
  const a = newUser(`m_${rand()}`);
  const b = newUser(`m_${rand()}`);
  await extractMemory(a.id, '我初三，物理的电路分析薄弱。');
  assert.ok(listMemories(a.id).length > 0);
  assert.equal(listMemories(b.id).length, 0);

  const before = listMemories(a.id).length;
  const first = listMemories(a.id)[0];
  assert.equal(deleteMemory(a.id, first.id), 1);
  assert.equal(listMemories(a.id).length, before - 1);
  clearMemories(a.id);
  assert.equal(listMemories(a.id).length, 0);
});
