import { config } from '../config.js';
import { mockComplete } from './mock-llm.js';

/** 从模型输出里尽量抠出 JSON（容忍 ```json 代码块、前后废话） */
export function parseJson(text) {
  if (typeof text !== 'string') throw new Error('模型输出为空');
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new Error('模型输出不是合法 JSON');
  }
}

async function callDeepSeek({ messages, json, temperature, maxTokens }) {
  const url = `${config.deepseek.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: config.deepseek.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.deepseek.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.deepseek.timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`DeepSeek ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 返回内容为空');
  return content;
}

/* ---------------------------------------------------------------- 提示词 */

const COACH = '你是「小习」，一位耐心、具体的个性化学习教练，服务对象是中小学生及其家长。你说话口语化、句子短、给得出可执行动作，从不空喊努力。';

const MEMORY_RULES = `你是学习画像抽取器。从对话中抽取关于「这位学习者」的稳定事实，用于长期记忆。

只输出 JSON：{"facts":[{"kind":"goal","key":"exam","value":"2027 年高考数学冲 120 分","confidence":0.9}]}

约束：
- kind 只能取：goal（目标）、level（学段/年级）、subject（科目）、weakness（薄弱点）、strength（优势）、preference（学习偏好）、schedule（可用时间）、pace（单次可投入时长）、motivation（动机/决策人）、constraint（限制条件，如截止时间、预算）。
- key 用 3-20 字的稳定标识，同一件事在不同轮次必须用同一个 key，例如 "exam"、"weak_topic"、"daily_time"。
- value 用中文，写成一句可独立理解的话。
- confidence 0~1，用户明确说过的给 0.9，推断的最多 0.6。
- 只抽取本次对话中新出现或发生变化的信息；没有就返回 {"facts":[]}。
- 不要抽取手机号、身份证、住址等敏感个人信息。`;

const PLAN_RULES = `你是学习规划师。基于学习者的长期记忆与本次诉求，输出一份可执行的个性化学习方案。

只输出 JSON：
{
  "title": "方案标题",
  "subject": "主科目",
  "level": "学段年级",
  "goal": "可衡量的目标",
  "weeks": 4,
  "sessionsPerWeek": 3,
  "minutesPerSession": 20,
  "milestones": [
    {"week":1,"focus":"本阶段重点","deliverable":"可验收的产出","topics":["专题1","专题2"],"targetMinutes":60}
  ],
  "notes": "给家长/学生的一段说明"
}

要求：
- weeks 与用户诉求匹配（没说的话按 4 周），sessionsPerWeek 默认 3，minutesPerSession 为音频课单次时长，15~30。
- 每个 milestone 必须有可验收的 deliverable，不能写「认真学习」这种空话。
- topics 必须是该科目真实的高频专题。
- 方案必须利用记忆里已有的薄弱点与时间约束。`;

const LESSON_RULES = `你是音频课脚本作者。为指定的一周生成课程清单。

只输出 JSON：
{"week":1,"focus":"本周重点","lessons":[{"title":"课时标题","objectives":["目标1","目标2","目标3"],"keyPoints":["要点1","要点2","要点3"],"minutes":15}]}

要求：标题具体到知识点；objectives 每条都以「能……」开头且可检验；keyPoints 是讲解骨架。`;

const SCRIPT_RULES = `你要写一段「纯音频」课程讲稿，会被语音合成朗读给学生听。

写作要求：
- 全中文口语，第二人称，像一对一辅导，不要书面语。
- 600~900 字，按「开场引入 → 目标 → 三个关键点 → 一道小练习 → 小结与 3 分钟作业」推进。
- 不要 Markdown、不要列表符号、不要括号注释、不要表情符号。
- 数学式子要读法化，例如写「x 的平方」而不是「x²」；避免出现需要看才能理解的排版。
- 关键结论要重复一次，方便走路听的学生记住。
- 结尾必须留一个具体、3 分钟内能完成的作业。`;

const CHAT_RULES = `你在和学习者对话。要求：
- 先接住情绪/现状（一句话），再给方法，不要一上来就讲知识。
- 一次最多给 3 条可执行建议，每条都要具体到动作和时长。
- 如果记忆里缺少年级、目标、可投入时间，用提问补齐，一次只问一个最关键的问题。
- 150~260 字，纯文本，不要 Markdown，不要分点符号堆砌。
- 不要承诺提分结果，不做诊断式断言。`;

