// device.js —— 设备端：配对 / 手机·笔记本审核 / 接收电脑交付
import { api, esc, fmtSize, fmtTime, fmtTC, icon, KIND_ICON, toast, confirmBox, showViewer, hydrateTextPreviews } from './common.js';
import { createSha256 } from './sha256.js';

const $ = sel => document.querySelector(sel);
const app = $('#app');
const TOKEN = () => localStorage.getItem('lr_token'); // 配对发生在页面加载后，必须动态读取
const MY = {
  id: localStorage.getItem('lr_id') || '',
  name: localStorage.getItem('lr_name') || '',
  role: localStorage.getItem('lr_role') || '',
};
let SERVER = null;   // /api/server-info
let ES = null;       // EventSource
let dirHandle = null;

// ================= 入口 =================
async function start() {
  try {
    SERVER = (await api('/api/server-info')).server;
  } catch (e) {
    app.innerHTML = `<div class="card card-pad" style="margin-top:14vh;text-align:center"><h3>连不上提审台</h3><p class="dim">${esc(e.message)}</p><p class="dim">请确认与创作者电脑连的是同一个 Wi-Fi，且对方程序已启动。</p></div>`;
    return;
  }
  if (!TOKEN) { renderPair(); return; }
  let me;
  try { me = (await api(`/api/d/me?token=${TOKEN()}`, { headers: { Authorization: `Bearer ${TOKEN()}` } })).device; }
  catch { localStorage.removeItem('lr_token'); renderPair(); return; }
  MY.id = me.id; MY.name = me.name; MY.role = me.role;
  renderRoleView();
}

function connectSSE(onEvents) {
  if (ES) ES.close();
  ES = new EventSource(`/api/d/events?token=${TOKEN()}`);
  ES.onerror = () => { /* 自动重连 */ };
  return ES;
}

function renderMeChip() {
  $('#me-chip').innerHTML = `<span class="dot on"></span> ${esc(MY.name)} · ${MY.role === 'receiver' ? '接收电脑' : '审核设备'}
    <button class="btn btn-sm" id="btn-exit">退出连接</button>`;
  $('#btn-exit').onclick = async () => {
    const go = await confirmBox({ title: '退出连接？', body: '<p>退出后如需再连，要重新输入连接码。创作者那边也会看到本设备离线。</p>', okText: '退出' });
    if (!go) return;
    ['lr_token', 'lr_id', 'lr_name', 'lr_role'].forEach(k => localStorage.removeItem(k));
    location.reload();
  };
}

