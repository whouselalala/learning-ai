import { getDb, now } from '../db.js';
import { fail } from './http.js';
import { id } from './ids.js';
import { complete, completeJson } from './llm.js';
import { buildMemoryText } from './memory.js';
import { buildConversationContext } from './conversation.js';
import { estimateDurationSec, mediaUrl, synthesize } from './tts.js';

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

function normalizePlan(raw = {}, input = {}) {
  const weeks = clampInt(raw.weeks ?? input.weeks, 1, 24, 4);
  const sessionsPerWeek = clampInt(raw.sessionsPerWeek ?? input.sessionsPerWeek, 1, 7, 3);
  const minutesPerSession = clampInt(raw.minutesPerSession ?? input.minutesPerSession, 10, 60, 20);

  const milestones = Array.from({ length: weeks }, (_, i) => {
    const src = Array.isArray(raw.milestones) ? raw.milestones[i] || {} : {};
    return {
      week: i + 1,
      focus: String(src.focus || (i === 0 ? '诊断与基础补齐' : i === weeks - 1 ? '综合模拟与复盘' : '专项突破')).slice(0, 60),
      deliverable: String(src.deliverable || '完成本周音频课并提交一次口述复述').slice(0, 120),
      topics: Array.isArray(src.topics) ? src.topics.slice(0, 4).map((t) => String(t).slice(0, 40)) : [],
      targetMinutes: clampInt(src.targetMinutes, 10, 600, sessionsPerWeek * minutesPerSession),
    };
  });

  return {
    title: String(raw.title || `${raw.subject || '学习'}个性化提升方案`).slice(0, 60),
    subject: String(raw.subject || input.subject || '综合').slice(0, 20),
    level: String(raw.level || input.level || '未说明').slice(0, 20),
    goal: String(raw.goal || input.goal || '').slice(0, 200),
    weeks,
    sessionsPerWeek,
    minutesPerSession,
    milestones,
    notes: String(raw.notes || '').slice(0, 500),
  };
}

function planRowToJson(row) {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    level: row.level,
    goal: row.goal,
    weeks: row.weeks,
    sessionsPerWeek: row.sessions_per_week,
    minutesPerSession: row.minutes_per_session,
    milestones: JSON.parse(row.milestones_json || '[]'),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 生成并保存一份学习方案 */
export async function createPlan(userId, input = {}) {
  const memoryText = buildMemoryText(userId);
  const ctx = buildConversationContext(userId);
  const { data, mode } = await completeJson('plan', {
    goal: input.goal || input.text || '',
    text: input.text || '',
    subject: input.subject || '',
    level: input.level || '',
    weeks: input.weeks || 4,
    sessionsPerWeek: input.sessionsPerWeek || 3,
    minutesPerSession: input.minutesPerSession || 20,
    memoryText,
    historyText: ctx.historyText,
  });

  const plan = normalizePlan(data, input);
  const db = getDb();
  const planId = id('plan');
  const ts = now();
  db.prepare(
    `INSERT INTO plans (id, user_id, title, subject, goal, level, weeks, sessions_per_week, minutes_per_session,
                        milestones_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    planId,
    userId,
    plan.title,
    plan.subject,
    plan.goal,
    plan.level,
    plan.weeks,
    plan.sessionsPerWeek,
    plan.minutesPerSession,
    JSON.stringify(plan.milestones),
    ts,
    ts,
  );

  return { plan: planRowToJson(db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)), llmMode: mode };
}

export function listPlans(userId) {
  return getDb()
    .prepare('SELECT * FROM plans WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map((row) => {
      const lessons = getDb().prepare('SELECT COUNT(*) AS c FROM lessons WHERE plan_id = ?').get(row.id).c;
      return { ...planRowToJson(row), lessonCount: lessons };
    });
}

export function getPlanRow(userId, planId) {
  const row = getDb().prepare('SELECT * FROM plans WHERE id = ? AND user_id = ?').get(planId, userId);
  if (!row) throw fail(404, 'PLAN_NOT_FOUND', '方案不存在');
  return row;
}

export function lessonRowJson(row) {
  return lessonRowToJson(row);
}

function lessonRowToJson(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    seq: row.seq,
    week: row.week,
    title: row.title,
    objectives: JSON.parse(row.objectives_json || '[]'),
    script: row.script,
    audioUrl: mediaUrl(row.audio_file),
    durationSec: row.duration_sec || (row.script ? estimateDurationSec(row.script) : 0),
    status: row.status,
  };
}

export function planDetail(userId, planId) {
  const row = getPlanRow(userId, planId);
  const plan = planRowToJson(row);
  const lessons = getDb()
    .prepare('SELECT * FROM lessons WHERE plan_id = ? ORDER BY seq ASC')
    .all(planId)
    .map(lessonRowToJson);
  const byWeek = plan.milestones.map((m) => ({
    ...m,
    lessons: lessons.filter((l) => l.week === m.week),
  }));
  const done = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT lesson_id) AS c FROM sessions
        WHERE user_id = ? AND lesson_id IS NOT NULL AND billed_seconds > 0 AND lesson_id IN (SELECT id FROM lessons WHERE plan_id = ?)`,
    )
    .get(userId, planId).c;
  return { plan, weeks: byWeek, lessons, progress: { completedLessons: done, totalLessons: lessons.length } };
}

function normalizeLessons(raw, { week, count, fallbackMinutes }) {
  const list = Array.isArray(raw?.lessons) ? raw.lessons : [];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const src = list[i] || {};
    out.push({
      title: String(src.title || `第 ${week} 周 · 第 ${i + 1} 课`).slice(0, 60),
      objectives: (Array.isArray(src.objectives) ? src.objectives : []).slice(0, 4).map((o) => String(o).slice(0, 80)),
      keyPoints: (Array.isArray(src.keyPoints) ? src.keyPoints : []).slice(0, 5).map((o) => String(o).slice(0, 80)),
      minutes: clampInt(src.minutes, 5, 60, fallbackMinutes),
    });
  }
  return out;
}

