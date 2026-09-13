// api.js —— 全部业务路由：工作区 / 项目 / 提审快照 / 设备 / 审核 / 交付
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  parseUrl, clientIp, isLoopback, isHttps,
  ok, fail, readJsonBody, serveStatic, sendVersionFile,
} from './core.js';
import {
  safeRel, sha256File, copyFileWithProgress, walkFiles, kindOf,
  randomId,
} from './media.js';

const ACTIVE_DELIVERY = new Set(['pending', 'transferring']);

export function createApi(db, hub, serverInfo) {
  const jobs = new Map(); // versionId -> {cancelled:false}

  // ---------- 工具 ----------
  const now = () => Date.now();
  function touch(dv) { dv.lastSeenAt = now(); }

  function requireDevice(req) {
    const { query } = parseUrl(req);
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (query.get('token') || '');
    const dv = db.deviceByToken(token);
    return dv;
  }

  function devicePublic(dv) {
    return { id: dv.id, name: dv.name, role: dv.role, online: !!dv.online, lastSeenAt: dv.lastSeenAt, pairedAt: dv.pairedAt };
  }

  function versionFull(v) {
    const { progress, ...rest } = v;
    return { ...rest, progress: v.state === 'preparing' ? progress : undefined };
  }

  function findVersion(vid) {
    for (const p of db.projects) {
      const v = db.versionById(p, vid);
      if (v) return { p, v };
    }
    return null;
  }

  function snapshotPath(v, rel) {
    return path.join(db.versionsDir, v.id, ...rel.split('/'));
  }

  function openInFileManager(dir) {
    if (process.platform === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
    else spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
  }

  function sanitizePart(s, max = 60) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').replace(/^\.+/, '').trim().slice(0, max);
  }

  async function listDirForPick(dir) {
    const isWin = process.platform === 'win32';
    if (!dir) {
      if (isWin) {
        const drives = [];
        for (let i = 65; i <= 90; i++) {
          const d = `${String.fromCharCode(i)}:\\`;
          try { fs.accessSync(d); drives.push({ name: d, path: d, type: 'dir' }); } catch { /* 盘符不存在 */ }
        }
        return { path: '', parent: null, entries: drives };
      }
      dir = '/';
    }
    const abs = path.resolve(dir);
    const entries = [];
    const items = await fsp.readdir(abs, { withFileTypes: true });
    for (const it of items) {
      if (!it.isDirectory()) continue;
      if (it.isSymbolicLink()) continue;
      if (it.name.startsWith('$')) continue;
      entries.push({ name: it.name, path: path.join(abs, it.name), type: 'dir' });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const parent = path.dirname(abs);
    return { path: abs, parent: parent === abs ? null : parent, entries };
  }

  // ---------- 提审快照任务 ----------
  function pushProgress(v) {
    hub.send('creator', 'submit-progress', { versionId: v.id, projectId: findVersion(v.id)?.p.id, progress: v.progress, state: v.state });
  }

  async function runSubmitJob(project, v, absFiles) {
    const root = project.folder;
    let lastPush = 0;
    const throttledPush = () => {
      const t = Date.now();
      if (t - lastPush > 700) { lastPush = t; pushProgress(v); }
    };
    try {
      v.progress.totalBytes = absFiles.reduce((s, f) => s + f.size, 0);
      v.progress.copiedBytes = 0;
      for (const f of absFiles) {
        v.progress.currentFile = f.rel;
        pushProgress(v);
        const dst = snapshotPath(v, f.rel);
        await copyFileWithProgress(f.abs, dst, n => { v.progress.copiedBytes += n; throttledPush(); });
        const sha = await sha256File(dst);
        const st = await fsp.stat(dst);
        v.files.push({ path: f.rel, size: st.size, sha256: sha, kind: kindOf(f.rel) });
        v.totalBytes += st.size;
      }
      v.state = 'ready';
      v.error = null;
      db.recomputeApproval(v);
      await db.saveProjects();
      pushProgress(v);
      hub.send('creator', 'version-ready', { projectId: project.id, versionId: v.id });
      for (const did of v.assignedDevices) {
        hub.send(`device:${did}`, 'task-assigned', { projectId: project.id, projectName: project.name, versionId: v.id, num: v.num });
      }
    } catch (e) {
      v.state = 'failed';
      v.error = e.code === 'ENOSPC' ? '磁盘空间不足，快照未能完整保存' : `快照失败：${e.message}`;
      await db.saveProjects();
      pushProgress(v);
    } finally {
      jobs.delete(v.id);
    }
  }

  // ---------- 交付 ----------
  async function createDelivery(versionId, receiverId) {
    const found = findVersion(versionId);
    if (!found) return { err: ['not_found', '版本不存在', 404] };
    const { p: project, v } = found;
    if (v.state !== 'ready') return { err: ['not_ready', '版本尚未完成快照，无法交付', 409] };
    if (!v.approvable) return { err: ['not_approved', '该版本尚未获得全部审核通过，不能正式交付', 409] };
    const receiver = db.deviceById(receiverId);
    if (!receiver || receiver.revoked) return { err: ['no_receiver', '接收设备不存在或已被取消授权', 404] };
    if (receiver.role !== 'receiver') return { err: ['wrong_role', '该设备不是接收设备', 409] };
    if (!receiver.online) return { err: ['offline', '接收设备当前不在线，请先在接收电脑上打开接收页面', 409] };
    const busy = db.deliveries.find(d => d.receiverId === receiverId && ACTIVE_DELIVERY.has(d.state));
    if (busy) return { err: ['busy', '该接收设备有一笔交付尚未完成，请先处理', 409] };

    const delivery = {
      id: randomId('dlv'), projectId: project.id, projectName: project.name,
      versionId: v.id, versionNum: v.num,
      receiverId, receiverName: receiver.name,
      state: 'pending', error: null,
      files: v.files.map(f => ({ path: f.path, size: f.size, sha256: f.sha256, state: 'pending', error: null })),
      totalBytes: v.totalBytes,
      createdAt: now(), startedAt: null, finishedAt: null,
      savedDirName: null,
    };
    db.deliveries.push(delivery);
    v.deliveries.push(delivery.id);
    await db.saveDeliveries();
    await db.saveProjects();
    hub.send(`device:${receiverId}`, 'delivery-new', { deliveryId: delivery.id });
    hub.send('creator', 'delivery-updated', { deliveryId: delivery.id });
    return { delivery };
  }

  function deliveryPublic(d) {
    return { ...d };
  }

  // ---------- 路由主体 ----------
  return async function route(req, res) {
    const { pathname, query } = parseUrl(req);
    const method = req.method || 'GET';

    try {
      // ============ 服务器信息（配对前公开，不含任何业务数据） ============
      if (pathname === '/api/server-info' && method === 'GET') {
        return ok(res, { server: serverInfo });
      }

      // ============ 配对（公开，限速） ============
      if (pathname === '/api/pair' && method === 'POST') {
        if (db.pairing.lockedUntil > now()) return fail(res, 429, 'locked', '尝试次数过多，请等待 1 分钟后再试');
        const body = await readJsonBody(req);
        if (String(body.code || '').trim() !== db.pairing.code) {
          db.pairing.failCount++;
          if (db.pairing.failCount >= 5) {
            db.pairing.lockedUntil = now() + 60_000;
            db.pairing.failCount = 0;
          }
          return fail(res, 403, 'bad_code', '连接码不正确，请对照创作者页面上的 6 位连接码');
        }
        db.pairing.failCount = 0;
        const role = body.role === 'receiver' ? 'receiver' : 'reviewer';
        const name = sanitizePart(body.name) || (role === 'receiver' ? '接收电脑' : '审核设备');
        const dv = db.addDevice(name, role);
        await db.saveDevices();
        hub.send('creator', 'device-paired', { device: devicePublic(dv) });
        return ok(res, { deviceId: dv.id, token: dv.token, name: dv.name, role: dv.role });
      }

      // ============ 设备接口（Bearer token） ============
      if (pathname.startsWith('/api/d/')) {
        const dv = requireDevice(req);
        if (!dv) return fail(res, 401, 'unauthorized', '设备未配对或授权已被取消，请重新连接');
        touch(dv);

        if (pathname === '/api/d/me' && method === 'GET') {
          return ok(res, { device: devicePublic(dv), server: serverInfo });
        }

        if (pathname === '/api/d/events' && method === 'GET') {
          const id = hub.add(res, 'device', dv.id);
          dv.online = true; dv.lastSeenAt = now();
          await db.saveDevices();
          hub.send('creator', 'device-online', { device: devicePublic(dv) });
          req.on('close', async () => {
            hub.remove(id);
            setTimeout(() => {
              if (!hub.hasDevice(dv.id) && dv.online) {
                dv.online = false;
                db.saveDevices();
                hub.send('creator', 'device-offline', { device: devicePublic(dv) });
              }
            }, 3000);
          });
          return;
        }

        if (pathname === '/api/d/tasks' && method === 'GET') {
          const tasks = [];
          for (const p of db.projects) {
            for (const v of p.versions) {
              if (v.state !== 'ready' || !v.assignedDevices.includes(dv.id)) continue;
              const my = v.decisions[dv.id] || {};
              tasks.push({
                projectId: p.id, projectName: p.name,
                versionId: v.id, num: v.num, note: v.note, createdAt: v.createdAt,
                files: v.files.map(f => ({ path: f.path, size: f.size, kind: f.kind })),
                myDecisions: Object.fromEntries(Object.entries(my).map(([k, x]) => [k, x.decision])),
                approvalStats: v.approvalStats,
                comments: v.comments,
                totalBytes: v.totalBytes,
              });
            }
          }
          tasks.sort((a, b) => b.createdAt - a.createdAt);
          return ok(res, { tasks });
        }

        if (pathname === '/api/d/decision' && method === 'POST') {
          const body = await readJsonBody(req);
          const found = findVersion(String(body.versionId || ''));
          if (!found) return fail(res, 404, 'not_found', '任务不存在');
          const { p: project, v } = found;
          if (!v.assignedDevices.includes(dv.id)) return fail(res, 403, 'forbidden', '该任务未分配给此设备');
          if (v.state !== 'ready') return fail(res, 409, 'not_ready', '版本尚未就绪');
          const rel = safeRel(String(body.path || ''));
          if (!rel || !v.files.some(f => f.path === rel)) return fail(res, 404, 'bad_path', '文件不存在于该版本');
          const decision = body.decision === 'approve' ? 'approve' : 'reject';
          v.decisions[dv.id] = v.decisions[dv.id] || {};
          v.decisions[dv.id][rel] = { decision, at: now() };
          db.recomputeApproval(v);
          await db.saveProjects();
          hub.send('creator', 'review-updated', { projectId: project.id, versionId: v.id, deviceId: dv.id });
          return ok(res, { approvable: v.approvable, approvalStats: v.approvalStats });
        }

        if (pathname === '/api/d/comment' && method === 'POST') {
          const body = await readJsonBody(req);
          const found = findVersion(String(body.versionId || ''));
          if (!found) return fail(res, 404, 'not_found', '任务不存在');
          const { p: project, v } = found;
          if (!v.assignedDevices.includes(dv.id)) return fail(res, 403, 'forbidden', '该任务未分配给此设备');
          const rel = safeRel(String(body.path || ''));
          if (!rel || !v.files.some(f => f.path === rel)) return fail(res, 404, 'bad_path', '文件不存在于该版本');
          const text = String(body.text || '').trim().slice(0, 2000);
          const timecodeMs = Number.isFinite(body.timecodeMs) ? Math.max(0, Math.floor(body.timecodeMs)) : null;
          if (!text) return fail(res, 400, 'empty', '评论内容不能为空');
          const c = { id: randomId('cmt'), deviceId: dv.id, deviceName: dv.name, path: rel, timecodeMs, text, at: now() };
          v.comments.push(c);
          await db.saveProjects();
          hub.send('creator', 'comment-added', { projectId: project.id, versionId: v.id, comment: c });
          return ok(res, { comment: c });
        }

        if (pathname === '/api/d/file' && method === 'GET') {
          const vid = String(query.get('vid') || '');
          const found = findVersion(vid);
          if (!found || found.v.state !== 'ready') return fail(res, 404, 'not_found', '版本不存在');
          if (!found.v.assignedDevices.includes(dv.id)) return fail(res, 403, 'forbidden', '无权访问该版本');
          const rel = safeRel(String(query.get('p') || ''));
          if (!rel) return fail(res, 400, 'bad_path', '路径不合法');
          const abs = snapshotPath(found.v, rel);
          const dl = query.get('download') === '1' ? path.basename(rel) : null;
          return sendVersionFile(req, res, abs, { downloadName: dl });
        }

        if (pathname === '/api/d/delivery' && method === 'GET') {
          const active = db.deliveries.find(d => d.receiverId === dv.id && ACTIVE_DELIVERY.has(d.state)) || null;
          const lastDone = [...db.deliveries].reverse().find(d => d.receiverId === dv.id && !ACTIVE_DELIVERY.has(d.state) && now() - (d.finishedAt || d.createdAt) < 10 * 60_000) || null;
          return ok(res, {
            active: active ? deliveryPublic(active) : null,
            lastFinished: lastDone ? deliveryPublic(lastDone) : null,
          });
        }

        if (pathname === '/api/d/delivery/progress' && method === 'POST') {
          const body = await readJsonBody(req);
          const d = db.deliveries.find(x => x.id === String(body.deliveryId || '') && x.receiverId === dv.id);
          if (!d || !ACTIVE_DELIVERY.has(d.state)) return fail(res, 409, 'no_active', '当前没有进行中的交付');
          const i = parseInt(body.i, 10);
          const f = d.files[i];
          if (!f) return fail(res, 404, 'bad_index', '文件序号不合法');
          if (body.started) {
            // 只推进交付状态，不改文件结果
          } else if (body.ok) { f.state = 'ok'; f.error = null; } else { f.state = 'failed'; f.error = String(body.error || '接收失败').slice(0, 300); }
          if (!d.startedAt) d.startedAt = now();
          d.state = 'transferring';
          await db.saveDeliveries();
          hub.send('creator', 'delivery-updated', { deliveryId: d.id });
          return ok(res);
        }

        if (pathname === '/api/d/delivery/complete' && method === 'POST') {
          const body = await readJsonBody(req);
          const d = db.deliveries.find(x => x.id === String(body.deliveryId || '') && x.receiverId === dv.id);
          if (!d || !ACTIVE_DELIVERY.has(d.state)) return fail(res, 409, 'no_active', '当前没有进行中的交付');
          const okCount = d.files.filter(f => f.state === 'ok').length;
          d.state = okCount === d.files.length ? 'completed' : 'partial';
          d.finishedAt = now();
          d.savedDirName = String(body.savedDirName || '').slice(0, 300) || null;
          if (okCount !== d.files.length) d.error = '部分文件未成功接收，可在接收端逐个重试';
          await db.saveDeliveries();
          hub.send('creator', 'delivery-updated', { deliveryId: d.id });
          return ok(res, { state: d.state });
        }

        if (pathname === '/api/d/delivery/cancel-by-receiver' && method === 'POST') {
          const body = await readJsonBody(req);
          const d = db.deliveries.find(x => x.id === String(body.deliveryId || '') && x.receiverId === dv.id);
          if (!d || !ACTIVE_DELIVERY.has(d.state)) return fail(res, 409, 'no_active', '当前没有进行中的交付');
          d.state = 'cancelled';
          d.finishedAt = now();
          d.error = `接收端取消了本次交付（${String(body.reason || '手动取消').slice(0, 100)}）`;
          await db.saveDeliveries();
          hub.send('creator', 'delivery-updated', { deliveryId: d.id });
          return ok(res);
        }

        if (pathname === '/api/d/delivery-file' && method === 'GET') {
          if (!isHttps(req)) return fail(res, 403, 'https_required', '正式交付文件必须通过安全通道（HTTPS 地址）接收');
          const d = db.deliveries.find(x => x.receiverId === dv.id && ACTIVE_DELIVERY.has(x.state));
          if (!d) return fail(res, 409, 'no_active', '当前没有进行中的交付');
          const i = parseInt(query.get('i') || '', 10);
          const f = d.files[i];
          if (!f) return fail(res, 404, 'bad_index', '文件序号不合法');
          const found = findVersion(d.versionId);
          if (!found) return fail(res, 404, 'not_found', '版本快照缺失');
          return sendVersionFile(req, res, snapshotPath(found.v, f.path), { mime: 'application/octet-stream' });
        }

        return fail(res, 404, 'no_route', '接口不存在');
      }

      // ============ 创作者接口（仅主机本机可访问） ============
      if (pathname.startsWith('/api/c/')) {
        if (!isLoopback(req)) {
          return fail(res, 403, 'host_only', '创作者页面请在本机浏览器打开：服务器终端里显示的 http://localhost 地址');
        }

        if (pathname === '/api/c/state' && method === 'GET') {
          return ok(res, {
            firstRun: !db.workspace,
            workspace: db.workspace,
            pairCode: db.pairing.code,
            server: serverInfo,
            devices: db.devices.filter(d => !d.revoked).map(devicePublic),
            projects: db.projects.map(p => ({
              id: p.id, name: p.name, folder: p.folder, brand: p.brand, dateLabel: p.dateLabel,
              createdAt: p.createdAt, currentVersionId: p.currentVersionId,
              versions: p.versions.map(versionFull),
            })),
            deliveries: db.deliveries.map(deliveryPublic),
          });
        }

        if (pathname === '/api/c/fs' && method === 'GET') {
          const dir = query.get('path') || '';
          try {
            const listing = await listDirForPick(dir);
            return ok(res, listing);
          } catch (e) {
            return fail(res, 400, 'bad_dir', `无法读取该目录：${e.message}`);
          }
        }

        if (pathname === '/api/c/fs/mkdir' && method === 'POST') {
          const body = await readJsonBody(req);
          const p = String(body.path || '');
          if (!p) return fail(res, 400, 'bad_path', '路径不能为空');
          try {
            await fsp.mkdir(p, { recursive: true });
            return ok(res, { path: p });
          } catch (e) {
            return fail(res, 400, 'mkdir_failed', `创建文件夹失败：${e.message}`);
          }
        }

        if (pathname === '/api/c/workspace' && method === 'POST') {
          const body = await readJsonBody(req);
          const ws = String(body.path || '').trim();
          if (!ws) return fail(res, 400, 'bad_path', '请选择工作区文件夹');
          try {
            const st = await fsp.stat(ws);
            if (!st.isDirectory()) return fail(res, 400, 'not_dir', '所选路径不是文件夹');
          } catch {
            return fail(res, 400, 'not_found', '文件夹不存在，请先在上方创建或选择已有文件夹');
          }
          try {
            await db.loadWorkspace(ws);
            const { writeLastWorkspace } = await import('./store.js');
            await writeLastWorkspace(ws);
          } catch (e) {
            return fail(res, 500, 'load_failed', `工作区初始化失败：${e.message}`);
          }
          hub.send('creator', 'workspace-ready', {});
          return ok(res, { workspace: ws });
        }

        if (pathname === '/api/c/workspace/open' && method === 'POST') {
          if (!db.workspace) return fail(res, 409, 'no_workspace', '尚未选择工作区');
          openInFileManager(db.workspace);
          return ok(res);
        }

        if (pathname === '/api/c/pair/regenerate' && method === 'POST') {
          const { sixDigitCode } = await import('./media.js');
          db.pairing.code = sixDigitCode();
          db.pairing.updatedAt = now();
          db.pairing.failCount = 0;
          db.pairing.lockedUntil = 0;
          await db.savePairing();
          hub.send('creator', 'pair-code-changed', { code: db.pairing.code });
          return ok(res, { code: db.pairing.code });
        }

        if (pathname === '/api/c/device/revoke' && method === 'POST') {
          const body = await readJsonBody(req);
          const dv = db.deviceById(String(body.id || ''));
          if (!dv) return fail(res, 404, 'not_found', '设备不存在');
          dv.revoked = true;
          dv.online = false;
          await db.saveDevices();
          hub.send('creator', 'device-revoked', { deviceId: dv.id });
          return ok(res);
        }

        if (pathname === '/api/c/project' && method === 'POST') {
          const body = await readJsonBody(req);
          if (!db.workspace) return fail(res, 409, 'no_workspace', '请先选择工作区');
          const date = sanitizePart(body.date, 10);
          const brand = sanitizePart(body.brand);
          const name = sanitizePart(body.name);
          if (!date || !name) return fail(res, 400, 'bad_input', '日期和项目名称必须填写（品牌可选）');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 'bad_date', '日期格式应为 2026-09-13');
          const parts = [date, brand, name].filter(Boolean);
          const folderName = parts.join('_');
          const folderAbs = path.join(db.workspace, folderName);
          const registered = db.projectByFolder(folderAbs);
          if (registered) return fail(res, 409, 'already_registered', '同名项目已存在，已在项目列表中', { projectId: registered.id });
          let exists = false;
          try { exists = (await fsp.stat(folderAbs)).isDirectory(); } catch { /* 不存在 */ }
          if (exists && !body.useExisting) {
            return fail(res, 409, 'folder_exists', `工作区里已有同名文件夹「${folderName}」`, {
              choices: ['use_existing', 'rename'],
            });
          }
          if (!exists) {
            try { await fsp.mkdir(folderAbs, { recursive: true }); } catch (e) {
              return fail(res, 500, 'mkdir_failed', `创建项目文件夹失败：${e.message}`);
            }
          }
          const p = db.newProject(folderAbs, brand, name, date);
          await db.saveProjects();
          return ok(res, { project: p });
        }

        if (pathname === '/api/c/project/import' && method === 'POST') {
          const body = await readJsonBody(req);
          if (!db.workspace) return fail(res, 409, 'no_workspace', '请先选择工作区');
          const folderName = safeRel(String(body.folder || ''));
          if (!folderName || folderName.includes('/')) return fail(res, 400, 'bad_name', '请从列表中选择文件夹');
          const folderAbs = path.join(db.workspace, folderName);
          let isDir = false;
          try { isDir = (await fsp.stat(folderAbs)).isDirectory(); } catch { /* 不存在 */ }
          if (!isDir) return fail(res, 404, 'not_found', '该文件夹不存在');
          if (folderName === '.lan-review') return fail(res, 400, 'bad_name', '不能使用系统数据文件夹');
          if (db.projectByFolder(folderAbs)) return fail(res, 409, 'already_registered', '该文件夹已是项目');
          const seg = folderName.split('_');
          const dateLabel = /^\d{4}-\d{2}-\d{2}$/.test(seg[0] || '') ? seg[0] : '';
          const brand = seg.length >= 3 ? seg[1] : '';
          const name = seg.slice(dateLabel ? 1 : 0).slice(brand ? 1 : 0).join('_') || folderName;
          const p = db.newProject(folderAbs, brand, name, dateLabel);
          await db.saveProjects();
          return ok(res, { project: p });
        }

        if (pathname === '/api/c/project/open' && method === 'POST') {
          const body = await readJsonBody(req);
          const p = db.projectById(String(body.id || ''));
          if (!p) return fail(res, 404, 'not_found', '项目不存在');
          openInFileManager(p.folder);
          return ok(res);
        }

        if (pathname === '/api/c/submit' && method === 'POST') {
          const body = await readJsonBody(req);
          const p = db.projectById(String(body.projectId || ''));
          if (!p) return fail(res, 404, 'not_found', '项目不存在');
          const paths = Array.isArray(body.paths) ? body.paths.map(x => safeRel(String(x))).filter(Boolean) : [];
          if (paths.length === 0) return fail(res, 400, 'empty', '请至少选择一个待审文件或文件夹');
          const deviceIds = Array.isArray(body.deviceIds) ? body.deviceIds.map(String) : [];
          const reviewers = deviceIds.map(id => db.deviceById(id)).filter(d => d && !d.revoked && d.role === 'reviewer');
          if (reviewers.length === 0) return fail(res, 400, 'no_reviewer', '请至少选择一台在线或已配对的审核设备');

          // 展开文件夹 → 文件清单
          const seen = new Set();
          const absFiles = [];
          try {
            for (const rel of paths) {
              const abs = path.join(p.folder, ...rel.split('/'));
              const st = await fsp.stat(abs);
              if (st.isDirectory()) {
                const all = await walkFiles(p.folder, rel);
                for (const r of all) {
                  if (r.split('/').some(seg => seg.startsWith('.'))) continue; // 跳过隐藏文件
                  if (seen.has(r)) continue;
                  seen.add(r);
                  absFiles.push({ rel: r, abs: path.join(p.folder, ...r.split('/')), size: (await fsp.stat(path.join(p.folder, ...r.split('/')))).size });
                }
              } else {
                if (seen.has(rel)) continue;
                seen.add(rel);
                absFiles.push({ rel, abs, size: st.size });
              }
            }
          } catch (e) {
            return fail(res, 409, 'read_failed', `读取待审文件失败：${e.message}`);
          }
          if (absFiles.length === 0) return fail(res, 400, 'empty_after_expand', '所选内容里没有可用文件（隐藏文件会被跳过）');

          const v = db.newVersion(p, String(body.note || '').slice(0, 200));
          v.assignedDevices = reviewers.map(d => d.id);
          v.progress.totalBytes = absFiles.reduce((s, f) => s + f.size, 0);
          await db.saveProjects();
          jobs.set(v.id, true);
          runSubmitJob(p, v, absFiles); // 异步执行，前端通过轮询/SSE 看进度
          return ok(res, { versionId: v.id, num: v.num, fileCount: absFiles.length });
        }

        if (pathname === '/api/c/project-tree' && method === 'GET') {
          const p = db.projectById(String(query.get('projectId') || ''));
          if (!p) return fail(res, 404, 'not_found', '项目不存在');
          const rawDir = String(query.get('dir') || '');
          const dir = rawDir === '' ? '' : safeRel(rawDir);
          if (dir === null) return fail(res, 400, 'bad_path', '路径不合法');
          const abs = path.join(p.folder, ...dir.split('/'));
          let items = [];
          try { items = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) {
            return fail(res, 409, 'read_failed', `无法读取项目文件夹：${e.message}`);
          }
          const entries = [];
          for (const it of items) {
            if (it.name.startsWith('.')) continue;
            if (it.isSymbolicLink()) continue;
            const rel = dir ? `${dir}/${it.name}` : it.name;
            if (it.isDirectory()) {
              entries.push({ name: it.name, rel, type: 'dir', size: 0, kind: 'dir' });
            } else if (it.isFile()) {
              let size = 0;
              try { size = (await fsp.stat(path.join(p.folder, ...rel.split('/')))).size; } catch { /* 忽略 */ }
              entries.push({ name: it.name, rel, type: 'file', size, kind: kindOf(it.name) });
            }
          }
          entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1));
          return ok(res, { dir, entries });
        }

        if (pathname === '/api/c/file' && method === 'GET') {
          const found = findVersion(String(query.get('vid') || ''));
          if (!found || found.v.state !== 'ready') return fail(res, 404, 'not_found', '版本不存在');
          const rel = safeRel(String(query.get('p') || ''));
          if (!rel) return fail(res, 400, 'bad_path', '路径不合法');
          const dl = query.get('download') === '1' ? path.basename(rel) : null;
          return sendVersionFile(req, res, snapshotPath(found.v, rel), { downloadName: dl });
        }

        if (pathname === '/api/c/deliver' && method === 'POST') {
          const body = await readJsonBody(req);
          const r = await createDelivery(String(body.versionId || ''), String(body.receiverId || ''));
          if (r.err) return fail(res, r.err[2], r.err[0], r.err[1]);
          return ok(res, { delivery: deliveryPublic(r.delivery) });
        }

        if (pathname.startsWith('/api/c/delivery/') && method === 'POST') {
          const body = await readJsonBody(req).catch(() => ({}));
          const rest = pathname.slice('/api/c/delivery/'.length);
          const d = db.deliveries.find(x => x.id === rest.split('/')[0]);
          if (!d) return fail(res, 404, 'not_found', '交付记录不存在');
          if (rest.endsWith('/cancel')) {
            if (!ACTIVE_DELIVERY.has(d.state)) return fail(res, 409, 'not_active', '该交付已结束');
            d.state = 'cancelled';
            d.finishedAt = now();
            d.error = '创作者取消了本次交付';
            await db.saveDeliveries();
            hub.send(`device:${d.receiverId}`, 'delivery-cancelled', { deliveryId: d.id });
            hub.send('creator', 'delivery-updated', { deliveryId: d.id });
            return ok(res);
          }
          if (rest.endsWith('/restart')) {
            const r = await createDelivery(d.versionId, d.receiverId);
            if (r.err) return fail(res, r.err[2], r.err[0], r.err[1]);
            return ok(res, { delivery: deliveryPublic(r.delivery) });
          }
          return fail(res, 404, 'no_route', '接口不存在');
        }

        if (pathname === '/api/c/events' && method === 'GET') {
          const id = hub.add(res, 'creator');
          req.on('close', () => hub.remove(id));
          return;
        }

        return fail(res, 404, 'no_route', '接口不存在');
      }

      // ============ 静态页面 ============
      if (method === 'GET' || method === 'HEAD') {
        if (pathname === '/' || pathname === '/index.html') {
          if (!isLoopback(req)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><meta charset="utf-8"><title>提审台</title><body style="font-family:sans-serif;background:#f5f6fa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;color:#333"><h2>这是创作者主机页面</h2><p>请在创作者电脑本机打开 <a href="http://localhost:${serverInfo.httpPort}/">http://localhost:${serverInfo.httpPort}/</a></p><p>审核或接收文件？请打开连接页 <a href="/join">/join</a></p></div></body>`);
            return;
          }
          return serveStatic(res, 'index.html');
        }
        if (pathname === '/join' || pathname === '/device.html') return serveStatic(res, 'device.html');
        if (pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname.startsWith('/vendor/') || pathname === '/favicon.svg') {
          return serveStatic(res, pathname.slice(1));
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (e) {
      console.error('[api]', method, pathname, e);
      if (!res.headersSent) fail(res, 500, 'server_error', `服务器内部错误：${e.message}`);
      else res.end();
    }
  };
}