// ================= 配对 =================
function renderPair(prefillRole) {
  $('#hd-sub').textContent = '设备连接';
  $('#me-chip').innerHTML = '';
  if (ES) { ES.close(); ES = null; }
  const httpsAvailable = SERVER.httpsAvailable;
  const httpsUrl = location.protocol === 'http:' && httpsAvailable
    ? `https://${location.hostname}:${SERVER.httpsPort}/join` : null;
  app.innerHTML = `
  <div class="card card-pad dev-card">
    <div class="empty" style="padding:10px 0 18px">
      <div class="empty-ic">${icon('link', 26)}</div>
      <h3>连接到创作者的提审台</h3>
      <p>请向创作者要 6 位连接码，然后填在下面</p>
    </div>
    <label class="field"><span>连接码</span><input class="input code-input mono" id="pair-code" inputmode="numeric" maxlength="6" placeholder="······" autocomplete="one-time-code"></label>
    <label class="field"><span>给这台设备起个名字</span><input class="input" id="pair-name" placeholder="例如：我的手机 / 客户笔记本"></label>
    <div class="field"><span>这台设备用来做什么</span>
      <div class="role-pick">
        <label class="role-opt"><input type="radio" name="role" value="reviewer" checked>${icon('phone', 22)}<b>审核设备</b><small>看文件、写评论、点通过</small></label>
        <label class="role-opt"><input type="radio" name="role" value="receiver" ${httpsAvailable ? '' : 'disabled'}>${icon('laptop', 22)}<b>接收电脑</b><small>接收审核通过的正式文件</small></label>
      </div>
    </div>
    <div id="pair-err"></div>
    <button class="btn btn-primary btn-lg bigbtn" id="pair-go" style="margin-top:14px">${icon('link')}连接</button>
  </div>
  <div class="card card-pad dev-card">
    <div class="stat-strip"><span>${icon('wifi', 14)} 服务器：${esc(location.host)}</span></div>
  </div>`;
  const errBox = $('#pair-err');
  const roleOf = () => document.querySelector('input[name="role"]:checked')?.value;

  const showHttpsGuide = () => {
    errBox.innerHTML = `<div class="notice" style="margin-top:10px">${icon('alert')}<div>
      <b>接收电脑需要用「安全通道」连接。</b><br>
      请把浏览器地址换成：<br><b class="mono" style="word-break:break-all">${esc(httpsUrl || '')}</b><br>
      <button class="btn btn-sm" id="copy-https" style="margin:6px 0">${icon('copy')}复制地址</button><br>
      打开时浏览器会提示「不安全」——这是因为证书是创作者电脑自建的，属正常现象：点「高级」→「继续前往」即可。
    </div></div>`;
    $('#copy-https').onclick = async () => {
      try { await navigator.clipboard.writeText(httpsUrl); toast('已复制，请粘贴到地址栏打开', 'ok'); } catch { toast('复制失败，请手动选择地址复制', 'err'); }
    };
  };

  document.querySelectorAll('input[name="role"]').forEach(r => {
    r.onchange = () => {
      if (roleOf() === 'receiver' && location.protocol === 'http:') showHttpsGuide();
      else errBox.innerHTML = '';
    };
  });
  if (prefillRole === 'receiver' && location.protocol === 'http:' && httpsUrl) showHttpsGuide();

  $('#pair-go').onclick = async () => {
    const code = $('#pair-code').value.trim();
    const name = $('#pair-name').value.trim();
    const role = roleOf();
    if (!/^\d{6}$/.test(code)) { errBox.innerHTML = `<div class="notice err">${icon('alert')}请输入 6 位数字连接码</div>`; return; }
    if (role === 'receiver' && location.protocol === 'http:') { showHttpsGuide(); return; }
    try {
      const r = await api('/api/pair', { method: 'POST', body: { code, name, role } });
      localStorage.setItem('lr_token', r.token);
      localStorage.setItem('lr_id', r.deviceId);
      localStorage.setItem('lr_name', r.name);
      localStorage.setItem('lr_role', r.role);
      MY.id = r.deviceId; MY.name = r.name; MY.role = r.role;
      toast(`连接成功，欢迎「${r.name}」`, 'ok');
      renderRoleView();
    } catch (e) {
      errBox.innerHTML = `<div class="notice err">${icon('alert')}<div>${esc(e.message)}</div></div>`;
    }
  };
  $('#pair-code').focus();
}

function renderRoleView() {
  renderMeChip();
  if (MY.role === 'receiver') startReceiver();
  else startReviewer();
}

// ================= 审核端 =================
let TASKS = [];
let curTask = null; // {projectId, versionId}

async function startReviewer() {
  $('#hd-sub').textContent = '审核';
  app.innerHTML = '<div class="card card-pad" style="margin-top:16px;text-align:center"><span class="dim">正在获取任务…</span></div>';
  connectSSE();
  ES.addEventListener('task-assigned', () => { toast('有新的审核任务', 'ok'); loadTasks(); });
  await loadTasks();
}

async function loadTasks() {
  try {
    const r = await api(`/api/d/tasks?token=${TOKEN()}`);
    TASKS = r.tasks;
    if (curTask) {
      const t = TASKS.find(x => x.versionId === curTask.versionId);
      if (t) { renderTaskDetail(t); return; }
      curTask = null;
    }
    renderTaskList();
  } catch (e) {
    app.innerHTML = `<div class="card card-pad" style="margin-top:16px"><div class="notice err">${icon('alert')}<div>${esc(e.message)}</div></div></div>`;
  }
}

function myProgressOf(t) {
  const total = t.files.length;
  let done = 0, approved = 0;
  for (const f of t.files) {
    const d = t.myDecisions[f.path];
    if (d) { done++; if (d === 'approve') approved++; }
  }
  return { total, done, approved };
}

