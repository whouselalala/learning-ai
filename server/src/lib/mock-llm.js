/**
 * 离线 Mock 模型：没有配置 DEEPSEEK_API_KEY 时，用规则模拟模型输出。
 * 目的：本地能完整跑通「画像 → 方案 → 音频课 → 计费 → 佣金」全链路，
 * 也让自动化测试不依赖外网。上线接真实 DeepSeek 后本文件不会被执行。
 */

const BANK = {
  数学: [
    '集合与常用逻辑用语',
    '函数的概念与表示',
    '函数的单调性与最值',
    '指数函数与对数函数',
    '三角函数与解三角形',
    '平面向量',
    '数列的通项与求和',
    '立体几何中的空间想象',
    '解析几何：直线与圆',
    '导数与函数综合',
    '概率与统计初步',
  ],
  英语: [
    '高频词汇与词块记忆',
    '时态与语态的准确使用',
    '非谓语动词',
    '定语从句与名词性从句',
    '听力场景词与预判',
    '阅读理解定位与同义替换',
    '七选五的语篇逻辑',
    '应用文写作模板',
    '读后续写的情节推进',
  ],
  语文: [
    '文言实词与虚词',
    '文言文翻译的采分点',
    '古诗鉴赏的表达技巧',
    '论述类文本阅读',
    '文学类文本阅读',
    '语言文字运用',
    '材料作文的立意',
    '议论文的结构与论证',
  ],
  物理: ['运动学图像', '牛顿运动定律', '功与能', '动量守恒', '电场与电势', '电路分析', '磁场与安培力', '电磁感应', '实验设计与误差分析'],
  化学: ['物质的量与计算', '离子反应', '氧化还原反应', '元素周期律', '化学平衡', '电化学基础', '有机物的官能团', '化学实验基础'],
  生物: ['细胞的结构与功能', '酶与ATP', '光合作用与呼吸作用', '遗传的基本规律', '基因的表达', '内环境与稳态', '生态系统与能量流动'],
  历史: ['时空观念与阶段特征', '中国古代政治制度', '近代中国的救亡图存', '新中国建设与改革', '世界近代化进程', '史料实证与历史解释'],
  地理: ['地图与等值线', '大气运动与气候', '水循环与洋流', '地貌与地质作用', '人口与城市', '农业与工业区位', '区域可持续发展'],
  政治: ['价格与消费', '生产与经营', '收入与分配', '社会主义市场经济', '民主政治建设', '文化传承与创新', '唯物辩证法'],
  学习方法: ['学习诊断与目标拆解', '专注力与时间块管理', '笔记与费曼复述', '错题归因', '间隔复习与自测', '考前状态管理'],
};

const SUBJECT_WORDS = Object.keys(BANK);

function detectSubject(text = '') {
  const hit = SUBJECT_WORDS.filter((s) => s !== '学习方法').find((s) => text.includes(s));
  if (hit) return hit;
  if (/英语|单词|听力|阅读|写作|雅思|托福|四级|六级/.test(text)) return '英语';
  if (/数学|函数|几何|代数|计算/.test(text)) return '数学';
  if (/语文|作文|文言文|古诗/.test(text)) return '语文';
  return '学习方法';
}

function detectLevel(text = '') {
  const m = text.match(/(小学[一二三四五六]?|初[一二三]|高[一二三]|[一二三四五六]年级)/);
  if (m) return m[1];
  if (/考研|雅思|托福|成人/.test(text)) return '成人/考试';
  return '未说明';
}

function detectGoal(text = '') {
  const m = text.match(/(高考|中考|期末|期中|月考|竞赛|雅思|托福|四六级|考研|升学|提分|补基础)/);
  return m ? m[1] : '提升成绩';
}

