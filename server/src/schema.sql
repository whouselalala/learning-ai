-- 个性化学习 AI 小程序 · 数据表（SQLite 版本，生产可平移到 PostgreSQL/MySQL）

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  openid        TEXT NOT NULL UNIQUE,
  nickname      TEXT,
  avatar        TEXT,
  invite_code   TEXT NOT NULL UNIQUE,
  referrer_id   TEXT,                          -- 我的推荐人（绑定后不可改）
  member_since  INTEGER,                       -- 成为会员的时间(ms)；NULL = 仅体验用户
  qualified_at  INTEGER,                       -- 累计消费达标、开始计入推荐的时刻；NULL = 未达标
  qualify_ordinal INTEGER,                     -- 达标后是推荐人的第几个直推（决定分佣比例）
  summary       TEXT,                          -- 长对话的滚动摘要（压缩上下文用）
  summary_upto  INTEGER NOT NULL DEFAULT 0,    -- 摘要已覆盖到的消息条数
  created_at    INTEGER NOT NULL,
  last_active_at INTEGER
);

CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,    -- goal/level/subject/weakness/strength/preference/schedule/pace/motivation/constraint
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0.6,
  hit_count    INTEGER NOT NULL DEFAULT 1,
  source       TEXT NOT NULL DEFAULT 'chat',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (user_id, kind, key)
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,        -- user / assistant
  content    TEXT NOT NULL,
  plan_id    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at);

CREATE TABLE IF NOT EXISTS plans (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  subject           TEXT,
  goal              TEXT,
  level             TEXT,
  weeks             INTEGER NOT NULL DEFAULT 4,
  sessions_per_week INTEGER NOT NULL DEFAULT 3,
  minutes_per_session INTEGER NOT NULL DEFAULT 20,
  milestones_json   TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lessons (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  week         INTEGER NOT NULL DEFAULT 1,
  title        TEXT NOT NULL,
  objectives_json TEXT NOT NULL DEFAULT '[]',
  script       TEXT,
  audio_file   TEXT,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft/ready/failed
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_plan ON lessons(plan_id, seq);

CREATE TABLE IF NOT EXISTS wallets (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cash_fen           INTEGER NOT NULL DEFAULT 0,   -- 充值余额（用于扣课时费）
  commission_fen     INTEGER NOT NULL DEFAULT 0,   -- 佣金余额（可提现）
  frozen_fen         INTEGER NOT NULL DEFAULT 0,   -- 提现处理中
  trial_seconds_used INTEGER NOT NULL DEFAULT 0,
  total_spent_fen    INTEGER NOT NULL DEFAULT 0,
  total_earned_fen   INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id        TEXT,
  started_at       INTEGER NOT NULL,
  last_beat_at     INTEGER NOT NULL,
  ended_at         INTEGER,
  server_seconds   INTEGER NOT NULL DEFAULT 0,  -- 服务端计时（防篡改）
  reported_seconds INTEGER NOT NULL DEFAULT 0,  -- 客户端上报播放时长
  billed_seconds   INTEGER NOT NULL DEFAULT 0,
  trial_seconds    INTEGER NOT NULL DEFAULT 0,
  paid_seconds     INTEGER NOT NULL DEFAULT 0,
  cost_fen         INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active' -- active/closed/insufficient
);

CREATE TABLE IF NOT EXISTS ledger (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,   -- topup/consume/trial/commission/withdraw/refund/adjust
  balance_kind     TEXT NOT NULL,   -- cash / commission / trial
  amount_fen       INTEGER NOT NULL,        -- 正数入账，负数出账
  balance_after_fen INTEGER NOT NULL,
  ref_type         TEXT,
  ref_id           TEXT,
  memo             TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commissions (
  id          TEXT PRIMARY KEY,
  earner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payer_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  TEXT,
  depth       INTEGER NOT NULL,            -- 1=直推 2=二级 3=三级 ...
  ordinal     INTEGER NOT NULL DEFAULT 0,  -- 该付费者是我第几个直推会员（cycle 模式用来定比例）
  rate_bp     INTEGER NOT NULL,            -- 万分比，2000 = 20%
  base_fen    INTEGER NOT NULL,
  amount_fen  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending/settled/reversed
  created_at  INTEGER NOT NULL,
  settled_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_commissions_earner ON commissions(earner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions(status, created_at);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- topup / membership
  subject     TEXT,                   -- 商品描述（微信支付展示给用户）
  amount_fen  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending/paid/closed/partial_refunded/refunded
  channel     TEXT NOT NULL DEFAULT 'mock',    -- mock / wechat
  out_trade_no TEXT NOT NULL UNIQUE,           -- 商户订单号
  prepay_id   TEXT,                            -- 微信预支付 id
  transaction_id TEXT,                         -- 微信支付订单号
  paid_amount_fen INTEGER,                     -- 实付金额（回调核对）
  refunded_fen INTEGER NOT NULL DEFAULT 0,     -- 已退款
  expire_at   INTEGER,                         -- 订单过期时间
  created_at  INTEGER NOT NULL,
  paid_at     INTEGER,
  notify_at   INTEGER                          -- 最后一次成功回调时间
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);

CREATE TABLE IF NOT EXISTS refunds (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_fen    INTEGER NOT NULL,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'processing', -- processing/success/failed
  out_refund_no TEXT NOT NULL UNIQUE,
  refund_id     TEXT,                               -- 微信退款单号
  operator      TEXT,
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id, created_at);

CREATE TABLE IF NOT EXISTS withdrawals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_fen  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending/paid/rejected
  channel     TEXT NOT NULL DEFAULT 'wechat',
  created_at  INTEGER NOT NULL,
  handled_at  INTEGER
);
