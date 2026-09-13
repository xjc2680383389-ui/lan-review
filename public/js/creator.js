// creator.js —— 创作者页面主逻辑
import { api, esc, fmtSize, fmtTime, icon, KIND_ICON, toast, confirmBox, showViewer, hydrateTextPreviews, fmtTC } from './common.js';

const S = {
  st: null,                 // /api/c/state 结果
  selProject: null,         // 当前选中项目 id
  openDirs: new Set(['']),  // 文件树展开的目录
  treeCache: {},            // rel -> entries（当前项目）
  checked: new Set(),       // 已选文件 rel
  note: '',
  reviewers: new Set(),     // 勾选的审核设备
  openVersions: new Set(),  // 展开详情的版本 id
};
const $ = sel => document.querySelector(sel);
const app = $('#app');

let refreshTimer = null;
function scheduleRefresh(ms = 250) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

async function refresh() {
  try {
    S.st = await api('/api/c/state');
    if (S.selProject && !S.st.projects.some(p => p.id === S.selProject)) S.selProject = null;
    if (!S.selProject && S.st.projects.length) S.selProject = S.st.projects[S.st.projects.length - 1].id;
    render();
  } catch (e) {
    $('#server-info').innerHTML = `<span class="badge badge-err">本机服务连接失败：${esc(e.message)}</span>`;
  }
}

function proj() { return S.st?.projects.find(p => p.id === S.selProject) || null; }
function reviewDevices() { return S.st?.devices.filter(d => d.role === 'reviewer') || []; }
function receiverDevices() { return S.st?.devices.filter(d => d.role === 'receiver') || []; }

// ================= 渲染 =================
function render() {
  const st = S.st;
  if (!st) return;
  $('#server-info').innerHTML = `
    <span><span class="dot ${st.devices.some(d => d.online) ? 'on' : ''}"></span> ${st.devices.filter(d => d.online).length} 台设备在线</span>
    <span class="dim">HTTP ${st.server.httpPort} · HTTPS ${st.server.httpsPort}</span>`;
  if (st.firstRun) {
    if (!S.onFirstRunView) renderFirstRun(false); // 避免轮询把正在浏览的目录选择器重置
    return;
  }
  renderMain();
}

function renderFirstRun(dismissable) {
  S.onFirstRunView = true;
  app.innerHTML = `
  <div class="firstrun">
    <div class="card card-pad">
      <h1>欢迎使用提审台</h1>
      <p class="lead">先选一个文件夹作为「工作区」——以后所有项目都会保存在这里，手机和笔记本也从这里读取要审核的文件。</p>
      <div id="ws-pick"></div>
      <div style="display:flex;gap:10px;margin-top:14px;justify-content:flex-end">
        ${dismissable ? '<button class="btn" id="ws-cancel">取消</button>' : ''}
        <button class="btn btn-primary" id="ws-use">${icon('check')}使用此文件夹</button>
      </div>
    </div>
  </div>`;
  bindWorkspacePicker($('#ws-pick'), '');
  if (dismissable) $('#ws-cancel').onclick = () => { render(); };
  $('#ws-use').onclick = async () => {
    const path = pickerPath;
    if (!path) { toast('请先在上方选择一个文件夹', 'err'); return; }
    try {
      await api('/api/c/workspace', { method: 'POST', body: { path } });
      toast(`工作区已设置：${path}`, 'ok');
      S.selProject = null; S.checked.clear(); S.openDirs = new Set(['']); S.treeCache = {};
      await refresh();
    } catch (e) { toast(e.message, 'err'); }
  };
}