const SUMMARY_RULES = `把下面这段学习对话压缩成 150 字以内的中文提要，保留：目标、当前水平、已确认的时间安排、教练给出的关键方法、尚未解决的分歧。只输出提要本身。`;

function buildPrompt(purpose, ctx) {
  const memoryBlock = ctx.memoryText
    ? `\n\n【长期记忆（按重要度排序）】\n${ctx.memoryText}`
    : '\n\n【长期记忆】暂无，需要时用提问补齐关键信息。';
  const historyBlock = ctx.historyText ? `\n\n【最近对话】\n${ctx.historyText}` : '';

  switch (purpose) {
    case 'memory-extract':
      return {
        system: MEMORY_RULES,
        user: `【已有画像】\n${ctx.memoryText || '无'}\n\n【最近对话】\n${ctx.historyText || '无'}\n\n【本次学习者输入】\n${ctx.text}`,
        json: true,
        temperature: 0.2,
        maxTokens: 600,
      };
    case 'plan':
      return {
        system: `${PLAN_RULES}${memoryBlock}${historyBlock}`,
        user: `学习者本次诉求：${ctx.goal || ctx.text || '请根据长期记忆生成方案'}\n请生成 ${ctx.weeks || 4} 周方案。`,
        json: true,
        temperature: 0.5,
        maxTokens: 2000,
      };
    case 'week-lessons':
      return {
        system: `${LESSON_RULES}${memoryBlock}`,
        user: `科目：${ctx.subject}；学段：${ctx.level}；第 ${ctx.week} 周，本周重点：${ctx.focus}；需要 ${ctx.count} 节课。`,
        json: true,
        temperature: 0.6,
        maxTokens: 1500,
      };
    case 'lesson-script':
      return {
        system: `${SCRIPT_RULES}${memoryBlock}`,
        user: `科目：${ctx.subject}；学段：${ctx.level}；课时标题：${ctx.title}；课时长度约 ${ctx.minutes} 分钟；\n目标：${(ctx.objectives || []).join('；')}\n要点：${(ctx.keyPoints || []).join('；')}`,
        json: false,
        temperature: 0.7,
        maxTokens: 1600,
      };
    case 'chat':
      return {
        system: `${COACH}\n${CHAT_RULES}${memoryBlock}${historyBlock}`,
        user: ctx.text,
        json: false,
        temperature: 0.8,
        maxTokens: 700,
      };
    case 'summary':
      return {
        system: SUMMARY_RULES,
        user: (ctx.texts || []).join('\n'),
        json: false,
        temperature: 0.3,
        maxTokens: 400,
      };
    default:
      throw new Error(`未知的生成任务：${purpose}`);
  }
}

/**
 * 统一生成入口。没有 Key 时走离线 Mock；真实调用失败时降级 Mock 并告警。
 * @returns {Promise<{text: string, mode: 'deepseek'|'mock'|'fallback'}>}
 */
export async function complete(purpose, ctx = {}) {
  if (!config.deepseek.apiKey) {
    return { text: mockComplete(purpose, ctx), mode: 'mock' };
  }
  const prompt = buildPrompt(purpose, ctx);
  try {
    const text = await callDeepSeek({
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      json: prompt.json,
      temperature: prompt.temperature,
      maxTokens: prompt.maxTokens,
    });
    return { text, mode: 'deepseek' };
  } catch (err) {
    console.warn(`[llm] ${purpose} 调用失败，降级为离线规则：${err.message}`);
    return { text: mockComplete(purpose, ctx), mode: 'fallback' };
  }
}

/** 需要 JSON 的任务：解析失败时再要一次，仍失败则抛错 */
export async function completeJson(purpose, ctx = {}) {
  const first = await complete(purpose, ctx);
  try {
    return { data: parseJson(first.text), mode: first.mode };
  } catch {
    const retry = await complete(purpose, { ...ctx, text: `${ctx.text || ''}\n\n注意：只输出严格 JSON，不要任何解释文字。` });
    return { data: parseJson(retry.text), mode: retry.mode };
  }
}

export function llmInfo() {
  return {
    mode: config.deepseek.apiKey ? 'deepseek' : 'mock',
    model: config.deepseek.apiKey ? config.deepseek.model : 'offline-rule-engine',
  };
}