function renderTaskList() {
  $('#hd-sub').textContent = '审核 · 我的任务';
  if (!TASKS.length) {
    app.innerHTML = `<div class="card dev-card"><div class="empty"><div class="empty-ic">${icon('stamp', 26)}</div>
      <h3>暂时没有分配给你的任务</h3><p>创作者提交新版本后，这里会立刻出现</p></div></div>`;
    return;
  }
  app.innerHTML = TASKS.map(t => {
    const pr = myProgressOf(t);
    return `<div class="card card-pad task-card">
      <div class="ver-head">
        <span class="ver-num">${esc(t.num)}</span>
        <b>${esc(t.projectName)}</b>
        ${pr.done === pr.total && pr.approved === pr.total ? '<span class="badge badge-ok">已全部通过</span>' : pr.done < pr.total ? `<span class="badge badge-warn">审了 ${pr.done}/${pr.total}</span>` : '<span class="badge badge-err">有需要修改的文件</span>'}
      </div>
      <div class="dim" style="font-size:12.5px;margin-top:2px">${fmtTime(t.createdAt)} · ${t.files.length} 个文件 · ${fmtSize(t.totalBytes)}${t.note ? ` · ${esc(t.note)}` : ''}</div>
      <button class="btn btn-brand bigbtn" data-task="${t.versionId}" style="margin-top:10px">${icon('eye')}查看文件并审核</button>
    </div>`;
  }).join('');
  app.querySelectorAll('[data-task]').forEach(b => {
    b.onclick = () => {
      curTask = { versionId: b.dataset.task };
      renderTaskDetail(TASKS.find(t => t.versionId === b.dataset.task));
    };
  });
}

function renderTaskDetail(t) {
  $('#hd-sub').textContent = `审核 · ${t.projectName} ${t.num}`;
  const pr = myProgressOf(t);
  app.innerHTML = `
  <button class="btn btn-sm" id="back-list">‹ 返回任务列表</button>
  <div class="card card-pad task-card">
    <div class="ver-head">
      <span class="ver-num">${esc(t.num)}</span><b>${esc(t.projectName)}</b>
      ${pr.done === pr.total && pr.approved === pr.total ? '<span class="badge badge-ok">已全部通过</span>' : `<span class="badge badge-warn">已审 ${pr.done}/${pr.total}</span>`}
    </div>
    ${t.note ? `<div class="dim" style="font-size:13px;margin-top:4px">版本说明：${esc(t.note)}</div>` : ''}
    <div class="dim" style="font-size:12.5px;margin-top:2px">点开每个文件，看完后给出「通过」或「需要修改」，还可以写评论。</div>
    <div class="task-files">
      ${t.files.map(f => {
      const d = t.myDecisions[f.path];
      return `<div class="rowitem">
          <span style="color:var(--brand)">${icon(KIND_ICON[f.kind] || 'file', 18)}</span>
          <div class="grow">
            <div class="ellip">${esc(f.path.split('/').pop())}</div>
            <div class="dim ellip" style="font-size:11.5px">${esc(f.path)} · ${fmtSize(f.size)}</div>
          </div>
          ${d === 'approve' ? '<span class="badge badge-ok">已通过</span>' : d === 'reject' ? '<span class="badge badge-err">需修改</span>' : '<span class="badge badge-dim">未审</span>'}
          <button class="btn btn-sm btn-brand" data-open="${esc(f.path)}">${icon('eye')}预览</button>
        </div>`;
    }).join('')}
    </div>
  </div>`;
  $('#back-list').onclick = () => { curTask = null; renderTaskList(); };
  app.querySelectorAll('[data-open]').forEach(b => {
    b.onclick = () => openReviewViewer(t, b.dataset.open);
  });
}

function openReviewViewer(t, rel) {
  const file = t.files.find(f => f.path === rel);
  if (!file) return;
  const src = `/api/d/file?vid=${t.versionId}&p=${encodeURIComponent(rel)}&token=${TOKEN()}`;
  const viewer = showViewer({
    name: rel.split('/').pop(), kind: file.kind, size: file.size, src,
    downloadUrl: `${src}&download=1`,
    buildSide: (side, ctx) => buildReviewSide(side, ctx, t, file),
  });
  hydrateTextPreviews(viewer.wrap);
}

