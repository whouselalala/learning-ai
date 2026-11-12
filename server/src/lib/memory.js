import { getDb, now } from '../db.js';
import { id } from './ids.js';
import { completeJson } from './llm.js';

const KINDS = new Set([
  'goal',
  'level',
  'subject',
  'weakness',
  'strength',
  'preference',
  'schedule',
  'pace',
  'motivation',
  'constraint',
]);

export const MEMORY_KIND_LABEL = {
  goal: '目标',
  level: '学段',
  subject: '科目',
  weakness: '薄弱点',
  strength: '优势',
  preference: '偏好',
  schedule: '时间',
  pace: '节奏',
  motivation: '动机',
  constraint: '限制',
};

const MAX_MEMORIES = 80;

function clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.6;
  return Math.min(1, Math.max(0.1, n));
}

/** 写入/更新一条长期记忆（同一 kind+key 覆盖旧值，并抬升置信度） */
export function upsertMemory(userId, fact, source = 'chat') {
  const kind = String(fact.kind || '').trim();
  const key = String(fact.key || '').trim().slice(0, 40);
  const value = String(fact.value || '').trim().slice(0, 300);
  if (!KINDS.has(kind) || !key || !value) return null;

  const db = getDb();
  const ts = now();
  const existing = db
    .prepare('SELECT id, value, confidence FROM memories WHERE user_id = ? AND kind = ? AND key = ?')
    .get(userId, kind, key);

  if (existing) {
    db.prepare(
      `UPDATE memories
          SET value = ?, confidence = MAX(confidence, ?), hit_count = hit_count + 1, source = ?, updated_at = ?
        WHERE id = ?`,
    ).run(value, clampConfidence(fact.confidence), source, ts, existing.id);
    return { id: existing.id, kind, key, value, changed: existing.value !== value };
  }

  const memId = id('mem');
  db.prepare(
    `INSERT INTO memories (id, user_id, kind, key, value, confidence, hit_count, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(memId, userId, kind, key, value, clampConfidence(fact.confidence), source, ts, ts);

  // 控制单用户记忆规模，淘汰最久未更新的低价值记忆
  db.prepare(
    `DELETE FROM memories
      WHERE user_id = ?
        AND id NOT IN (
          SELECT id FROM memories WHERE user_id = ?
          ORDER BY confidence DESC, updated_at DESC LIMIT ?
        )`,
  ).run(userId, userId, MAX_MEMORIES);

  return { id: memId, kind, key, value, changed: true };
}

export function listMemories(userId) {
  return getDb()
    .prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY confidence DESC, updated_at DESC')
    .all(userId)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      kindLabel: MEMORY_KIND_LABEL[row.kind] || row.kind,
      key: row.key,
      value: row.value,
      confidence: row.confidence,
      hitCount: row.hit_count,
      updatedAt: row.updated_at,
    }));
}

/** 把记忆拼成可注入提示词的文本，按置信度与新鲜度排序 */
export function buildMemoryText(userId, limit = 24) {
  const rows = getDb()
    .prepare(
      `SELECT kind, key, value, confidence, updated_at FROM memories
        WHERE user_id = ?
        ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
    )
    .all(userId, limit);
  if (!rows.length) return '';
  return rows
    .map((r) => `- [${MEMORY_KIND_LABEL[r.kind] || r.kind}|${r.key}] ${r.value}（置信度 ${r.confidence.toFixed(2)}）`)
    .join('\n');
}

/** 调用模型从一轮对话里抽取事实并落库 */
export async function extractMemory(userId, text, historyText = '') {
  if (!text || text.trim().length < 4) return { added: [], mode: 'skip' };
  const memoryText = buildMemoryText(userId);
  const { data, mode } = await completeJson('memory-extract', {
    text,
    historyText,
    memoryText,
  });
  const facts = Array.isArray(data?.facts) ? data.facts : [];
  const saved = [];
  for (const fact of facts.slice(0, 8)) {
    const out = upsertMemory(userId, fact);
    if (out) saved.push(out);
  }
  return { added: saved, mode };
}

export function deleteMemory(userId, memoryId) {
  return getDb().prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(memoryId, userId).changes;
}

export function clearMemories(userId) {
  return getDb().prepare('DELETE FROM memories WHERE user_id = ?').run(userId).changes;
}
