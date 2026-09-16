import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'seating-studio-qr-'));
const authFile = path.join(temporaryRoot, 'auth.htpasswd');
const dataFile = path.join(temporaryRoot, 'workspaces.json');
const port = 18790;
const base = `http://127.0.0.1:${port}`;
const secret = 'integration-test-session-secret-that-is-long-enough';
const sign = (value) => createHmac('sha256', secret).update(value).digest('base64url');
await mkdir(temporaryRoot, { recursive: true });
await writeFile(authFile, `qa-user:${bcrypt.hashSync('qa-password', 10)}\n`);
await writeFile(dataFile, JSON.stringify({ currentWorkspaceId: 'qr-event', workspaces: [{ id: 'qr-event', details: { name: 'Gala', mecEventId: '' }, tables: [{ id: 1, name: 'Table 01', capacity: 10, zone: 'Main' }], campaign: {}, guests: [
  { id: 'MEC-8648-0', name: 'Linked Guest', email: 'linked@example.test', bookingId: '8648', attendeeKey: '0', transactionId: 'stTESTKEY01', tableId: 1, source: 'mec' },
  { id: 'MANUAL-1', name: 'Manual Guest', email: 'manual@example.test', bookingId: '', attendeeKey: '', tableId: 1, source: 'manual' }
] }] }));

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), AUTH_FILE: authFile, DATA_FILE: dataFile, SESSION_SECRET: secret, NODE_ENV: 'test', TICKET_BASE_URL: 'https://shop.example.test/invoice/' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Test API did not start: ${stderr}`);
  const goodSignature = sign('ticket-qr:qr-event:MEC-8648-0');
  assert.equal((await fetch(`${base}/api/ticket-qr/qr-event/MEC-8648-0`)).status, 404, 'missing signature must be rejected');
  assert.equal((await fetch(`${base}/api/ticket-qr/qr-event/MEC-8648-0?s=${sign('ticket-qr:qr-event:other')}`)).status, 404, 'wrong signature must be rejected');
  assert.equal((await fetch(`${base}/api/ticket-qr/qr-event/MANUAL-1?s=${sign('ticket-qr:qr-event:MANUAL-1')}`)).status, 404, 'guests without a MEC transaction have no QR');
  const response = await fetch(`${base}/api/ticket-qr/qr-event/MEC-8648-0?s=${goodSignature}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
  const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.equal(decoded?.data, 'https://shop.example.test/invoice/stTESTKEY01', 'QR must encode the invoice link the check-in scanner matches');
  console.log('Integration passed: signed ticket QR endpoint rejects unsigned, mis-signed and unlinked requests and serves a scannable MEC invoice QR.');
} finally {
  child.kill();
  await rm(temporaryRoot, { recursive: true, force: true });
}