function buildReviewSide(side, ctx, t, file) {
  const my = t.myDecisions[file.path];
  const comments = () => t.comments.filter(c => c.path === file.path);
  side.innerHTML = `
    <h3 style="font-size:14px">${esc(file.path.split('/').pop())}</h3>
    <div class="dim" style="font-size:12px;margin-bottom:10px">${esc(file.path)} · ${fmtSize(file.size)}</div>
    <b style="font-size:13px">我的审核结论</b>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0 14px">
      <button class="btn ${my === 'approve' ? 'btn-brand' : ''}" data-d="approve">${icon('check')}通过</button>
      <button class="btn ${my === 'reject' ? 'btn-danger' : ''}" data-d="reject">${icon('x')}需要修改</button>
    </div>
    <b style="font-size:13px">评论（${comments().length}）</b>
    <div id="cmt-list" style="margin:6px 0">${cmtListHtml(comments())}</div>
    <textarea class="textarea" id="cmt-text" placeholder="写评论…"></textarea>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
      <button class="btn btn-sm btn-primary" id="cmt-send">${icon('send')}发评论</button>
      ${file.kind === 'video' ? `<button class="btn btn-sm" id="cmt-tc">${icon('clock')}评论当前画面</button>` : ''}
    </div>`;
  const video = ctx.wrap.querySelector('video');
  const send = async (timecodeMs = null) => {
    const input = side.querySelector('#cmt-text');
    const text = input.value.trim();
    if (!text) { toast('先写点内容再发', 'err'); return; }
    try {
      await api(`/api/d/comment?token=${TOKEN()}`, {
        method: 'POST',
        body: { versionId: t.versionId, path: file.path, text, timecodeMs },
        headers: { Authorization: `Bearer ${TOKEN()}` },
      });
      input.value = '';
      toast('评论已送达创作者', 'ok');
      const localC = { deviceName: MY.name, at: Date.now(), text, timecodeMs, path: file.path };
      t.comments.push(localC);
      side.querySelector('#cmt-list').innerHTML = cmtListHtml(comments());
    } catch (e) { toast(e.message, 'err'); }
  };
  side.querySelector('#cmt-send').onclick = () => send(null);
  const tcBtn = side.querySelector('#cmt-tc');
  if (tcBtn) tcBtn.onclick = () => {
    if (!video) { toast('视频还没准备好', 'err'); return; }
    send(Math.round(video.currentTime * 1000));
  };
  side.querySelectorAll('[data-d]').forEach(b => {
    b.onclick = async () => {
      const decision = b.dataset.d;
      try {
        const r = await api(`/api/d/decision?token=${TOKEN()}`, {
          method: 'POST',
          body: { versionId: t.versionId, path: file.path, decision },
          headers: { Authorization: `Bearer ${TOKEN()}` },
        });
        t.myDecisions[file.path] = decision;
        toast(decision === 'approve' ? '已标记通过' : '已标记需要修改', 'ok');
        buildReviewSide(side, ctx, t, file);
        if (curTask && curTask.versionId === t.versionId) renderTaskDetail(t); // 背后列表徽标即时更新
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  // 时间码点击 → 跳回视频位置
  side.querySelectorAll('.tc-chip').forEach(ch => {
    ch.onclick = () => {
      if (!video) { toast('这条是视频时间码，但当前没在播放视频', 'err'); return; }
      const seekTo = () => { video.currentTime = (+ch.dataset.tc) / 1000; video.play().catch(() => { }); };
      if (video.readyState >= 1) seekTo();
      else video.addEventListener('loadedmetadata', seekTo, { once: true });
    };
  });
}

function cmtListHtml(comments) {
  if (!comments.length) return '<div class="dim" style="font-size:12.5px">还没有评论</div>';
  return comments.map(c => `<div class="cmt">
    <span class="who">${esc(c.deviceName || '设备')}</span>
    <span class="dim" style="font-size:11px">· ${fmtTime(c.at)}</span>
    ${c.timecodeMs != null ? ` <button class="tc-chip" data-tc="${c.timecodeMs}">▶ ${fmtTC(c.timecodeMs)}</button>` : ''}
    <div>${esc(c.text)}</div>
  </div>`).join('');
}

// ================= 接收端 =================
async function startReceiver() {
  $('#hd-sub').textContent = '接收';
  connectSSE().addEventListener('delivery-new', () => { toast('收到新的交付', 'ok'); loadDelivery(); });
  ES.addEventListener('delivery-cancelled', () => { toast('创作者取消了交付', 'err'); loadDelivery(); });
  if (!window.showDirectoryPicker) {
    app.innerHTML = `<div class="card card-pad dev-card"><div class="notice err">${icon('alert')}<div>
      这台电脑上的浏览器不支持直接保存文件（需要 Chrome 或 Edge 浏览器）。<br>
      请安装/改用 Chrome 或 Edge 打开本页面。</div></div></div>`;
    return;
  }
  app.innerHTML = `
    <div class="card card-pad dev-card" id="dir-card"><span class="dim">正在读取接收文件夹设置…</span></div>
    <div id="dlv-box"></div>
    <div id="dlv-last"></div>`;
  await initDirHandle();
  renderDirCard();
  await loadDelivery();
}

async function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lan-review', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(k, v) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(k) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(k);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function initDirHandle() {
  try {
    const saved = await idbGet('recv-dir');
    if (saved) dirHandle = saved;
  } catch { /* ignore */ }
}

async function renderDirCard() {
  const card = $('#dir-card');
  if (!dirHandle) {
    card.innerHTML = `
      <div class="ver-head">${icon('drive')}<b>第 1 步：选择接收文件夹</b></div>
      <p class="dim" style="font-size:13px;margin:6px 0 10px">审核通过的正式文件会保存到这里（按 项目名_版本号 分文件夹）。只需选一次，以后会记住。</p>
      <button class="btn btn-brand bigbtn" id="pick-dir">${icon('folder')}选择接收文件夹</button>`;
    card.querySelector('#pick-dir').onclick = async () => {
      try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await idbSet('recv-dir', dirHandle);
        toast(`接收文件夹：${dirHandle.name}`, 'ok');
        renderDirCard();
      } catch (e) {
        if (e.name !== 'AbortError') toast(`无法选择文件夹：${e.message}`, 'err');
      }
    };
    return;
  }
  let perm = 'granted';
  try { perm = await dirHandle.queryPermission({ mode: 'readwrite' }); } catch { /* ignore */ }
  if (perm !== 'granted') {
    card.innerHTML = `
      <div class="ver-head">${icon('drive')}<b>接收文件夹</b><span class="badge badge-warn">需要重新授权</span></div>
      <p class="dim" style="font-size:13px;margin:6px 0 10px">上次选择的「${esc(dirHandle.name)}」需要点一下授权才能继续写入。</p>
      <button class="btn btn-brand bigbtn" id="perm-dir">${icon('check')}授权「${esc(dirHandle.name)}」</button>`;
    card.querySelector('#perm-dir').onclick = async () => {
      const p = await dirHandle.requestPermission({ mode: 'readwrite' });
      if (p === 'granted') { toast('已授权', 'ok'); renderDirCard(); }
      else toast('没有获得写权限，将无法接收文件', 'err');
    };
    return;
  }
  card.innerHTML = `
    <div class="ver-head">${icon('drive')}<b>接收文件夹</b><span class="badge badge-ok">就绪</span></div>
    <p class="dim" style="font-size:13px;margin:6px 0 0">文件将存入「${esc(dirHandle.name)}」，按 项目名_版本号 分文件夹，保持原始目录结构。</p>`;
  if (curDlv) renderDelivery();
}

let curDlv = null;
let busy = false;

async function loadDelivery() {
  try {
    const r = await api(`/api/d/delivery?token=${TOKEN()}`);
    curDlv = r.active;
    await renderDelivery();
    renderLastFinished(r.lastFinished);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function renderDelivery() {
  const box = $('#dlv-box');
  if (!box) return;
  if (!curDlv) {
    box.innerHTML = `<div class="card dev-card"><div class="empty"><div class="empty-ic">${icon('stamp', 26)}</div>
      <h3>等待正式交付</h3><p>创作者把审核通过的版本发过来时，这里会自动出现任务</p></div></div>`;
    return;
  }
  const d = curDlv;
  const okN = d.files.filter(f => f.state === 'ok').length;
  const failN = d.files.filter(f => f.state === 'failed').length;
  box.innerHTML = `
  <div class="card card-pad dev-card">
    <div class="ver-head">
      <span class="ver-num">${esc(d.versionNum)}</span><b>${esc(d.projectName)}</b>
      ${d.state === 'pending' ? '<span class="badge badge-brand">待接收</span>' : '<span class="badge badge-brand">传输中</span>'}
    </div>
    <div class="dim" style="font-size:12.5px;margin:4px 0 8px">${fmtTime(d.createdAt)} · ${d.files.length} 个文件 · ${fmtSize(d.totalBytes)}${d.state === 'pending' ? ' · 审核通过的正式版本' : ''}</div>
    <div class="progress" style="margin-bottom:10px"><i style="width:${Math.round(okN / d.files.length * 100)}%"></i></div>
    <div style="max-height:300px;overflow:auto">
      ${d.files.map((f, i) => `<div class="rowitem" style="padding:6px 2px">
        <span style="color:var(--brand)">${icon(KIND_ICON[f.kind] || 'file', 15)}</span>
        <div class="grow"><div class="ellip" style="font-size:13px">${esc(f.path)}</div>
          <div class="dim" style="font-size:11.5px">${fmtSize(f.size)}${f.state === 'failed' ? ` · ${esc(f.error || '失败')}` : ''}</div></div>
        ${f.state === 'ok' ? '<span class="badge badge-ok">已保存</span>' : f.state === 'failed' ? `<span class="badge badge-err">失败</span> <button class="btn btn-sm" data-retry="${i}">重试</button>` : `<span class="dim" style="font-size:12px" data-prog="${i}">等待</span>`}
      </div>`).join('')}
    </div>
    <div style="display:flex;gap:10px;margin-top:12px">
      ${d.files.some(f => f.state !== 'ok') ? `<button class="btn btn-brand bigbtn" id="dlv-go" ${!dirHandle ? 'disabled title="请先选择接收文件夹"' : ''}>${icon('download')}${okN > 0 ? '继续接收剩余文件' : '开始接收'}</button>` : ''}
      <button class="btn btn-danger bigbtn" id="dlv-cancel" style="flex:0 0 auto">${icon('x')}取消</button>
    </div>
  </div>`;
  const go = box.querySelector('#dlv-go');
  if (go) go.onclick = () => runDelivery(d);
  box.querySelector('#dlv-cancel').onclick = async () => {
    const goCancel = await confirmBox({ title: '取消这笔交付？', body: '<p>已保存的文件会留下，创作者会看到「接收端取消」。</p>', okText: '取消交付', danger: true });
    if (!goCancel) return;
    try { await api(`/api/d/delivery/cancel-by-receiver?token=${TOKEN()}`, { method: 'POST', body: { deliveryId: d.id, reason: '接收端手动取消' }, headers: { Authorization: `Bearer ${TOKEN()}` } }); curDlv = null; loadDelivery(); } catch (e) { toast(e.message, 'err'); }
  };
  box.querySelectorAll('[data-retry]').forEach(b => { b.onclick = () => receiveSingle(d, +b.dataset.retry); });
}

function setFileUi(i, html) {
  const el = document.querySelector(`[data-prog="${i}"]`);
  if (el) el.outerHTML = html;
}

async function receiveSingle(d, i) {
  const f = d.files[i];
  setFileUi(i, '<span class="badge badge-brand">接收中…</span>');
  await api(`/api/d/delivery/progress?token=${TOKEN()}`, {
    method: 'POST', body: { deliveryId: d.id, i, started: true }, headers: { Authorization: `Bearer ${TOKEN()}` },
  }).catch(() => { });
  try {
    await receiveOne(d, i);
    f.state = 'ok';
    await api(`/api/d/delivery/progress?token=${TOKEN()}`, { method: 'POST', body: { deliveryId: d.id, i, ok: true }, headers: { Authorization: `Bearer ${TOKEN()}` } });
    setFileUi(i, '<span class="badge badge-ok">已保存</span>');
    return true;
  } catch (e) {
    f.state = 'failed'; f.error = e.message;
    await api(`/api/d/delivery/progress?token=${TOKEN()}`, { method: 'POST', body: { deliveryId: d.id, i, ok: false, error: e.message }, headers: { Authorization: `Bearer ${TOKEN()}` } });
    setFileUi(i, `<span class="badge badge-err">失败</span>`);
    toast(`「${f.path.split('/').pop()}」接收失败：${e.message}`, 'err', 5000);
    return false;
  }
}

async function receiveOne(d, i) {
  const f = d.files[i];
  const res = await fetch(`/api/d/delivery-file?i=${i}&token=${TOKEN()}`, { headers: { Authorization: `Bearer ${TOKEN()}` } });
  if (!res.ok) {
    let m = `下载失败（${res.status}）`;
    try { m = (await res.json()).message || m; } catch { /* ignore */ }
    throw new Error(m);
  }
  const total = +res.headers.get('content-length') || f.size;
  const sha = createSha256();
  const reader = res.body.getReader();
  const top = `${d.projectName}_${d.versionNum}`.replace(/[\\/:*?"<>|]/g, '_');
  let dir = await dirHandle.getDirectoryHandle(top, { create: true });
  const parts = f.path.split('/');
  for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
  const fh = await dir.getFileHandle(parts.at(-1), { create: true });
  const w = await fh.createWritable();
  let got = 0, lastUi = 0;
  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      sha.update(value);
      await w.write(value);
      got += value.byteLength;
      const nowT = Date.now();
      if (nowT - lastUi > 200) { lastUi = nowT; setFileUi(i, `<span class="dim mono" style="font-size:12px">${Math.round(got / total * 100)}%</span>`); }
    }
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* ignore */ }
    throw new Error(e.name === 'NoModificationAllowedError' ? '写入被拒绝，请重新授权文件夹' : `写入失败：${e.message}`);
  }
  const hex = sha.hex();
  if (hex !== f.sha256) throw new Error('校验不一致，传输有误');
}

async function runDelivery(d) {
  if (busy) return;
  if (!dirHandle) { toast('请先选择接收文件夹', 'err'); return; }
  busy = true;
  const idxs = d.files.map((f, i) => ({ f, i })).filter(x => x.f.state !== 'ok').map(x => x.i);
  for (const i of idxs) await receiveSingle(d, i);
  busy = false;
  const okN = d.files.filter(f => f.state === 'ok').length;
  try {
    const r = await api(`/api/d/delivery/complete?token=${TOKEN()}`, {
      method: 'POST',
      body: { deliveryId: d.id, savedDirName: `${dirHandle.name}\\${(d.projectName + '_' + d.versionNum).replace(/[\\/:*?"<>|]/g, '_')}` },
      headers: { Authorization: `Bearer ${TOKEN()}` },
    });
    if (r.state === 'completed') {
      toast(`全部接收完成：${d.files.length} 个文件已存入「${dirHandle.name}」`, 'ok', 6000);
      curDlv = null;
    } else {
      toast('有文件未成功，可逐个点「重试」', 'err', 6000);
    }
  } catch (e) { toast(e.message, 'err'); }
  loadDelivery();
}

function renderLastFinished(d) {
  const box = $('#dlv-last');
  if (!d) { box.innerHTML = ''; return; }
  const okN = d.files.filter(f => f.state === 'ok').length;
  const allOk = okN === d.files.length;
  box.innerHTML = `<div class="card card-pad dev-card">
    <div class="ver-head">
      ${allOk ? '<span class="badge badge-ok">最近一笔：交付成功</span>' : '<span class="badge badge-warn">最近一笔：未完整接收</span>'}
      <b>${esc(d.projectName)} ${esc(d.versionNum)}</b>
      <span class="dim" style="font-size:12px">${fmtTime(d.finishedAt)}</span>
    </div>
    <div class="dim" style="font-size:12.5px;margin-top:4px">${okN}/${d.files.length} 个文件保存成功${d.savedDirName ? ` · 位于「${esc(d.savedDirName)}」` : ''}${d.error ? ` · ${esc(d.error)}` : ''}</div>
  </div>`;
}

start();