/** 从一段话里抽取学习画像事实（规则版，用于 Mock 模式） */
export function extractFacts(text = '') {
  const facts = [];
  const push = (kind, key, value, confidence = 0.75) => {
    if (value) facts.push({ kind, key, value, confidence });
  };

  const level = detectLevel(text);
  if (level !== '未说明') push('level', 'grade', level, 0.9);

  const subject = detectSubject(text);
  if (subject !== '学习方法') push('subject', 'focus_subject', subject, 0.7);

  const goal = text.match(/(?:目标|想要|希望|冲刺|考上|提高到|提分到)[^。！？\n]{0,20}/);
  if (goal) push('goal', 'target', goal[0].trim(), 0.8);

  const weak = text.match(/(?:薄弱|不会|听不懂|老是错|总是错|丢分|失分|跟不上|害怕|最差|扣分)[^。！？\n]{0,18}/);
  if (weak) push('weakness', 'pain_point', weak[0].trim(), 0.7);

  const strong = text.match(/(?:擅长|还不错|喜欢|优势|拿手)[^。！？\n]{0,18}/);
  if (strong) push('strength', 'advantage', strong[0].trim(), 0.65);

  const time = text.match(/(?:每天|每周|周末|晚上|早上|放学后)[^。！？\n]{0,14}/);
  if (time) push('schedule', 'study_time', time[0].trim(), 0.7);

  const pace = text.match(/(半小时|一小时|\d+\s*分钟|\d+\s*小时)/);
  if (pace) push('pace', 'session_length', `单次可投入约 ${pace[1]}`, 0.6);

  if (/听|音频|耳朵|路上|通勤/.test(text)) push('preference', 'channel', '偏好音频/听讲式学习', 0.8);
  if (/例题|刷题|练习/.test(text)) push('preference', 'practice', '喜欢通过例题和练习巩固', 0.7);
  if (/计划|规划|安排/.test(text)) push('motivation', 'need', '希望有人帮他把计划排清楚', 0.6);

  const exam = text.match(/(\d{1,2})\s*(?:天|周|个月)\s*后?[^。！？\n]{0,8}(?:考试|高考|中考|期末)/);
  if (exam) push('constraint', 'deadline', exam[0].trim(), 0.75);

  if (/家长|妈妈|爸爸/.test(text)) push('motivation', 'stakeholder', '家长参与监督与付费决策', 0.6);

  return facts.slice(0, 6);
}

function phases(weeks) {
  const list = [];
  for (let i = 0; i < weeks; i += 1) {
    const r = weeks === 1 ? 0.5 : i / (weeks - 1);
    if (r <= 0.25) list.push({ focus: '诊断与基础补齐', deliverable: '一份个人薄弱点清单 + 基础概念通关' });
    else if (r <= 0.55) list.push({ focus: '核心专题突破', deliverable: '3 个高频专题的解题模板' });
    else if (r <= 0.8) list.push({ focus: '真题训练与错题闭环', deliverable: '两套真题限时训练 + 错题归因表' });
    else list.push({ focus: '综合模拟与状态调整', deliverable: '一次全真模拟 + 考前节奏方案' });
  }
  return list;
}

function buildPlan(ctx = {}) {
  const text = `${ctx.goal || ''} ${ctx.text || ''} ${ctx.memoryText || ''}`;
  const subject = ctx.subject || detectSubject(text);
  const level = ctx.level || detectLevel(text);
  const weeks = Number(ctx.weeks) || 4;
  const sessionsPerWeek = Number(ctx.sessionsPerWeek) || 3;
  const minutesPerSession = Number(ctx.minutesPerSession) || 20;
  const bank = BANK[subject] || BANK['学习方法'];
  const goal = ctx.goal || detectGoal(text);

  const milestones = phases(weeks).map((p, i) => ({
    week: i + 1,
    focus: p.focus,
    deliverable: p.deliverable,
    topics: [bank[(i * 2) % bank.length], bank[(i * 2 + 1) % bank.length]],
    targetMinutes: sessionsPerWeek * minutesPerSession,
  }));

  return {
    title: `${level === '未说明' ? '' : level}${subject}·${weeks} 周个性化提升方案`,
    subject,
    level,
    goal,
    weeks,
    sessionsPerWeek,
    minutesPerSession,
    milestones,
    notes: `方案按「${sessionsPerWeek} 次/周，每次 ${minutesPerSession} 分钟音频课」设计；每次课后有 3 分钟口述复述任务，把输入变成输出。`,
  };
}

function buildWeekLessons(ctx = {}) {
  const subject = ctx.subject || '学习方法';
  const bank = BANK[subject] || BANK['学习方法'];
  const count = Number(ctx.count) || 3;
  const week = Number(ctx.week) || 1;
  const focus = ctx.focus || '专题突破';
  const lessons = [];
  for (let i = 0; i < count; i += 1) {
    const topic = (ctx.topics && ctx.topics[i]) || bank[(week * 2 + i) % bank.length];
    lessons.push({
      title: `第 ${week} 周 · ${topic}`,
      objectives: [
        `能用一句话说清「${topic}」的核心结论`,
        `独立完成 2 道「${topic}」的典型题`,
        `说出自己最容易错的那一步并给出检查方法`,
      ],
      keyPoints: [
        `${topic}的适用场景与判断信号`,
        `标准解题/学习路径（三步）`,
        `最常见的两个错误与自查方式`,
      ],
      minutes: 15,
    });
  }
  return { week, focus, lessons };
}

