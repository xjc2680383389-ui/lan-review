// media.js —— 文件类型、哈希、快照拷贝、路径安全
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8', '.ass': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.psd': 'image/vnd.adobe.photoshop', '.ai': 'application/postscript',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.html', '.srt', '.ass', '.log', '.yml', '.yaml', '.js', '.ts', '.py', '.css', '.bat', '.sh', '.ini', '.toml']);

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}
export function mimeOf(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}
// 预览分类：image/video/audio/pdf/text 可内嵌预览；其余给信息卡 + 下载
export function kindOf(name) {
  const e = extOf(name);
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif'].includes(e)) return 'image';
  if (['.mp4', '.m4v', '.webm', '.ogv'].includes(e)) return 'video';
  if (['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac'].includes(e)) return 'audio';
  if (e === '.pdf') return 'pdf';
  if (TEXT_EXTS.has(e)) return 'text';
  if (['.mov', '.mkv', '.avi'].includes(e)) return 'video-foreign';
  return 'file';
}

// 相对路径安全化：只允许普通相对路径；非法返回 null
export function safeRel(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return null;
  let s = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (s.includes('\0') || /(^|\/)\.\.?(\/|$)/.test(s) || /^[a-zA-Z]:/.test(s)) return null;
  s = s.split('/').filter(seg => seg.length > 0 && seg !== '.' && seg !== '..').join('/');
  if (!s || s.length > 1024) return null;
  return s;
}

export async function sha256File(fp) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const st = fs.createReadStream(fp, { highWaterMark: 1024 * 1024 });
    st.on('data', d => h.update(d));
    st.on('error', reject);
    st.on('end', () => resolve(h.digest('hex')));
  });
}

// 分块拷贝并回调进度；保证事件循环不被大文件阻塞
export async function copyFileWithProgress(src, dst, onBytes) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src, { highWaterMark: 1024 * 1024 });
    const ws = fs.createWriteStream(dst);
    rs.on('data', d => { if (onBytes) onBytes(d.length); });
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
}

// 递归展开目录下的文件（跳过符号链接、隐藏目录 .xxx 由调用方决定是否传入）
export async function walkFiles(rootDir, rel = '', out = []) {
  const abs = rel ? path.join(rootDir, rel) : rootDir;
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  for (const ent of entries) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      await walkFiles(rootDir, r, out);
    } else if (ent.isFile()) {
      out.push(r);
    }
  }
  return out;
}

export function humanSize(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}
export function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}
export function sixDigitCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
