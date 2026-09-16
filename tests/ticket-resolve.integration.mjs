import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

if (process.env.TICKET_RESOLVE_LIVE_TEST !== '1' || !process.env.MEC_BASE_URL) {
  console.log('skipped: set TICKET_RESOLVE_LIVE_TEST=1 and MEC_BASE_URL to run');
  process.exit(0);
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'seating-studio-resolve-'));
const authFile = path.join(temporaryRoot, 'auth.htpasswd');
const dataFile = path.join(temporaryRoot, 'workspaces.json');
const port = 18791;
const base = `http://127.0.0.1:${port}`;
await mkdir(temporaryRoot, { recursive: true });
await writeFile(authFile, `qa-user:${bcrypt.hashSync('qa-password', 10)}\n`);
await writeFile(dataFile, JSON.stringify({ currentWorkspaceId: 'resolve-event', workspaces: [{ id: 'resolve-event', details: { name: 'Gala', mecEventId: '' }, tables: [], campaign: {}, guests: [] }] }));
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), AUTH_FILE: authFile, DATA_FILE: dataFile, SESSION_SECRET: 'integration-test-session-secret-that-is-long-enough', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe']
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Test API did not start');
  assert.equal((await fetch(`${base}/api/check-in/resolve-ticket?key=stTESTKEY01`)).status, 401, 'resolver requires a signed-in staff session');
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: 'http://localhost:4173', 'Content-Type': 'application/json', 'X-Seating-Request': '1' }, body: JSON.stringify({ username: 'qa-user', password: 'qa-password' }) });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const headers = { Cookie: cookie, Accept: 'application/json' };
  assert.equal((await fetch(`${base}/api/check-in/resolve-ticket?key=bad%20key`, { headers })).status, 400);
  const live = await fetch(`${base}/api/check-in/resolve-ticket?key=stTESTKEY01`, { headers });
  const payload = await live.json();
  assert.equal(live.status, 200, `live resolution failed: ${JSON.stringify(payload)}`);
  assert.match(payload.invoiceKey, /^[0-9a-f]{40}$/, 'resolver must return the 40-character invoice hash');
  const unknown = await fetch(`${base}/api/check-in/resolve-ticket?key=not-a-real-ticket-0000`, { headers });
  assert.equal(unknown.status, 404);
  console.log(`Integration passed: ticket resolver requires auth, validates keys, resolves a live short key to hash ${payload.invoiceKey.slice(0, 8)}... and rejects unknown keys.`);
} finally {
  child.kill();
  await rm(temporaryRoot, { recursive: true, force: true });
}