function buildLessonScript(ctx = {}) {
  const title = ctx.title || '本课主题';
  const subject = ctx.subject || '学习';
  const objectives = ctx.objectives || ['听懂核心结论', '会做典型题', '知道易错点'];
  const points = ctx.keyPoints || ['核心概念', '标准步骤', '常见错误'];
  const minutes = ctx.minutes || 15;

  return [
    `你好，我是你的学习教练小习。欢迎来到这一节${subject}音频课，我们今天要啃下来的是：${title}。整节课大概 ${minutes} 分钟，你不需要记笔记，只要跟着我的问题在脑子里过一遍就行。学完你会得到一个可以直接用在下次作业里的小工具。`,
    `先说这节课的三个目标。第一，${objectives[0]}。第二，${objectives[1]}。第三，${objectives[2]}。如果你现在觉得有点抽象，没关系，我马上用一个具体例子把它落地。`,
    `我们先看第一个关键点：${points[0]}。你可以把它想象成一把钥匙——遇到某类问题时，它能帮你判断该不该用这个方法。判断的信号通常有三个，我一个个说：题目里出现了什么条件、要求你求什么、以及数据的形式长什么样。这三个信号凑齐两个，你就可以放心地用。`,
    `接着是第二个关键点：${points[1]}。标准路径只有三步。第一步，把已知条件翻译成你熟悉的表达，别急着算，先在草稿上写下来。第二步，选出主方法，写下第一步要做什么，而不是想着一步到位。第三步，做完之后回头看一句：我的答案有没有回到题目问的东西上。就这三步，慢一点，但不会错。`,
    `第三个关键点，也是最容易丢分的地方：${points[2]}。同学们常犯的错误有两个。一个是在条件还没看清的时候就开始套公式，另一个是算出结果就停笔，忘了检查单位和取值范围。这两个错误，本质上都是把「快」当成了「会」。`,
    `我们来做一个小练习。听到这里，请你暂停三秒，用一句话说出这节课的核心结论。……想好了吗？我的版本是这样的：先认信号，再走三步，最后做一次回到题目的检查。你如果说得比我还短，说明你真的懂了。`,
    `最后是课后作业，只有三分钟：把今天这道例题，用你自己的话讲给一个完全不懂的同学听；讲不下去的地方，就是你需要回听的那一段。明天上课前，我会问你一个问题，用来检查我们这节课有没有真的长在你身上。我们下节课见。`,
  ].join('\n\n');
}

function buildChat(ctx = {}) {
  const text = ctx.text || '';
  const subject = detectSubject(text);
  const memoryText = ctx.memoryText || '';
  const hasMemory = memoryText.trim().length > 0;
  const openers = [
    '先别急着刷题，我们把问题拆小一点。',
    '你能主动说出来，这一步就已经比很多人强了。',
    '这个状态我见过很多次，不是能力问题，是节奏问题。',
  ];
  const opener = openers[text.length % openers.length];

  return [
    opener,
    hasMemory
      ? `结合我之前记下的情况（${memoryText.slice(0, 40)}…），我建议这次不要再铺开新内容，先把「${subject}」里最拖后腿的那一块单独拎出来。`
      : `你还没细说目标年级和科目，我先把方向定在「${subject}」上，如果不是这个科目，你直接告诉我，我会改。`,
    `给你三条现在就能做的建议：第一，用三分钟把最近一次错题的原因写成一句话，只写原因不写答案；第二，把每天的学习切成 20 分钟一段，每段只做一件事，中间站起来走两分钟；第三，每段结束时合上书，用自己的话复述 30 秒，说不清就说明这段没学进去。`,
    `等你告诉我年级、目标考试和每天能投入的时间，我就把这三条排成一份按周执行的音频课表，你走路的时候听就行。`,
  ].join('\n');
}

function buildSummary(ctx = {}) {
  const texts = (ctx.texts || []).join(' ');
  const subject = detectSubject(texts);
  const goal = detectGoal(texts);
  return `前情提要：用户在${subject}上以「${goal}」为目标，讨论了自己薄弱环节与可投入时间，教练建议先缩小范围、按 20 分钟一段推进并做复述验收，后续需要给出分周音频课表。`;
}

export function mockComplete(purpose, ctx = {}) {
  switch (purpose) {
    case 'memory-extract':
      return JSON.stringify({ facts: extractFacts(ctx.text || '') });
    case 'plan':
      return JSON.stringify(buildPlan(ctx));
    case 'week-lessons':
      return JSON.stringify(buildWeekLessons(ctx));
    case 'lesson-script':
      return buildLessonScript(ctx);
    case 'chat':
      return buildChat(ctx);
    case 'summary':
      return buildSummary(ctx);
    default:
      return '（离线演示模式）';
  }
}
