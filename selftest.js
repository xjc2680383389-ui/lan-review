// selftest.js —— 全链路确定性自检：真实启动服务器 → 完整业务流 → 重启持久化
// 运行：node selftest.js
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const HTTP_PORT = 8476, HTTPS_PORT = 8477;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const TMP = path.join(os.tmpdir(), `lan-review-selftest-${Date.now()}`);
const HOME = path.join(TMP, 'home');
const WS = path.join(TMP, 'workspace');

let pass = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.error(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(method, p, { body, token, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data, headers: res.headers };
}

function childEnv() {
  return {
    ...process.env,
    LAN_REVIEW_NO_OPEN: '1',
    LAN_REVIEW_HTTP_PORT: String(HTTP_PORT),
    LAN_REVIEW_HTTPS_PORT: String(HTTPS_PORT),
    LAN_REVIEW_HOME: HOME,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  };
}

function startServer() {
  const child = spawn(process.execPath, ['server/main.js'], { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  return child;
}
async function waitReady(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/api/server-info`);
      if (r.ok) return;
    } catch { /* 未就绪 */ }
    await sleep(200);
  }
  throw new Error('服务器未能在时限内启动');
}

// 让设备“在线”：保持一条 SSE 连接
function openSSE(token) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}/api/d/events?token=${token}`, res => {
      if (res.statusCode !== 200) return reject(new Error('SSE ' + res.statusCode));
      resolve(req); // 挂着不关 = 在线
    });
    req.on('error', reject);
  });
}

