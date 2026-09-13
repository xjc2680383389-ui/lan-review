// core.js —— HTTP 基础设施：路由、JSON 体、静态资源、Range 流式发送、SSE
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mimeOf } from './media.js';

export const PUBDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function parseUrl(req) {
  const u = new URL(req.url, 'http://x');
  return { pathname: decodeURIComponent(u.pathname), query: u.searchParams };
}

export function clientIp(req) {
  let a = req.socket.remoteAddress || '';
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1') a = '127.0.0.1';
  return a;
}
export function isLoopback(req) {
  const a = clientIp(req);
  return a === '127.0.0.1' || a === 'localhost';
}
export function isHttps(req) {
  return !!(req.socket && req.socket.encrypted);
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
export const ok = (res, obj = {}) => sendJson(res, 200, { ok: true, ...obj });
export const fail = (res, status, code, message) => sendJson(res, status, { ok: false, code, message });

export function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

// 静态资源（public/ 下），带简单缓存头
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
export async function serveStatic(res, relPath) {
  const fp = path.normalize(path.join(PUBDIR, relPath));
  if (!fp.startsWith(PUBDIR)) { res.writeHead(403); res.end(); return; }
  let data;
  try { data = await fsp.readFile(fp); } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(fp)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

// 把工作区里的文件流式发给浏览器，支持 Range（视频拖动进度条必需）
export function sendVersionFile(req, res, absPath, { downloadName = null, mime = null } = {}) {
  let st;
  try { st = fs.statSync(absPath); } catch {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: '文件不存在' }));
    return;
  }
  const headers = {
    'Content-Type': mime || mimeOf(absPath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (downloadName) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end = m[2] === '' ? null : parseInt(m[2], 10);
      if (start === null && end !== null) { start = Math.max(0, st.size - end); end = st.size - 1; }
      if (start === null) start = 0;
      if (end === null || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(absPath, { start, end }).pipe(res);
      return;
    }
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(absPath).pipe(res);
}

// ---- SSE 中心 ----
export class SSEHub {
  constructor() { this.clients = new Map(); this.nextId = 1; }
  add(res, kind, deviceId = null) {
    const id = this.nextId++;
    this.clients.set(id, { res, kind, deviceId });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':connected\n\n');
    return id;
  }
  remove(id) { this.clients.delete(id); }
  // to: 'creator' | 'device:<deviceId>' | '*'
  send(to, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients.values()) {
      let hit = false;
      if (to === '*') hit = true;
      else if (to === 'creator') hit = c.kind === 'creator';
      else if (to.startsWith('device:')) hit = c.kind === 'device' && c.deviceId === to.slice(7);
      if (hit) { try { c.res.write(payload); } catch { /* 连接断开由 close 处理 */ } }
    }
  }
  hasDevice(deviceId) {
    for (const c of this.clients.values()) if (c.kind === 'device' && c.deviceId === deviceId) return true;
    return false;
  }
  startHeartbeat() {
    this._timer = setInterval(() => {
      for (const c of this.clients.values()) { try { c.res.write(':hb\n\n'); } catch { /* ignore */ } }
    }, 15000);
    this._timer.unref?.();
  }
}
