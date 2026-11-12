import crypto from 'node:crypto';

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** 生成不含易混字符的短 id（用于业务主键） */
export function id(prefix = '', size = 12) {
  const bytes = crypto.randomBytes(size);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

/** 6 位邀请码 */
export function inviteCode() {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out.toUpperCase();
}

export function outTradeNo(prefix = 'T') {
  return `${prefix}${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