function httpsGet(p, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://127.0.0.1:${HTTPS_PORT}${p}${p.includes('?') ? '&' : '?'}token=${token}`, { rejectUnauthorized: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

// 从本机局域网 IP 发起请求（模拟另一台设备访问创作者接口）
function reqFromLan(p) {
  const ips = os.networkInterfaces();
  let lanIp = null;
  for (const k of Object.keys(ips)) for (const it of ips[k] || []) {
    if (it.family === 'IPv4' && !it.internal) lanIp = lanIp || it.address;
  }
  if (!lanIp) return Promise.resolve({ status: 0, body: 'no-lan-ip' });
  return new Promise((resolve, reject) => {
    const r = http.request(`http://${lanIp}:${HTTP_PORT}${p}`, { method: 'GET', localAddress: lanIp }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    r.end();
  });
}

// ---------- sha256.js 与 node crypto 对拍 ----------
async function testSha256() {
  console.log('\n■ 纯 JS SHA-256 与 Node crypto 对拍');
  const { createSha256 } = await import(url.pathToFileURL(path.join(ROOT, 'public/js/sha256.js')));
  const sizes = [0, 1, 55, 56, 63, 64, 65, 1000, 65537, 1024 * 1024];
  for (const size of sizes) {
    const buf = crypto.randomBytes(size);
    const h = createSha256();
    // 分成不规则块喂入
    let off = 0;
    while (off < buf.length) {
      const n = Math.min(buf.length - off, 1 + ((off * 7) % 100));
      h.update(buf.subarray(off, off + n));
      off += n;
    }
    const mine = h.hex();
    const ref = crypto.createHash('sha256').update(buf).digest('hex');
    check(`sha256 ${size}B`, mine === ref, `${mine} vs ${ref}`);
  }
}

async function main() {
  await fsp.mkdir(HOME, { recursive: true });
  await fsp.mkdir(WS, { recursive: true });
  // 准备项目素材
  const prjDir = path.join(WS, '2026-09-13_测试品牌_自检项目');
  await fsp.mkdir(path.join(prjDir, '分镜'), { recursive: true });
  await fsp.writeFile(path.join(prjDir, '说明.txt'), '这是工作文件 v1', 'utf8');
  const pngHex = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082';
  const pngBytes = Buffer.from(pngHex, 'hex');
  await fsp.writeFile(path.join(prjDir, 'key.png'), pngBytes);
  await fsp.writeFile(path.join(prjDir, '分镜', 'scene-a.md'), '# 分镜 A\n- 镜头1', 'utf8');
  await fsp.writeFile(path.join(prjDir, '分镜', '.隐藏.md'), '不应被收录', 'utf8');

  let server = startServer();
  try {
    await waitReady();
    await testSha256();

    console.log('\n■ 启动与静态页');
    let r = await req('GET', '/api/c/state');
    check('首次启动 firstRun=true', r.data.firstRun === true);
    check('HTTPS 通道可用', r.data.server.httpsAvailable === true);
    const st0 = await req('GET', '/api/server-info');
    check('公开 server-info 不含业务数据', st0.data.ok === true && st0.data.server && !('projects' in st0.data));
    const home = await fetch(`${BASE}/`);
    check('创作者页面仅本机可打开（页面）', home.status === 200 && (await home.text()).includes('提审台'));
    const join = await fetch(`${BASE}/join`);
    check('设备连接页公开', join.status === 200);
    const css = await fetch(`${BASE}/css/app.css`);
    check('静态资源可访问', css.status === 200);
    const lan = await reqFromLan('/api/c/state');
    check('非本机访问创作者 API 被拒', lan.status === 403, `实际 ${lan.status} ${lan.body && lan.body.slice(0, 80)}`);

    console.log('\n■ 工作区');
    r = await req('POST', '/api/c/workspace', { body: { path: WS } });
    check('设置工作区', r.data.ok === true, JSON.stringify(r.data));
    r = await req('GET', '/api/c/state');
    check('工作区已记住', r.data.workspace === WS);
    r = await req('POST', '/api/c/workspace', { body: { path: path.join(WS, '不存在') } });
    check('不存在的文件夹会被拒绝', r.data.ok === false);
    const fsList = await req('GET', `/api/c/fs?path=${encodeURIComponent(path.dirname(WS))}`);
    check('目录浏览', fsList.data.ok && fsList.data.entries.some(e => e.name === path.basename(WS)));
    r = await req('POST', '/api/c/fs/mkdir', { body: { path: path.join(WS, '自建目录') } });
    check('新建文件夹', r.data.ok === true);

    console.log('\n■ 项目');
    r = await req('POST', '/api/c/project', { body: { date: '2026-09-13', brand: '测试品牌', name: '自检项目' } });
    check('同名文件夹 → 询问而非静默覆盖', r.status === 409 && r.data.code === 'folder_exists', JSON.stringify(r.data));
    r = await req('POST', '/api/c/project', { body: { date: '2026-09-13', brand: '测试品牌', name: '自检项目', useExisting: true } });
    check('选择使用现有文件夹', r.data.ok === true);
    const projectId = r.data.project.id;
    r = await req('POST', '/api/c/project', { body: { date: '2026-09-13', brand: '测试品牌', name: '自检项目_2' } });
    check('不同名项目正常创建', r.data.ok === true);
    const prj2 = r.data.project.id;
    r = await req('POST', '/api/c/project', { body: { date: '', name: '坏日期' } });
    check('非法日期被拒绝', r.data.ok === false);

    console.log('\n■ 设备配对与安全');
    r = await req('GET', '/api/d/me');
    check('无 token 访问设备接口 → 401', r.status === 401);
    r = await req('POST', '/api/pair', { body: { code: '999999', name: 'x', role: 'reviewer' } });
    check('错误连接码 → 403', r.status === 403);
    const code = (await req('GET', '/api/c/state')).data.pairCode;
    r = await req('POST', '/api/pair', { body: { code, name: '审核手机', role: 'reviewer' } });
    check('审核设备配对成功', r.data.ok === true && r.data.role === 'reviewer');
    const revToken = r.data.token, revId = r.data.deviceId;
    r = await req('POST', '/api/pair', { body: { code, name: '备用审核机', role: 'reviewer' } });
    const rev2Token = r.data.token;
    r = await req('POST', '/api/pair', { body: { code, name: '接收笔记本', role: 'receiver' } });
    check('接收设备配对成功', r.data.ok === true && r.data.role === 'receiver');
    const rcvToken = r.data.token, rcvId = r.data.deviceId;
    r = await req('GET', `/api/d/me`);
    check('伪造 token → 401', (await req('GET', '/api/d/me', { token: 'deadbeef' })).status === 401);
    r = await req('GET', '/api/d/me', { token: revToken });
    check('合法 token 可用', r.data.ok === true && r.data.device.name === '审核手机');

    console.log('\n■ 提审 V01（版本快照）');
    r = await req('POST', '/api/c/submit', { body: { projectId, paths: [], deviceIds: [revId] } });
    check('空选择被拒绝', r.status === 400);
    r = await req('POST', '/api/c/submit', { body: { projectId, paths: ['说明.txt'], deviceIds: [] } });
    check('未选审核设备被拒绝', r.status === 400);
    r = await req('POST', '/api/c/submit', { body: { projectId, paths: ['../逃跑.txt'], deviceIds: [revId] } });
    check('路径穿越被拒绝', r.status === 400);
    r = await req('POST', '/api/c/submit', { body: { projectId, paths: ['说明.txt', 'key.png', '分镜'], note: '首版', deviceIds: [revId, rev2Token ? (await req('GET', '/api/c/state')).data.devices.find(d => d.name === '备用审核机').id : ''] } });
    check('提交成功', r.data.ok === true, JSON.stringify(r.data));
    const v01 = r.data.versionId;
    let v = null;
    for (let i = 0; i < 50; i++) {
      const st = (await req('GET', '/api/c/state')).data;
      v = st.projects.find(p => p.id === projectId).versions.find(x => x.id === v01);
      if (v.state !== 'preparing') break;
      await sleep(200);
    }
    check('快照完成', v.state === 'ready', v.error || '');
    check('隐藏文件未收录', !v.files.some(f => f.path.includes('隐藏')));
    check('文件夹被递归收录', v.files.length === 3, `实际 ${v.files.length}: ${v.files.map(f => f.path).join(',')}`);
    check('快照含 sha256', v.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)));
    const snapTxt = await fsp.readFile(path.join(WS, '.lan-review', 'versions', v01, '说明.txt'), 'utf8');
    check('快照内容与工作文件一致', snapTxt === '这是工作文件 v1');
    // 提审后修改工作文件 → 版本不受影响
    await fsp.writeFile(path.join(prjDir, '说明.txt'), '这是工作文件 v2（已修改）', 'utf8');
    const snapTxt2 = await fsp.readFile(path.join(WS, '.lan-review', 'versions', v01, '说明.txt'), 'utf8');
    check('提交后修改工作文件不影响已提交版本', snapTxt2 === '这是工作文件 v1');

    console.log('\n■ 审核任务与权限');
    r = await req('GET', '/api/d/tasks', { token: revToken });
    check('被指派设备看到任务', r.data.ok && r.data.tasks.length === 1 && r.data.tasks[0].versionId === v01);
    const task = r.data.tasks[0];
    check('任务包含文件清单', task.files.length === 3 && task.files[0].path && task.files[0].size > 0, `files=${task.files.length} first=${JSON.stringify(task.files[0])}`);
    r = await req('GET', '/api/d/tasks', { token: rcvToken });
    check('接收设备看不到审核任务', r.data.tasks.length === 0);
    r = await req('GET', `/api/d/file?vid=${v01}&p=说明.txt`, { token: revToken });
    const txt = await r.data; // raw 未启用时 data 是 json? —— 该端点返回文件流
    check('审核端可取文件流', r.status === 200 || (txt && txt.ok !== false), `status=${r.status}`);
    r = await req('GET', `/api/d/file?vid=${v01}&p=../偷看.txt`, { token: revToken });
    check('审核端路径穿越被拒', r.status === 400);
    r = await req('GET', `/api/d/file?vid=${v01}&p=说明.txt`, { token: rcvToken });
    check('未指派设备不能取该版本文件', r.status === 403);
    // Range 请求
    const rng = await fetch(`${BASE}/api/d/file?vid=${v01}&p=说明.txt&token=${revToken}`, { headers: { Range: 'bytes=0-3' } });
    const rngBuf = Buffer.from(await rng.arrayBuffer());
    const expectHead = Buffer.from('这是工作文件 v1', 'utf8').subarray(0, 4);
    check('Range 请求返回 206 分片', rng.status === 206 && rngBuf.equals(expectHead), `status=${rng.status} got=${rngBuf.toString('utf8')}`);

    console.log('\n■ 评论与审核结论');
    r = await req('POST', `/api/d/comment?token=${revToken}`, { method: 'POST', body: { versionId: v01, path: '分镜/scene-a.md', text: '第二段节奏有点拖' } });
    check('评论成功', r.data.ok === true);
    r = await req('POST', `/api/d/comment?token=${revToken}`, { method: 'POST', body: { versionId: v01, path: 'key.png', text: '这里抠图有白边', timecodeMs: 0 } });
    const cmtId = r.data.comment?.id;
    check('带时间码字段评论成功', r.data.ok === true);
    r = await req('POST', `/api/d/comment?token=${rcvToken}`, { method: 'POST', body: { versionId: v01, path: 'key.png', text: '未指派设备的评论' } });
    check('未指派设备不能评论', r.status === 403);
    r = await req('POST', `/api/d/decision?token=${revToken}`, { method: 'POST', body: { versionId: v01, path: '说明.txt', decision: 'reject' } });
    check('标记需修改生效', r.data.ok === true && r.data.approvable === false);
    r = await req('POST', '/api/c/deliver', { body: { versionId: v01, receiverId: rcvId } });
    check('未全部通过时交付被拒(409)', r.status === 409 && r.data.code === 'not_approved', JSON.stringify(r.data));
    for (const p of ['说明.txt', 'key.png', '分镜/scene-a.md']) {
      r = await req('POST', `/api/d/decision?token=${revToken}`, { method: 'POST', body: { versionId: v01, path: p, decision: 'approve' } });
    }
    check('单设备全通过仍不可交付（还有第二台设备）', r.data.approvable === false, JSON.stringify(r.data));
    const stNow = (await req('GET', '/api/c/state')).data;
    const dev2 = stNow.devices.find(d => d.name === '备用审核机');
    for (const p of ['说明.txt', 'key.png', '分镜/scene-a.md']) {
      await req('POST', `/api/d/decision?token=${rev2Token}`, { method: 'POST', body: { versionId: v01, path: p, decision: 'approve' } });
    }
    const vAfter = (await req('GET', '/api/c/state')).data.projects.find(p => p.id === projectId).versions.find(x => x.id === v01);
    check('所有指派设备全通过 → 可交付', vAfter.approvable === true, JSON.stringify(vAfter.approvalStats));

    console.log('\n■ 正式交付（离线/角色/HTTPS 通道/进度/结果）');
    r = await req('POST', '/api/c/deliver', { body: { versionId: v01, receiverId: dev2.id } });
    check('不能交付给审核设备（角色不符）', r.status === 409 && r.data.code === 'wrong_role');
    r = await req('POST', '/api/c/deliver', { body: { versionId: v01, receiverId: rcvId } });
    check('接收设备离线时交付被拒', r.status === 409 && r.data.code === 'offline', JSON.stringify(r.data));
    const sseReq = await openSSE(rcvToken);
    await sleep(400);
    const stOn = (await req('GET', '/api/c/state')).data;
    check('SSE 上线后设备显示在线', stOn.devices.find(d => d.id === rcvId).online === true);
    r = await req('POST', '/api/c/deliver', { body: { versionId: v01, receiverId: rcvId } });
    check('在线后交付成功创建', r.data.ok === true, JSON.stringify(r.data));
    const dlvId = r.data.delivery.id;
    check('接收设备有待收交付', ((await req('GET', '/api/d/delivery', { token: rcvToken })).data.active || {}).id === dlvId);
    r = await req('GET', `/api/d/delivery-file?i=0`, { token: rcvToken });
    check('HTTP 通道禁止交付文件（仅 HTTPS）', r.status === 403 && r.data.code === 'https_required', JSON.stringify(r.data));
    const hf = await httpsGet(`/api/d/delivery-file?i=1`, rcvToken);
    const srcPng = await fsp.readFile(path.join(WS, '.lan-review', 'versions', v01, 'key.png'));
    check('HTTPS 通道取到的字节与快照一致', hf.status === 200 && hf.buf.equals(srcPng));
    // 越权：审核设备的 token 不能拉交付文件
    const hfBad = await httpsGet(`/api/d/delivery-file?i=1`, revToken);
    check('审核设备 token 不能拉交付文件', hfBad.status !== 200);
    r = await req('POST', `/api/d/delivery/progress?token=${rcvToken}`, { method: 'POST', body: { deliveryId: dlvId, i: 0, started: true } });
    check('progress(started) 接受', r.data.ok === true);
    for (let i = 0; i < 3; i++) {
      r = await req('POST', `/api/d/delivery/progress?token=${rcvToken}`, { method: 'POST', body: { deliveryId: dlvId, i, ok: true } });
    }
    check('逐文件上报成功', r.data.ok === true);
    r = await req('POST', `/api/d/delivery/complete?token=${rcvToken}`, { method: 'POST', body: { deliveryId: dlvId, savedDirName: '接收\\2026-09-13_测试品牌_自检项目_V01' } });
    check('交付完成 → completed', r.data.state === 'completed', JSON.stringify(r.data));
    const dlvState = (await req('GET', '/api/c/state')).data.deliveries.find(d => d.id === dlvId);
    check('创作者看到交付成功+保存位置', dlvState.state === 'completed' && dlvState.savedDirName.includes('V01'));
    sseReq.destroy();

    console.log('\n■ 配对限速');
    for (let i = 0; i < 5; i++) await req('POST', '/api/pair', { body: { code: '000000', name: 'x', role: 'reviewer' } });
    r = await req('POST', '/api/pair', { body: { code: '000000', name: 'x', role: 'reviewer' } });
    check('连续错 5 次后锁定（429）', r.status === 429, `实际 ${r.status}`);

    console.log('\n■ 重启持久化');
    server.kill();
    await sleep(600);
    server = startServer();
    await waitReady();
    r = await req('GET', '/api/c/state');
    const stAfter = r.data;
    const pAfter = stAfter.projects.find(p => p.id === projectId);
    const vAfter2 = pAfter.versions.find(x => x.id === v01);
    check('项目仍在', !!pAfter);
    check('版本与文件仍在', vAfter2 && vAfter2.files.length === 3);
    check('审核结论仍在', vAfter2.approvable === true);
    check('评论仍在', vAfter2.comments.length === 2 && vAfter2.comments.some(c => c.id === cmtId));
    check('交付记录仍在', stAfter.deliveries.some(d => d.id === dlvId && d.state === 'completed'));
    check('连接码不变', stAfter.pairCode === code);
    r = await req('GET', '/api/d/tasks', { token: revToken });
    check('设备 token 重启后仍有效', r.data.ok === true && r.data.tasks.length === 1);
    check('设备重启后标记离线', (await req('GET', '/api/c/state')).data.devices.every(d => d.online === false));

    console.log('\n■ 取消授权');
    r = await req('POST', '/api/c/device/revoke', { body: { id: rev2Token ? dev2.id : '' } });
    check('取消授权成功', r.data.ok === true);
    r = await req('GET', '/api/d/tasks', { token: rev2Token });
    check('被取消授权的设备立即失效', r.status === 401);

  } finally {
    server.kill();
    await sleep(300);
    await fsp.rm(TMP, { recursive: true, force: true }).catch(() => { });
  }

  console.log(`\n========== SELFTEST ${failCount === 0 ? 'PASS' : 'FAIL'}：${pass} 通过 / ${failCount} 失败 ==========`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(e => { console.error('selftest 异常：', e); process.exit(1); });