/** 为一周生成课程清单（幂等：已有则直接返回） */
export async function generateWeek(userId, planId, week) {
  const db = getDb();
  const planRow = getPlanRow(userId, planId);
  const plan = planRowToJson(planRow);
  const w = clampInt(week, 1, plan.weeks, 1);

  const existing = db
    .prepare('SELECT * FROM lessons WHERE plan_id = ? AND week = ? ORDER BY seq')
    .all(planId, w)
    .map(lessonRowToJson);
  if (existing.length) return { week: w, lessons: existing, created: false };

  const milestone = plan.milestones[w - 1] || {};
  const { data, mode } = await completeJson('week-lessons', {
    subject: plan.subject,
    level: plan.level,
    week: w,
    focus: milestone.focus || '',
    topics: milestone.topics || [],
    count: plan.sessionsPerWeek,
    memoryText: buildMemoryText(userId),
  });

  const list = normalizeLessons(data, { week: w, count: plan.sessionsPerWeek, fallbackMinutes: plan.minutesPerSession });
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM lessons WHERE plan_id = ?').get(planId).s;
  const ts = now();
  const created = list.map((lesson, i) => {
    const lessonId = id('ls');
    db.prepare(
      `INSERT INTO lessons (id, plan_id, user_id, seq, week, title, objectives_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
    ).run(lessonId, planId, userId, maxSeq + i + 1, w, lesson.title, JSON.stringify(lesson.objectives), ts);
    return lessonRowToJson(db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId));
  });

  return { week: w, lessons: created, created: true, llmMode: mode };
}

export function getLessonRow(userId, lessonId) {
  const row = getDb().prepare('SELECT * FROM lessons WHERE id = ? AND user_id = ?').get(lessonId, userId);
  if (!row) throw fail(404, 'LESSON_NOT_FOUND', '课程不存在');
  return row;
}

/** 生成讲稿（纯文本，口语化，供 TTS 朗读） */
export async function generateLessonScript(userId, lessonId) {
  const db = getDb();
  const row = getLessonRow(userId, lessonId);
  if (row.script) return lessonRowToJson(row);

  const planRow = db.prepare('SELECT * FROM plans WHERE id = ?').get(row.plan_id);
  const plan = planRowToJson(planRow);
  const objectives = JSON.parse(row.objectives_json || '[]');
  const { text, mode } = await complete('lesson-script', {
    subject: plan.subject,
    level: plan.level,
    title: row.title,
    objectives,
    keyPoints: objectives,
    minutes: plan.minutes_per_session,
    memoryText: buildMemoryText(userId),
  });
  const script = text.trim();
  db.prepare("UPDATE lessons SET script = ?, duration_sec = ?, status = 'script_ready' WHERE id = ?").run(
    script,
    estimateDurationSec(script),
    lessonId,
  );
  return { ...lessonRowToJson(db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId)), llmMode: mode };
}

/** 把讲稿合成为音频；合成失败时保留讲稿，前端可退回文本/系统朗读 */
export async function generateLessonAudio(userId, lessonId) {
  const db = getDb();
  const withScript = await generateLessonScript(userId, lessonId);
  const row = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
  if (row.audio_file) return { ...lessonRowToJson(row), audioAvailable: true };

  const out = await synthesize(row.script || withScript.script, { key: `lesson-${lessonId}` });
  const status = out.audioFile ? 'ready' : 'text_only';
  db.prepare('UPDATE lessons SET audio_file = ?, duration_sec = ?, status = ? WHERE id = ?').run(
    out.audioFile,
    out.durationSec || estimateDurationSec(row.script || ''),
    status,
    lessonId,
  );
  const updated = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
  return {
    ...lessonRowToJson(updated),
    audioAvailable: Boolean(out.audioFile),
    ttsError: out.error,
    ttsProvider: out.provider,
  };
}
