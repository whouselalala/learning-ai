import { getDb, now } from '../db.js';
import { id } from './ids.js';
import { complete } from './llm.js';

const WINDOW = 10; // 每次注入提示词的最近消息条数
const SUMMARY_TRIGGER = 24; // 累计消息超过这个数就压缩
const SUMMARY_BATCH = 16; // 每次压缩最老的多少条

export function appendMessage(userId, role, content, planId = null) {
  const db = getDb();
  const msgId = id('msg');
  db.prepare(
    'INSERT INTO messages (id, user_id, role, content, plan_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(msgId, userId, role, content, planId, now());
  return msgId;
}

export function listMessages(userId, limit = 50) {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit);
  return rows
    .reverse()
    .map((r) => ({ id: r.id, role: r.role, content: r.content, planId: r.plan_id, createdAt: r.created_at }));
}

export function messageCount(userId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM messages WHERE user_id = ?').get(userId).c;
}

export function getSummary(userId) {
  const row = getDb().prepare('SELECT summary FROM users WHERE id = ?').get(userId);
  return row?.summary || '';
}

/** 把最近若干轮拼成提示词用的文本 */
export function historyText(userId, limit = WINDOW) {
  const rows = getDb()
    .prepare('SELECT role, content FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit)
    .reverse();
  return rows.map((r) => `${r.role === 'user' ? '学习者' : '教练'}：${r.content}`).join('\n');
}

/**
 * 滚动摘要：把最老的未压缩消息压成一段提要，避免上下文无限增长。
 * 返回是否发生了压缩。
 */
export async function maybeSummarize(userId) {
  const db = getDb();
  const user = db.prepare('SELECT summary, summary_upto FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  const total = messageCount(userId);
  if (total < SUMMARY_TRIGGER) return false;

  const unsummarized = total - (user.summary_upto || 0);
  if (unsummarized < SUMMARY_BATCH) return false;

  const rows = db
    .prepare('SELECT role, content FROM messages WHERE user_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?')
    .all(userId, SUMMARY_BATCH, user.summary_upto || 0);
  if (!rows.length) return false;

  const texts = [
    user.summary ? `已有提要：${user.summary}` : '',
    ...rows.map((r) => `${r.role === 'user' ? '学习者' : '教练'}：${r.content}`),
  ].filter(Boolean);

  const { text } = await complete('summary', { texts });
  db.prepare('UPDATE users SET summary = ?, summary_upto = ? WHERE id = ?').run(
    text.trim().slice(0, 600),
    (user.summary_upto || 0) + rows.length,
    userId,
  );
  return true;
}

/** 组装一次对话需要的全部上下文 */
export function buildConversationContext(userId) {
  return {
    summary: getSummary(userId),
    historyText: historyText(userId),
  };
}
