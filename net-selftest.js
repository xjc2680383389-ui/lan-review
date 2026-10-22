// 运行 node --test net-selftest.js；仅在临时目录生成测试证书。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { ensureCert } from './server/net.js';

test('certificate generation works without OpenSSL on PATH on Windows and reuses the certificate', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lan-review-cert-test-'));
  const originalPath = process.env.PATH;
  try {
    if (process.platform === 'win32') process.env.PATH = '';
    const first = await ensureCert(dir, ['192.168.1.23']);
    assert.equal(first.generated, true);
    const cert = new X509Certificate(first.cert);
    assert.ok(cert.checkIP('127.0.0.1'));
    assert.ok(cert.checkIP('192.168.1.23'));
    assert.ok(cert.checkHost('localhost'));
    const second = await ensureCert(dir, ['192.168.1.23']);
    assert.equal(second.generated, false);
    assert.equal(second.cert, first.cert);
    assert.equal(second.key, first.key);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});