let pickerPath = '';
async function bindWorkspacePicker(box, startPath) {
  box.innerHTML = `<div class="dir-browser"><div class="dir-crumb" id="dc">读取中…</div><div class="dir-list" id="dl"></div></div>
    <div style="display:flex;gap:10px;margin-top:10px;align-items:center">
      <input class="input" id="mkdir-name" placeholder="新建文件夹的名称" style="flex:1">
      <button class="btn" id="mkdir-btn">${icon('plus')}新建文件夹</button>
    </div>`;
  const load = async p => {
    try {
      const r = await api(`/api/c/fs?path=${encodeURIComponent(p)}`);
      pickerPath = r.path || '';
      const crumb = $('#dc', box);
      const dl = $('#dl', box);
      crumb.innerHTML = `<b class="mono">${esc(r.path || '此电脑')}</b>
        ${r.parent !== null && r.parent !== undefined ? `<button class="btn btn-sm" data-up>上一级</button>` : ''}`;
      const upBtn = crumb.querySelector('[data-up]');
      if (upBtn) upBtn.onclick = () => load(r.parent);
      dl.innerHTML = r.entries.length === 0
        ? `<div class="dir-row dim">这里没有子文件夹了，可以直接点下方「使用此文件夹」</div>`
        : r.entries.map(e => `<div class="dir-row" data-p="${esc(e.path)}">${icon('folder')}<span>${esc(e.name)}</span></div>`).join('');
      dl.querySelectorAll('.dir-row[data-p]').forEach(row => {
        row.onclick = () => load(row.dataset.p);
      });
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  box.querySelector('#mkdir-btn').onclick = async () => {
    const name = box.querySelector('#mkdir-name').value.trim().replace(/[\\/]/g, '-');
    if (!name) { toast('请输入文件夹名称', 'err'); return; }
    if (!pickerPath) { toast('请先进入一个磁盘位置', 'err'); return; }
    const sep = pickerPath.includes('\\') ? '\\' : '/';
    const path = pickerPath.replace(/[\\/]+$/, '') + sep + name;
    try {
      await api('/api/c/fs/mkdir', { method: 'POST', body: { path } });
      toast('已创建文件夹', 'ok');
      load(pickerPath);
    } catch (e) { toast(e.message, 'err'); }
  };
  await load(startPath);
}

function renderMain() {
  S.onFirstRunView = false;
  const st = S.st;
  app.innerHTML = `
  <div class="page">
    <div class="card card-pad" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      ${icon('drive')} <b>工作区</b>
      <span class="mono dim ellip" style="max-width:46vw">${esc(st.workspace)}</span>
      <span class="spacer" style="flex:1"></span>
      <button class="btn btn-sm" id="ws-open">${icon('open')}打开文件夹</button>
      <button class="btn btn-sm" id="ws-change">${icon('refresh')}更换工作区</button>
    </div>

    <div class="layout">
      <div>
        <section class="section">
          <div class="section-head"><span class="no">1</span><h2>项目</h2><span class="sub">一个项目对应工作区里的一个文件夹</span><span class="spacer"></span>
            <button class="btn btn-sm" id="prj-new">${icon('plus')}新建项目</button></div>
          <div id="prj-list" class="card"></div>
        </section>

        <section class="section" id="sec-submit"></section>
        <section class="section" id="sec-versions"></section>
        <section class="section" id="sec-deliveries"></section>
      </div>
      <div class="aside" style="position:sticky;top:64px">
        <section class="section" style="margin-top:0">
          <div class="section-head"><h2>设备连接</h2><span class="sub">手机 / 笔记本扫码或输码</span></div>
          <div id="pair-panel" class="card card-pad"></div>
        </section>
        <section class="section">
          <div class="section-head"><h2>已连接设备</h2></div>
          <div id="dev-list" class="card card-pad"></div>
        </section>
      </div>
    </div>
  </div>`;

  $('#ws-open').onclick = async () => { try { await api('/api/c/workspace/open', { method: 'POST' }); } catch (e) { toast(e.message, 'err'); } };
  $('#ws-change').onclick = async () => {
    const go = await confirmBox({
      title: '更换工作区？',
      body: '<p>不同工作区的项目、设备授权和审核记录相互独立。切换后本页将显示新工作区的内容。</p>',
      okText: '去选择',
    });
    if (go) renderFirstRun(true);
  };
  $('#prj-new').onclick = () => projectDialog();
  renderProjects();
  renderSubmitSection();
  renderVersions();
  renderDeliveries();
  renderPairPanel();
  renderDeviceList();
}

// ---------- 项目 ----------
function renderProjects() {
  const box = $('#prj-list');
  const list = S.st.projects;
  if (!list.length) {
    box.innerHTML = `<div class="empty"><div class="empty-ic">${icon('folder', 26)}</div>
      <h3>还没有项目</h3><p>项目就是工作区里的一个工作文件夹，按「日期_品牌_项目名」创建</p>
      <button class="btn btn-primary" id="prj-new2">${icon('plus')}新建第一个项目</button></div>`;
    box.querySelector('#prj-new2').onclick = () => projectDialog();
    return;
  }
  box.innerHTML = list.map(p => {
    const cur = p.versions.find(v => v.id === p.currentVersionId);
    const sel = p.id === S.selProject;
    return `<div class="rowitem clickable" data-id="${p.id}" style="${sel ? 'background:var(--brand-soft)' : ''}">
      <span style="color:var(--brand)">${icon('folder')}</span>
      <div class="grow">
        <div class="ellip"><b>${esc(p.name)}</b> ${p.brand ? `<span class="dim">${esc(p.brand)}</span>` : ''} ${cur ? `<span class="badge ${cur.approvable ? 'badge-ok' : 'badge-dim'}">${cur.num}</span>` : '<span class="badge badge-dim">未提审</span>'}</div>
        <div class="dim ellip" style="font-size:12px">${esc(p.folder)}</div>
      </div>
      <button class="btn btn-sm" data-open="${p.id}">${icon('open')}打开</button>
    </div>`;
  }).join('');
  box.querySelectorAll('.rowitem').forEach(r => {
    r.onclick = e => {
      if (e.target.closest('[data-open]')) return;
      S.selProject = r.dataset.id;
      S.checked.clear(); S.openDirs = new Set(['']); S.treeCache = {}; S.note = ''; S.reviewers.clear();
      renderProjects(); renderSubmitSection(); renderVersions();
    };
  });
  box.querySelectorAll('[data-open]').forEach(b => {
    b.onclick = async () => {
      try { await api('/api/c/project/open', { method: 'POST', body: { id: b.dataset.open } }); } catch (e) { toast(e.message, 'err'); }
    };
  });
}

function projectDialog() {
  const today = new Date();
  const p2 = x => String(x).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`;
  const root = $('#modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal">
    <h3>新建项目</h3>
    <p class="dim" style="margin:0 0 12px;font-size:13px">将在工作区创建文件夹：<b class="mono" id="prj-preview"></b></p>
    <label class="field"><span>日期</span><input class="input" id="f-date" value="${todayStr}" placeholder="2026-09-13"></label>
    <label class="field"><span>品牌（可选）</span><input class="input" id="f-brand" placeholder="例如：山雾咖啡"></label>
    <label class="field"><span>项目名称</span><input class="input" id="f-name" placeholder="例如：秋季新品视频"></label>
    <div id="prj-err"></div>
    <div class="modal-actions">
      <button class="btn" data-a="cancel">取消</button>
      <button class="btn btn-primary" data-a="create">创建项目</button>
    </div>
  </div>`;
  const close = () => wrap.remove();
  const preview = () => {
    const d = $('#f-date', wrap).value.trim(), b = $('#f-brand', wrap).value.trim(), n = $('#f-name', wrap).value.trim();
    $('#prj-preview', wrap).textContent = [d, b, n].filter(Boolean).join('_') || '…';
  };
  wrap.addEventListener('input', preview);
  const submit = async useExisting => {
    const body = {
      date: $('#f-date', wrap).value.trim(),
      brand: $('#f-brand', wrap).value.trim(),
      name: $('#f-name', wrap).value.trim(),
      useExisting,
    };
    try {
      const r = await api('/api/c/project', { method: 'POST', body });
      close();
      toast(`项目已创建：${r.project.name}`, 'ok');
      S.selProject = r.project.id;
      S.checked.clear(); S.openDirs = new Set(['']); S.treeCache = {};
      await refresh();
    } catch (e) {
      const errBox = wrap.querySelector('#prj-err');
      if (e.code === 'folder_exists') {
        errBox.innerHTML = `<div class="notice" style="margin-bottom:10px">${icon('alert')}<div>工作区里已有同名文件夹。要用它继续工作（保留里面已有文件），还是新建一个带编号的文件夹？</div></div>
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button class="btn" id="mk-suffix">新建「_2」文件夹</button>
            <button class="btn btn-primary" id="mk-use">使用现有文件夹</button>
          </div>`;
        errBox.querySelector('#mk-use').onclick = () => submit(true);
        errBox.querySelector('#mk-suffix').onclick = async () => {
          // 自动寻找可用后缀
          const n0 = $('#f-name', wrap).value.trim();
          for (let i = 2; i < 50; i++) {
            $('#f-name', wrap).value = `${n0}_${i}`;
            try { return await submit(false); } catch (x) { if (x.code !== 'folder_exists') { toast(x.message, 'err'); return; } }
          }
        };
      } else {
        errBox.innerHTML = `<div class="notice err">${icon('alert')}${esc(e.message)}</div>`;
      }
    }
  };
  wrap.addEventListener('click', e => {
    if (e.target === wrap || e.target.closest('[data-a="cancel"]')) close();
    if (e.target.closest('[data-a="create"]')) submit(false);
  });
  root.appendChild(wrap);
  preview();
}

// ---------- 选文件 + 提交 ----------
function renderSubmitSection() {
  const box = $('#sec-submit');
  const p = proj();
  if (!p) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="section-head"><span class="no">2</span><h2>选择待审文件</h2><span class="sub">来自「${esc(p.name)}」文件夹</span></div>
    <div class="card card-pad">
      <div class="tree" id="file-tree"></div>
      <div id="sel-panel" style="margin-top:12px"></div>
    </div>`;
  renderTree();
  renderSelPanel();
}

async function renderTree() {
  const p = proj();
  const treeEl = $('#file-tree');
  if (!treeEl) return;
  const rows = [];
  const build = (rel, depth) => {
    const entries = S.treeCache[rel];
    for (const en of entries || []) {
      const isOpen = S.openDirs.has(en.rel);
      rows.push(`<div class="tree-row ${S.checked.has(en.rel) ? 'sel' : ''}" data-rel="${esc(en.rel)}" data-type="${en.type}" style="padding-left:${10 + depth * 18}px">
        <span class="tw">${en.type === 'dir' ? (isOpen ? '▾' : '▸') : ''}</span>
        <span class="tic">${icon(en.type === 'dir' ? 'folder' : (KIND_ICON[en.kind] || 'file'), 15)}</span>
        <span class="nm">${esc(en.name)}</span>
        <span class="sz mono">${en.type === 'file' ? fmtSize(en.size) : ''}</span>
      </div>`);
      if (en.type === 'dir' && isOpen) build(en.rel, depth + 1);
    }
  };
  const rootReady = !!S.treeCache[''];
  if (!rootReady) {
    treeEl.innerHTML = '<div class="empty" style="padding:18px"><span class="dim">正在读取项目文件夹…</span></div>';
    try { await ensureDirLoaded(''); } catch (e) { treeEl.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  }
  build('', 0);
  if (rows.length === 0) {
    treeEl.innerHTML = `<div class="empty" style="padding:18px"><h3>项目文件夹是空的</h3><p>点上方「打开」把文件放进项目文件夹，然后回来刷新</p><button class="btn" id="tree-reload">${icon('refresh')}重新读取</button></div>`;
    treeEl.querySelector('#tree-reload').onclick = () => { S.treeCache = {}; renderTree(); };
    return;
  }
  treeEl.innerHTML = rows.join('');
  treeEl.querySelectorAll('.tree-row').forEach(row => {
    row.onclick = async () => {
      const rel = row.dataset.rel, type = row.dataset.type;
      if (type === 'dir') {
        if (S.openDirs.has(rel)) S.openDirs.delete(rel);
        else { S.openDirs.add(rel); await ensureDirLoaded(rel); }
        renderTree();
      } else {
        if (S.checked.has(rel)) S.checked.delete(rel); else S.checked.add(rel);
        renderTree(); renderSelPanel();
      }
    };
  });
}

async function ensureDirLoaded(rel) {
  if (S.treeCache[rel]) return;
  const p = proj();
  const r = await api(`/api/c/project-tree?projectId=${p.id}&dir=${encodeURIComponent(rel)}`);
  S.treeCache[rel] = r.entries;
}

function renderSelPanel() {
  const box = $('#sel-panel');
  if (!box) return;
  const p = proj();
  const files = [...S.checked];
  const sizes = files.map(rel => {
    for (const en of Object.values(S.treeCache).flat()) if (en.rel === rel) return en.size;
    return 0;
  });
  const total = sizes.reduce((a, b) => a + b, 0);
  const devs = reviewDevices();
  box.innerHTML = `
    ${files.length === 0
      ? `<div class="dim" style="font-size:13px">在上方点选文件；点文件夹可展开后整层选用。还没有选择任何文件。</div>`
      : `<div class="notice info" style="margin-bottom:10px">${icon('check')}<div>已选 <b>${files.length}</b> 个文件，共 <b>${fmtSize(total)}</b>。提交后会生成 V${String((p?.versions.length || 0) + 1).padStart(2, '0')} 独立版本，之后修改这些文件不影响已提交的版本。</div></div>`}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <label class="field" style="margin:0"><span>版本说明（可选）</span>
        <input class="input" id="v-note" placeholder="例如：按昨天反馈调了配色" value="${esc(S.note)}"></label>
      <div class="field" style="margin:0"><span>发给哪些审核设备</span>
        <div id="rev-picks" style="display:flex;flex-wrap:wrap;gap:8px;padding-top:2px">
          ${devs.length === 0 ? '<span class="dim" style="font-size:13px">还没有审核设备，先在右侧连接手机或笔记本</span>' :
      devs.map(d => `<label class="check-row" style="background:#F6F8F6;border-radius:7px;padding:4px 10px">
            <input type="checkbox" data-dev="${d.id}" ${S.reviewers.has(d.id) ? 'checked' : ''}>${esc(d.name)}
            <span class="dot ${d.online ? 'on' : ''}" title="${d.online ? '在线' : '离线'}"></span></label>`).join('')}
        </div></div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:12px">
      <button class="btn btn-lg btn-primary" id="btn-submit" ${files.length === 0 || S.reviewers.size === 0 ? 'disabled' : ''}
        title="${files.length === 0 ? '请先选择文件' : S.reviewers.size === 0 ? '请选择至少一台审核设备' : ''}">
        ${icon('send')}提交审核（生成 V${String((p?.versions.length || 0) + 1).padStart(2, '0')}）</button>
    </div>`;
  box.querySelector('#v-note').oninput = e => { S.note = e.target.value; };
  box.querySelectorAll('[data-dev]').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) S.reviewers.add(cb.dataset.dev); else S.reviewers.delete(cb.dataset.dev);
      renderSelPanel(); renderTree();
    };
  });
  box.querySelector('#btn-submit').onclick = submitVersion;
}

async function submitVersion() {
  const p = proj();
  if (!p) return;
  try {
    const r = await api('/api/c/submit', {
      method: 'POST',
      body: { projectId: p.id, paths: [...S.checked], note: S.note, deviceIds: [...S.reviewers] },
    });
    toast(`V${r.num.slice(1)} 开始生成快照：${r.fileCount} 个文件`, 'ok');
    S.checked.clear(); S.note = ''; S.reviewers.clear();
    S.openVersions.add(r.versionId);
    renderSelPanel(); renderTree(); await refresh();
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- 版本与反馈 ----------
function stateBadge(v) {
  if (v.state === 'preparing') return `<span class="badge badge-brand">快照生成中</span>`;
  if (v.state === 'failed') return `<span class="badge badge-err">快照失败</span>`;
  if (v.approvable) return `<span class="badge badge-seal">审核通过</span>`;
  const s = v.approvalStats || { decidedDevices: 0, totalDevices: 0 };
  if (s.totalDevices === 0) return `<span class="badge badge-dim">未指派审核</span>`;
  return `<span class="badge badge-warn">${s.decidedDevices}/${s.totalDevices} 设备已全通过</span>`;
}

function renderVersions() {
  const box = $('#sec-versions');
  const p = proj();
  if (!p) { box.innerHTML = ''; return; }
  const vers = [...p.versions].reverse();
  box.innerHTML = `
    <div class="section-head"><span class="no">3</span><h2>版本与审核反馈</h2><span class="sub">每次提审都是一个不可更改的独立版本</span></div>
    <div class="card">
      ${vers.length === 0 ? `<div class="empty"><div class="empty-ic">${icon('stamp', 26)}</div><h3>还没有提交过版本</h3><p>在上方选好文件、勾选审核设备，就能提交 V01</p></div>` : vers.map(v => versionBlock(p, v)).join('')}
    </div>`;
  bindVersionBlocks(p);
}

function versionBlock(p, v) {
  const isCur = v.id === p.currentVersionId;
  const receivers = receiverDevices();
  const anyReceiverFree = receivers.some(d => d.online);
  const canDeliver = v.state === 'ready' && v.approvable;
  const open = S.openVersions.has(v.id);
  const prog = v.state === 'preparing' && v.progress ? v.progress : null;
  const pct = prog && prog.totalBytes > 0 ? Math.min(100, Math.round(prog.copiedBytes / prog.totalBytes * 100)) : 0;
  return `<div style="border-bottom:1px solid var(--line)" data-ver="${v.id}">
    <div class="card-pad" style="cursor:pointer" data-toggle="${v.id}">
      <div class="ver-head">
        <span class="ver-num">${esc(v.num)}</span>
        ${isCur ? '<span class="badge badge-brand">当前版本</span>' : '<span class="badge badge-dim">历史版本</span>'}
        ${stateBadge(v)}
        ${v.note ? `<span class="dim ellip" style="max-width:280px">${esc(v.note)}</span>` : ''}
        <span class="dim" style="font-size:12px">${fmtTime(v.createdAt)} · ${v.files.length} 个文件 · ${fmtSize(v.totalBytes)}</span>
        <span class="spacer" style="flex:1"></span>
        <span class="dim" style="font-size:12px">${open ? '收起 ▴' : '展开 ▾'}</span>
      </div>
      ${prog ? `<div style="margin-top:8px"><div class="progress"><i style="width:${pct}%"></i></div>
        <div class="dim" style="font-size:12px;margin-top:3px">${pct}% · ${esc(prog.currentFile || '准备中…')}</div></div>` : ''}
      ${v.state === 'failed' ? `<div class="notice err" style="margin-top:8px">${icon('alert')}<div>${esc(v.error || '快照失败')}。处理后再从上方重新提交即可（会生成新版本号）。</div></div>` : ''}
    </div>
    ${open ? versionDetail(p, v, canDeliver, anyReceiverFree) : ''}
  </div>`;
}

function decisionChip(my, label) {
  if (!my) return `<span class="badge badge-dim" title="${esc(label)}：未审">待审</span>`;
  return my.decision === 'approve'
    ? `<span class="badge badge-ok" title="${esc(label)}">通过</span>`
    : `<span class="badge badge-err" title="${esc(label)}">需修改</span>`;
}

function versionDetail(p, v, canDeliver, anyReceiverFree) {
  const assigned = v.assignedDevices.map(id => S.st.devices.find(d => d.id === id)).filter(Boolean);
  const cmtCount = {};
  for (const c of v.comments) cmtCount[c.path] = (cmtCount[c.path] || 0) + 1;
  const commentsByFile = {};
  for (const c of v.comments) (commentsByFile[c.path] = commentsByFile[c.path] || []).push(c);
  const commentsTotal = v.comments.length;
  return `<div class="card-pad" style="background:#FAFBFA;border-top:1px dashed var(--line)">
    ${assigned.length === 0 ? `<div class="notice" style="margin-bottom:10px">${icon('alert')}<div>这个版本提交时没有指派审核设备。</div></div>` : ''}
    <div class="table-wrap" style="overflow-x:auto">
      <table class="table">
        <thead><tr><th>文件</th><th>大小</th>
          ${assigned.map(d => `<th>${esc(d.name)}</th>`).join('')}
          <th>评论</th><th></th></tr></thead>
        <tbody>
        ${v.files.map(f => `<tr>
          <td class="ellip" style="max-width:280px" title="${esc(f.path)}">${icon(KIND_ICON[f.kind] || 'file', 14)} ${esc(f.path.split('/').pop())}<span class="dim" style="font-size:11px"> ${esc(f.path.includes('/') ? f.path.split('/').slice(0, -1).join('/') + '/' : '')}</span></td>
          <td class="mono dim">${fmtSize(f.size)}</td>
          ${assigned.map(d => `<td>${decisionChip((v.decisions[d.id] || {})[f.path], d.name)}</td>`).join('')}
          <td>${cmtCount[f.path] ? `<span class="badge badge-brand">${cmtCount[f.path]}</span>` : '<span class="dim">—</span>'}</td>
          <td><button class="btn btn-sm" data-view="${esc(f.path)}">${icon('eye')}预览</button></td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-top:10px">
      <b style="font-size:13px">评论（${commentsTotal}）</b>
      ${commentsTotal === 0 ? '<div class="dim" style="font-size:13px;margin:4px 0">还没有评论。审核设备上点开文件即可评论；视频还能在指定画面位置留言。</div>' : ''}
      <div style="margin-top:4px">
        ${v.comments.map(c => `<div class="cmt">
          <span class="who">${esc(c.deviceName)}</span>
          <span class="dim" style="font-size:11.5px">· ${fmtTime(c.at)} · ${esc(c.path.split('/').pop())}</span>
          ${c.timecodeMs != null ? ` <button class="tc-chip" data-seek="${c.timecodeMs}" data-path="${esc(c.path)}">▶ ${fmtTC(c.timecodeMs)}</button>` : ''}
          <div>${esc(c.text)}</div>
        </div>`).join('')}
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:12px;align-items:center">
      ${canDeliver
      ? (anyReceiverFree
        ? `<button class="btn btn-primary" data-deliver="${v.id}">${icon('stamp')}正式交付此版本…</button>`
        : `<span class="dim" style="font-size:12.5px">没有在线的接收电脑</span><button class="btn btn-primary" disabled>${icon('stamp')}正式交付此版本</button>`)
      : (v.state === 'ready' ? `<span class="dim" style="font-size:12.5px" title="所有指派设备对所有文件都点「通过」后才可交付">全部审核通过后才能交付</span>` : '')}
    </div>
  </div>`;
}

function bindVersionBlocks(p) {
  const box = $('#sec-versions');
  box.querySelectorAll('[data-toggle]').forEach(el => {
    el.onclick = () => {
      const id = el.dataset.toggle;
      if (S.openVersions.has(id)) S.openVersions.delete(id); else S.openVersions.add(id);
      renderVersions();
    };
  });
  box.querySelectorAll('[data-ver]').forEach(verEl => {
    const v = p.versions.find(x => x.id === verEl.dataset.ver);
    if (!v) return;
    verEl.querySelectorAll('[data-view]').forEach(b => {
      b.onclick = () => openCreatorViewer(v, b.dataset.view, 0);
    });
    verEl.querySelectorAll('[data-seek]').forEach(b => {
      b.onclick = () => openCreatorViewer(v, b.dataset.path, +b.dataset.seek);
    });
    const db = verEl.querySelector('[data-deliver]');
    if (db) db.onclick = () => deliverDialog(v);
  });
}

function openCreatorViewer(v, rel, seekMs) {
  const file = v.files.find(f => f.path === rel);
  if (!file) return;
  const src = `/api/c/file?vid=${v.id}&p=${encodeURIComponent(rel)}`;
  const viewer = showViewer({
    name: file.path.split('/').pop(), kind: file.kind, size: file.size, src,
    downloadUrl: `${src}&download=1`,
  });
  hydrateTextPreviews(viewer.wrap);
  const video = viewer.wrap.querySelector('video');
  if (video && seekMs > 0) {
    video.addEventListener('loadedmetadata', () => { video.currentTime = seekMs / 1000; }, { once: true });
  }
}

function deliverDialog(v) {
  const receivers = receiverDevices();
  const p = proj();
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal">
    <h3>正式交付 ${esc(p.name)} ${esc(v.num)}</h3>
    <p class="dim" style="font-size:13px;margin:0 0 12px">将把审核通过的 <b>${v.files.length}</b> 个文件（${fmtSize(v.totalBytes)}）原样传输到对方选定的接收文件夹。请选择一台在线的接收电脑：</p>
    ${receivers.length === 0 ? `<div class="notice">${icon('alert')}<div>还没有配对「接收电脑」。请在接收笔记本上打开右侧的安全地址（HTTPS）连接。</div></div>` : ''}
    <div>${receivers.map(d => `
      <label class="check-row" style="padding:8px 6px;border-bottom:1px solid var(--line)">
        <input type="radio" name="rcv" value="${d.id}" ${d.online ? '' : 'disabled'}>
        <span class="dev-name">${esc(d.name)}</span>
        <span class="dot ${d.online ? 'on' : ''}"></span><span class="dim" style="font-size:12px">${d.online ? '在线' : '离线'}</span>
      </label>`).join('')}</div>
    <div class="modal-actions">
      <button class="btn" data-a="cancel">取消</button>
      <button class="btn btn-primary" data-a="go">${icon('stamp')}确认交付</button>
    </div>
  </div>`;
  wrap.addEventListener('click', async e => {
    if (e.target === wrap || e.target.closest('[data-a="cancel"]')) { wrap.remove(); return; }
    if (e.target.closest('[data-a="go"]')) {
      const sel = wrap.querySelector('input[name="rcv"]:checked');
      if (!sel) { toast('请选择一台在线的接收电脑', 'err'); return; }
      try {
        await api('/api/c/deliver', { method: 'POST', body: { versionId: v.id, receiverId: sel.value } });
        toast('已发起交付，等待对方接收…', 'ok');
        wrap.remove();
        await refresh();
      } catch (err) { toast(err.message, 'err'); }
    }
  });
  $('#modal-root').appendChild(wrap);
}

// ---------- 交付记录 ----------
function deliveryStateBadge(d) {
  return {
    pending: '<span class="badge badge-brand">等待对方接收</span>',
    transferring: '<span class="badge badge-brand">传输中</span>',
    completed: '<span class="badge badge-ok">交付成功</span>',
    partial: '<span class="badge badge-warn">部分文件失败</span>',
    cancelled: '<span class="badge badge-dim">已取消</span>',
  }[d.state] || `<span class="badge badge-err">${esc(d.state)}</span>`;
}

function renderDeliveries() {
  const box = $('#sec-deliveries');
  const list = [...S.st.deliveries].reverse();
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="section-head"><span class="no">4</span><h2>交付记录</h2><span class="sub">只有审核通过的版本才能出现在这里</span></div>
    <div class="card">
      ${list.map(d => {
      const okN = d.files.filter(f => f.state === 'ok').length;
      const saved = d.savedDirName ? `保存位置：对方电脑的「${esc(d.savedDirName)}」目录下，文件夹「${esc(d.projectName)}_${esc(d.versionNum)}」` : '';
      return `<div class="card-pad" style="border-bottom:1px solid var(--line)">
        <div class="ver-head">
          ${deliveryStateBadge(d)}
          <b>${esc(d.projectName)} ${esc(d.versionNum)}</b>
          <span class="dim">→ ${esc(d.receiverName)}</span>
          <span class="dim" style="font-size:12px">${fmtTime(d.createdAt)} · ${okN}/${d.files.length} 个文件成功 · ${fmtSize(d.totalBytes)}</span>
          <span class="spacer" style="flex:1"></span>
          ${(d.state === 'pending' || d.state === 'transferring') ? `<button class="btn btn-sm btn-danger" data-cancel="${d.id}">取消交付</button>` : ''}
          ${['partial', 'cancelled', 'completed'].includes(d.state) && d.state !== 'completed' ? `<button class="btn btn-sm" data-restart="${d.id}">${icon('refresh')}重新发起</button>` : ''}
        </div>
        ${saved ? `<div class="dim" style="font-size:12.5px;margin-top:4px">${icon('drive', 13)} ${saved}</div>` : ''}
        ${d.error ? `<div class="notice err" style="margin-top:6px">${icon('alert')}<div>${esc(d.error)}</div></div>` : ''}
        ${d.state === 'transferring' || d.state === 'partial' ? `<div class="progress" style="margin-top:8px"><i style="width:${Math.round(okN / d.files.length * 100)}%"></i></div>` : ''}
      </div>`;
    }).join('')}
    </div>`;
  box.querySelectorAll('[data-cancel]').forEach(b => {
    b.onclick = async () => {
      const go = await confirmBox({ title: '取消这笔交付？', body: '<p>对方端也会收到取消提示，已传输的文件会保留在对方已接收位置。</p>', okText: '取消交付', danger: true });
      if (!go) return;
      try { await api(`/api/c/delivery/${b.dataset.cancel}/cancel`, { method: 'POST' }); await refresh(); } catch (e) { toast(e.message, 'err'); }
    };
  });
  box.querySelectorAll('[data-restart]').forEach(b => {
    b.onclick = async () => {
      try { await api(`/api/c/delivery/${b.dataset.restart}/restart`, { method: 'POST' }); toast('已重新发起交付', 'ok'); await refresh(); } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ---------- 设备连接面板 ----------
function renderPairPanel() {
  const box = $('#pair-panel');
  const st = S.st;
  const lanUrls = st.server.joinUrls.filter(u => !u.includes('localhost'));
  const mainUrl = lanUrls[0] || st.server.joinUrls[0];
  let qr = '';
  try { qr = qrcode(0, 'M'); qr.addData(mainUrl); qr.make(); } catch { /* 降级无二维码 */ }
  box.innerHTML = `
    <div class="dim" style="font-size:12.5px;margin-bottom:8px">手机 / 笔记本连上同一 Wi-Fi，浏览器扫码，或输入地址后填写这串连接码：</div>
    <div class="paircode">${esc(st.pairCode)}</div>
    ${qr ? `<div class="qrbox" title="${esc(mainUrl)}">${qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })}</div>` : ''}
    <div class="url-list" style="margin-top:10px">
      <div class="urow">${icon('phone', 13)}<a href="${esc(mainUrl)}" target="_blank">${esc(mainUrl)}</a></div>
      ${st.server.httpsAvailable ? `<div class="urow">${icon('laptop', 13)}<span class="mono" style="word-break:break-all">${esc((st.server.httpsJoinUrls.find(u => !u.includes('localhost')) || st.server.httpsJoinUrls[0] || ''))}</span></div>
      <div class="dim" style="font-size:11.5px">接收电脑请用上面 HTTPS 地址连接（首次浏览器会提示不安全，点「高级 → 继续前往」即可，这是本机自建证书的正常提示）。</div>` : '<div class="dim">HTTPS 通道不可用，正式交付功能受限</div>'}
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-sm" id="pair-regen">${icon('refresh')}更换连接码</button>
    </div>`;
  box.querySelector('#pair-regen').onclick = async () => {
    try { await api('/api/c/pair/regenerate', { method: 'POST' }); await refresh(); } catch (e) { toast(e.message, 'err'); }
  };
}

function renderDeviceList() {
  const box = $('#dev-list');
  const devs = S.st.devices;
  if (!devs.length) {
    box.innerHTML = `<div class="empty" style="padding:20px"><h3>还没有设备连接</h3><p style="font-size:12.5px">手机扫码后选「审核设备」；接收笔记本用 HTTPS 地址选「接收电脑」</p></div>`;
    return;
  }
  box.innerHTML = devs.map(d => `
    <div class="dev-item">
      <span style="color:var(--brand)">${icon(d.role === 'receiver' ? 'laptop' : 'phone')}</span>
      <div class="grow">
        <div class="dev-name ellip">${esc(d.name)} <span class="badge ${d.role === 'receiver' ? 'badge-brand' : 'badge-dim'}">${d.role === 'receiver' ? '接收' : '审核'}</span></div>
        <div class="dim" style="font-size:11.5px"><span class="dot ${d.online ? 'on' : ''}"></span> ${d.online ? '在线' : `离线 · 最后见到 ${fmtTime(d.lastSeenAt)}`}</div>
      </div>
      <button class="btn btn-sm btn-danger" data-revoke="${d.id}">取消授权</button>
    </div>`).join('');
  box.querySelectorAll('[data-revoke]').forEach(b => {
    b.onclick = async () => {
      const go = await confirmBox({
        title: '取消这台设备的授权？',
        body: '<p>取消后它将立刻无法查看任务、无法接收文件。若要恢复，需要重新输入连接码配对。</p>',
        okText: '取消授权', danger: true,
      });
      if (!go) return;
      try { await api('/api/c/device/revoke', { method: 'POST', body: { id: b.dataset.revoke } }); await refresh(); } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ================= 启动 =================
async function start() {
  await refresh();
  // SSE：任何推送都触发轻量刷新
  const es = new EventSource('/api/c/events');
  const evs = ['device-paired', 'device-online', 'device-offline', 'device-revoked', 'review-updated',
    'comment-added', 'delivery-updated', 'version-ready', 'workspace-ready', 'pair-code-changed', 'delivery-new'];
  evs.forEach(name => es.addEventListener(name, () => scheduleRefresh()));
  es.addEventListener('submit-progress', () => scheduleRefresh(600));
  es.onerror = () => { /* EventSource 自动重连 */ };
  setInterval(refresh, 8000); // 兜底轮询
}
start();
