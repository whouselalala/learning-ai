import crypto from 'node:crypto';
import { config } from '../config.js';
import { fail } from './http.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(body) {
  return crypto.createHmac('sha256', config.tokenSecret).update(body).digest('base64url');
}

export function signToken(userId, ttlSec = config.tokenTtlSec) {
  const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.uid || !payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 从 Authorization: Bearer xxx 或 x-token 头取出用户 id */
export function userIdFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-token'];
  const payload = verifyToken(token);
  return payload ? payload.uid : null;
}

export function requireUser(req) {
  const uid = userIdFromRequest(req);
  if (!uid) throw fail(401, 'UNAUTHORIZED', '请先登录');
  return uid;
}

export function requireAdmin(req) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== config.adminSecret) {
    throw fail(403, 'FORBIDDEN', '需要运营密钥');
  }
}
