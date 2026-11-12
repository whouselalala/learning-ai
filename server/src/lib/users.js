import { getDb, now } from '../db.js';
import { inviteCode, id } from './ids.js';

export function getUser(userId) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
}

export function getUserByOpenid(openid) {
  return getDb().prepare('SELECT * FROM users WHERE openid = ?').get(openid) || null;
}

export function getUserByInviteCode(code) {
  return getDb().prepare('SELECT * FROM users WHERE upper(invite_code) = upper(?)').get(code) || null;
}

function uniqueInviteCode() {
  const db = getDb();
  for (let i = 0; i < 20; i += 1) {
    const code = inviteCode();
    if (!db.prepare('SELECT 1 FROM users WHERE invite_code = ?').get(code)) return code;
  }
  return `${inviteCode()}${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

/** 登录即注册：同一个 openid 只创建一次 */
export function ensureUserByOpenid(openid, { nickname, avatar } = {}) {
  const db = getDb();
  const existed = getUserByOpenid(openid);
  if (existed) {
    db.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(now(), existed.id);
    return { user: existed, created: false };
  }
  const userId = id('u');
  const ts = now();
  db.prepare(
    `INSERT INTO users (id, openid, nickname, avatar, invite_code, referrer_id, member_since, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(userId, openid, nickname || '新同学', avatar || null, uniqueInviteCode(), ts, ts);
  return { user: getUser(userId), created: true };
}

export function updateProfile(userId, { nickname, avatar }) {
  const db = getDb();
  if (typeof nickname === 'string' && nickname.trim()) {
    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname.trim().slice(0, 24), userId);
  }
  if (typeof avatar === 'string' && avatar.trim()) {
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar.trim().slice(0, 500), userId);
  }
  return getUser(userId);
}

export function isMember(user) {
  return Boolean(user && user.member_since);
}

export function activateMembership(userId) {
  const db = getDb();
  const user = getUser(userId);
  if (!user) return null;
  if (!user.member_since) db.prepare('UPDATE users SET member_since = ? WHERE id = ?').run(now(), userId);
  return getUser(userId);
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    nickname: user.nickname,
    avatar: user.avatar,
    inviteCode: user.invite_code,
    isMember: Boolean(user.member_since),
    memberSince: user.member_since,
    hasSummary: Boolean(user.summary),
    createdAt: user.created_at,
  };
}
