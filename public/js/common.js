// common.js —— 两端共用：请求封装、格式化、图标、弹层、文件预览器

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok || !data || data.ok === false) {
    const msg = (data && data.message) || `请求失败（${res.status}）`;
    const e = new Error(msg);
    e.code = data && data.code;
    e.extra = data;
    throw e;
  }
  return data;
}

export function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtTC(ms) {
  const total = Math.floor(ms / 1000);
  const s = ms % 1000;
  const p = x => String(x).padStart(2, '0');
  return `${p(Math.floor(total / 60))}:${p(total % 60)}.${String(Math.floor(s / 100))}`;
}

// ---- 图标（内联 SVG，统一线性风格） ----
const I = {
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z',
  file: 'M6 2h8l4 4v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM14 2v5h5',
  image: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M9 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z',
  video: 'M4 5h12v14H4zM16 10l5-3v10l-5-3',
  audio: 'M4 14V10h4l5-4v12l-5-4H4zM16 9a4 4 0 0 1 0 6',
  pdf: 'M6 2h8l4 4v16H6zM14 2v5h5M9 12h6M9 16h6',
  text: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4V7zM3 7l9 4 9-4M12 11v10',
  check: 'M4 12l5 5L20 6',
  x: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 3',
  send: 'M3 11l18-8-8 18-2-8-8-2z',
  download: 'M12 3v12M6 11l6 6 6-6M4 21h16',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 3v5h-5',
  plus: 'M12 5v14M5 12h14',
  link: 'M9 15l6-6M8 12l-2 2a3.5 3.5 0 0 0 5 5l2-2M16 12l2-2a3.5 3.5 0 0 0-5-5l-2 2',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  alert: 'M12 3l10 18H2L12 3zM12 10v4M12 17.5v.5',
  phone: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM10 19h4',
  laptop: 'M4 5h16v11H4zM2 19h20',
  drive: 'M3 13h18v6H3zM5 5h14l2 8H3l2-8zM7 16.5h.01M10 16.5h.01',
  wifi: 'M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.7 16a5 5 0 0 1 6.6 0M12 19.5h.01',
  play: 'M7 4l13 8-13 8V4z',
  open: 'M14 4h6v6M20 4l-9 9M9 5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-4',
  stamp: 'M9 4h6v5a3 3 0 0 0 3 3v3H6v-3a3 3 0 0 0 3-3V4zM5 19h14',
  copy: 'M8 8h12v12H8zM8 8V4h12v12h-4',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM16 16h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  chev: 'M9 6l6 6-6 6',
};
export function icon(name, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${I[name] || I.file}"/></svg>`;
}

export const KIND_ICON = { dir: 'folder', image: 'image', video: 'video', audio: 'audio', pdf: 'pdf', text: 'text', 'video-foreign': 'video', file: 'box' };

// ---- 轻提示 ----
export function toast(msg, type = 'info', ms = 3200) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `${icon(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'alert')}<span>${esc(msg)}</span>`;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

// ---- 确认对话框（Promise<boolean>） ----
export function confirmBox({ title, body, okText = '确定', danger = false }) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <div class="modal modal-confirm" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          <button class="btn" data-a="no">取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-a="yes">${esc(okText)}</button>
        </div>
      </div>`;
    const done = v => { wrap.remove(); resolve(v); };
    wrap.addEventListener('click', e => {
      if (e.target === wrap) done(false);
      const a = e.target.closest('[data-a]');
      if (a) done(a.dataset.a === 'yes');
    });
    root.appendChild(wrap);
  });
}

// ---- 文件预览浮层（创作者 / 审核端共用骨架） ----
// cfg: { name, kind, size, src, downloadUrl, mediaMeta, buildSide(container, ctx) }
export function showViewer(cfg) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap viewer-wrap';
  const mediaHtml = buildMediaHtml(cfg);
  wrap.innerHTML = `
    <div class="viewer" role="dialog" aria-modal="true">
      <div class="viewer-head">
        <div class="viewer-title">${icon(KIND_ICON[cfg.kind] || 'file')}<span>${esc(cfg.name)}</span><span class="dim">${esc(fmtSize(cfg.size))}</span></div>
        <div class="viewer-head-actions">
          ${cfg.downloadUrl ? `<a class="btn btn-sm" href="${esc(cfg.downloadUrl)}" download="${esc(cfg.name)}">${icon('download')}下载原文件</a>` : ''}
          <button class="btn btn-sm" data-a="close">${icon('x')}关闭</button>
        </div>
      </div>
      <div class="viewer-body">
        <div class="viewer-media">${mediaHtml}</div>
        <div class="viewer-side" id="viewer-side"></div>
      </div>
    </div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', e => {
    if (e.target === wrap || e.target.closest('[data-a="close"]')) close();
  });
  root.appendChild(wrap);
  const media = wrap.querySelector('.viewer-media');
  if (cfg.buildSide) cfg.buildSide(wrap.querySelector('#viewer-side'), { wrap, media, close });
  return { wrap, close, media };
}

function buildMediaHtml(cfg) {
  const u = esc(cfg.src || '');
  switch (cfg.kind) {
    case 'image':
      return `<img class="pv-img" src="${u}" alt="${esc(cfg.name)}">`;
    case 'video':
      return `<video class="pv-video" src="${u}" controls playsinline preload="metadata"></video>`;
    case 'audio':
      return `<div class="pv-audio"><div class="pv-audio-disc">${icon('audio', 34)}</div><audio src="${u}" controls></audio></div>`;
    case 'pdf':
      return `<iframe class="pv-frame" src="${u}" title="${esc(cfg.name)}"></iframe>`;
    case 'text':
      return `<pre class="pv-text" data-src="${u}">加载中…</pre>`;
    default:
      return `<div class="pv-unsupported">
        <div class="pv-unsupported-ic">${icon('box', 40)}</div>
        <p>「${esc(cfg.name)}」这类文件无法在浏览器里直接预览</p>
        <p class="dim">类型：${esc(cfg.mime || '未知')} · 大小：${esc(fmtSize(cfg.size))}</p>
        ${cfg.downloadUrl ? `<a class="btn btn-primary" href="${esc(cfg.downloadUrl)}" download="${esc(cfg.name)}">${icon('download')}下载后查看</a>` : ''}
      </div>`;
  }
}

// 文本类文件内容加载（预览器打开后调用）
export async function hydrateTextPreviews(scope) {
  const pre = scope.querySelector('.pv-text');
  if (!pre) return;
  try {
    const res = await fetch(pre.dataset.src);
    if (!res.ok) throw new Error(`加载失败（${res.status}）`);
    let txt = await res.text();
    if (txt.length > 400_000) txt = txt.slice(0, 400_000) + '\n\n…（内容过长，已截断显示，可下载查看全文）';
    pre.textContent = txt;
  } catch (e) {
    pre.textContent = `无法加载文本内容：${e.message}`;
  }
}
