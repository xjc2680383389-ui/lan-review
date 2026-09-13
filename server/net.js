// net.js —— 局域网地址枚举与自签 HTTPS 证书生成（交付通道用）
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pexec = promisify(execFile);

// 本机所有私有 IPv4（供设备连接提示）
export function lanIPv4s() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) {
        const ip = it.address;
        if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
          out.push({ ip, iface: name });
        } else {
          out.push({ ip, iface: name });
        }
      }
    }
  }
  return out;
}

function certConfig(cn, ips) {
  const alt = [
    'DNS.1=localhost',
    'DNS.2=lan-review.local',
    'IP.1=127.0.0.1',
    ...ips.map((ip, i) => `IP.${i + 2}=${ip}`),
  ].join('\n');
  return `[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = lan-review
[v3]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
${alt}
`;
}

// 证书已存在则复用；否则调用 openssl 生成（macOS / Git Bash / Linux 均自带）
export async function ensureCert(certsDir, ips) {
  const keyP = path.join(certsDir, 'key.pem');
  const certP = path.join(certsDir, 'cert.pem');
  try {
    const [key, cert] = await Promise.all([fsp.readFile(keyP), fsp.readFile(certP)]);
    return { key: key.toString(), cert: cert.toString(), generated: false };
  } catch { /* 首次生成 */ }

  const cfgP = path.join(certsDir, 'openssl.cnf');
  await fsp.mkdir(certsDir, { recursive: true });
  await fsp.writeFile(cfgP, certConfig('lan-review', ips), 'utf8');
  await pexec('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
    '-config', cfgP, '-keyout', keyP, '-out', certP,
  ], { windowsHide: true });
  const [key, cert] = await Promise.all([fsp.readFile(keyP), fsp.readFile(certP)]);
  return { key: key.toString(), cert: cert.toString(), generated: true };
}
