// main.js —— 提审台入口：启动 HTTP（审核/预览）+ HTTPS（正式交付通道）
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { lanIPv4s, ensureCert } from './net.js';
import { DB, readLastWorkspace, homeDir } from './store.js';
import { SSEHub } from './core.js';
import { createApi } from './api.js';

const HTTP_PORT = parseInt(process.env.LAN_REVIEW_HTTP_PORT || '8456', 10);
const HTTPS_PORT = parseInt(process.env.LAN_REVIEW_HTTPS_PORT || '8457', 10);

function listenOn(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server.address().port));
  });
}

async function main() {
  const ips = lanIPv4s().map(x => x.ip);
  const db = new DB(null);
  const hub = new SSEHub();

  // 上次工作区自动恢复
  let lastWs = null;
  try { lastWs = await readLastWorkspace(); } catch { /* ignore */ }
  if (lastWs) {
    try { await db.loadWorkspace(lastWs); } catch (e) {
      console.log(`[提审台] 上次工作区不可用（${e.message}），将在页面中重新选择。`);
      db.workspace = null;
    }
  }

  // 自签证书（正式交付的安全通道），存用户主目录：换工作区无需重新信任
  let httpsServer = null;
  let httpsPort = null;
  try {
    const certsDir = path.join(homeDir(), 'certs');
    const { key, cert } = await ensureCert(certsDir, ips);
    httpsServer = https.createServer({ key, cert }, null);
    httpsPort = await listenOn(httpsServer, HTTPS_PORT, 'https');
  } catch (e) {
    console.log(`[提审台] HTTPS 交付通道不可用（${e.message}）。正式交付功能将受限。`);
    httpsServer = null;
  }

  const serverInfo = {
    httpPort: null, httpsPort,
    ips,
    joinUrls: [],
    httpsJoinUrls: [],
    httpsAvailable: !!httpsServer,
  };

  const route = createApi(db, hub, serverInfo);
  const handler = (req, res) => route(req, res);

  const httpServer = http.createServer(handler);
  if (httpsServer) httpsServer.on('request', handler);

  const httpPort = await listenOn(httpServer, HTTP_PORT, 'http');
  serverInfo.httpPort = httpPort;
  serverInfo.joinUrls = ips.map(ip => `http://${ip}:${httpPort}/join`);
  serverInfo.joinUrls.unshift(`http://localhost:${httpPort}/join`);
  if (httpsServer) {
    serverInfo.httpsJoinUrls = ips.map(ip => `https://${ip}:${httpsPort}/join`);
  }
  hub.startHeartbeat();

  console.log('==========================================================');
  console.log('  提审台 · 局域网提审、审核与交付工具');
  console.log('==========================================================');
  console.log(`  创作者页面（本机）:  http://localhost:${httpPort}/`);
  console.log('  手机 / 笔记本连接页（同一 Wi-Fi / 局域网）:');
  for (const u of serverInfo.joinUrls) console.log(`    ${u}`);
  if (httpsServer) {
    console.log(`  接收电脑专用安全通道（正式交付）: https://<本机IP>:${httpsPort}/join`);
  }
  console.log(`  当前工作区: ${db.workspace || '（未选择，请在页面中选择）'}`);
  console.log('  关闭本窗口或按 Ctrl+C 即可停止服务。');
  console.log('==========================================================');

  if (process.env.LAN_REVIEW_NO_OPEN !== '1') {
    const url = `http://localhost:${httpPort}/`;
    setTimeout(() => {
      if (process.platform === 'darwin') import('node:child_process').then(cp => cp.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref());
      else import('node:child_process').then(cp => cp.spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref());
    }, 600);
  }

  const shutdown = () => process.exit(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => {
  console.error('[提审台] 启动失败：', e);
  process.exit(1);
});
