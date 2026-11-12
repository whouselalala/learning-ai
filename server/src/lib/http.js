import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

export const fail = (status, code, message, extra) => new HttpError(status, code, message, extra);

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(text);
}

/** 读取并解析 JSON 请求体，默认上限 1MB */
export function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'BODY_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 读取原始请求体（支付回调必须用原文验签，不能先 JSON.parse 再序列化） */
export function readRaw(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'BODY_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 极简路由：支持 /api/plans/:id/lessons 这类占位符 */
export function createRouter() {
  const routes = [];

  function compile(pattern) {
    const keys = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { regex: new RegExp(`^${source}/?$`), keys };
  }

  function add(method, pattern, handler) {
    const { regex, keys } = compile(pattern);
    routes.push({ method, regex, keys, handler });
  }

  const router = {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    /** 返回 true 表示已处理 */
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      let pathMatched = false;
      for (const route of routes) {
        const m = route.regex.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (route.method !== req.method) continue;
        const params = {};
        route.keys.forEach((k, i) => (params[k] = m[i + 1]));
        await route.handler(req, res, params, url.searchParams);
        return true;
      }
      if (pathMatched) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '方法不允许');
      return false;
    },
    routes,
  };
  return router;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 静态文件（带路径穿越防护）。返回 false 表示文件不存在 */
export function serveStatic(req, res, rootDir, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const target = path.resolve(rootDir, rel);
  const root = path.resolve(rootDir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new HttpError(403, 'FORBIDDEN', '路径非法');
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return false;
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'public, max-age=300',
  });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(target).pipe(res);
  return true;
}
