// store.js —— 工作区数据持久化（JSON 原子写），全部数据重启可恢复
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomId, randomToken, sixDigitCode } from './media.js';

// 服务自身配置放用户主目录（记住上次选择的工作区）
export function homeDir() {
  return process.env.LAN_REVIEW_HOME || path.join(os.homedir(), '.lan-review');
}
export async function readLastWorkspace() {
  try {
    const raw = await fsp.readFile(path.join(homeDir(), 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && cfg.lastWorkspace && typeof cfg.lastWorkspace === 'string') return cfg.lastWorkspace;
  } catch { /* 首次使用 */ }
  return null;
}
export async function writeLastWorkspace(ws) {
  await fsp.mkdir(homeDir(), { recursive: true });
  await atomicWrite(path.join(homeDir(), 'config.json'), { lastWorkspace: ws });
}

export async function atomicWrite(fp, obj) {
  const tmp = `${fp}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, fp); // 同目录 rename，原子替换
}

export class DB {
  constructor(dataDir) {
    this.dataDir = dataDir; // <工作区>/.lan-review，未选工作区时为 null
    this.versionsDir = dataDir ? path.join(dataDir, 'versions') : null;
    this.certsDir = dataDir ? path.join(dataDir, 'certs') : null;
    // 内存态
    this.workspace = null;   // 工作区绝对路径
    this.pairing = { code: sixDigitCode(), updatedAt: Date.now(), failCount: 0, lockedUntil: 0 };
    this.devices = [];       // {id,name,role,token,pairedAt,lastSeenAt,online,revoked}
    this.projects = [];      // {id,name,folder,brand,dateLabel,createdAt,currentVersionId,versions:[...]}
    this.deliveries = [];    // {id,...}
    this.loaded = false;
  }

  filePath(name) { return path.join(this.dataDir, name); }

  async loadWorkspace(ws) {
    this.workspace = ws;
    this.dataDir = path.join(ws, '.lan-review');
    this.versionsDir = path.join(this.dataDir, 'versions');
    this.certsDir = path.join(this.dataDir, 'certs');
    await fsp.mkdir(this.versionsDir, { recursive: true });
    await fsp.mkdir(this.certsDir, { recursive: true });
    await Promise.all([
      this._load('devices.json', d => { this.devices = (d && d.devices) || []; }),
      this._load('projects.json', d => { this.projects = (d && d.projects) || []; }),
      this._load('deliveries.json', d => { this.deliveries = (d && d.deliveries) || []; }),
      this._load('pairing.json', d => {
        if (d && d.code) this.pairing = { code: d.code, updatedAt: d.updatedAt || Date.now(), failCount: 0, lockedUntil: 0 };
      }),
    ]);
    // 重启后设备一律先视为离线，等 SSE 重连
    for (const dv of this.devices) { dv.online = false; }
    this.loaded = true;
    await this.savePairing();
  }

  async _load(name, apply) {
    try {
      const raw = await fsp.readFile(this.filePath(name), 'utf8');
      apply(JSON.parse(raw));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  async saveDevices() { await atomicWrite(this.filePath('devices.json'), { devices: this.devices }); }
  async saveProjects() { await atomicWrite(this.filePath('projects.json'), { projects: this.projects }); }
  async saveDeliveries() { await atomicWrite(this.filePath('deliveries.json'), { deliveries: this.deliveries }); }
  async savePairing() { await atomicWrite(this.filePath('pairing.json'), { code: this.pairing.code, updatedAt: this.pairing.updatedAt }); }

  // ---- 设备 ----
  deviceByToken(token) {
    if (!token) return null;
    return this.devices.find(d => d.token === token && !d.revoked) || null;
  }
  deviceById(id) { return this.devices.find(d => d.id === id) || null; }
  addDevice(name, role) {
    const dv = {
      id: randomId('dev'), name: String(name).slice(0, 40), role, token: randomToken(),
      pairedAt: Date.now(), lastSeenAt: 0, online: false, revoked: false,
    };
    this.devices.push(dv);
    return dv;
  }

  // ---- 项目与版本 ----
  projectById(id) { return this.projects.find(p => p.id === id) || null; }
  projectByFolder(folder) {
    const norm = path.normalize(folder).toLowerCase();
    return this.projects.find(p => path.normalize(p.folder).toLowerCase() === norm) || null;
  }
  versionById(project, vid) { return project.versions.find(v => v.id === vid) || null; }

  newProject(folder, brand, name, dateLabel) {
    const p = {
      id: randomId('prj'), name, folder, brand, dateLabel,
      createdAt: Date.now(), currentVersionId: null, versions: [],
    };
    this.projects.push(p);
    return p;
  }

  nextVersionNum(project) {
    return `V${String(project.versions.length + 1).padStart(2, '0')}`;
  }

  newVersion(project, note) {
    const v = {
      id: randomId('ver'), num: this.nextVersionNum(project), note: note || '',
      createdAt: Date.now(), state: 'preparing', error: null,
      files: [], totalBytes: 0,
      assignedDevices: [],
      decisions: {},   // deviceId -> { relpath -> {decision:'approve'|'reject', at} }
      comments: [],    // {id,deviceId,deviceName,path,timecodeMs,text,at}
      approvable: false,
      approvalStats: { decidedDevices: 0, totalDevices: 0 },
      progress: { copiedBytes: 0, totalBytes: 0, currentFile: '' },
      deliveries: [],
    };
    project.versions.push(v);
    project.currentVersionId = v.id;
    return v;
  }

  // ---- 审核 —— 计算「可交付」：所有指派设备对所有文件都给出“通过” ----
  recomputeApproval(v) {
    const files = v.files.map(f => f.path);
    let decidedDevices = 0;
    let ok = v.assignedDevices.length > 0 && files.length > 0;
    for (const did of v.assignedDevices) {
      const dec = v.decisions[did] || {};
      let decidedAll = files.length > 0;
      let allApproved = files.length > 0;
      for (const p of files) {
        const d = dec[p];
        if (!d) { decidedAll = false; allApproved = false; break; }
        if (d.decision !== 'approve') allApproved = false;
      }
      if (decidedAll && allApproved) decidedDevices++;
      if (!decidedAll || !allApproved) ok = false;
    }
    v.approvable = ok;
    v.approvalStats = { decidedDevices, totalDevices: v.assignedDevices.length };
  }
}
