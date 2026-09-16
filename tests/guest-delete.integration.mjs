import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'seating-studio-delete-'));
const authFile = path.join(temporaryRoot, 'auth.htpasswd');
const dataFile = path.join(temporaryRoot, 'workspaces.json');
const port = 18792;
const base = `http://127.0.0.1:${port}`;
const origin = 'http://localhost:4173';
await mkdir(temporaryRoot, { recursive: true });
await writeFile(authFile, `qa-user:${bcrypt.hashSync('qa-password', 10)}\n`);
await writeFile(dataFile, JSON.stringify({ currentWorkspaceId: 'qa-event', workspaces: [{
  id: 'qa-event', details: { name: 'QA Event', defaultSeats: 10 }, campaign: {},
  tables: [{ id: 1, name: 'Table 01', capacity: 10, zone: 'Main floor' }],
  guests: [{ id: 'MEC-500-0', name: 'Booked Guest', email: 'booked@example.test', bookingId: '500', attendeeKey: '0', source: 'mec', tableId: 1 }]
}] }));
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

  assert.equal((await fetch(`${base}/api/workspaces/qa-event/guests/anything`, { method: 'DELETE', headers: { Origin: origin, 'X-Seating-Request': '1' } })).status, 401, 'delete requires a session');
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'X-Seating-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'qa-user', password: 'qa-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: origin, 'X-Seating-Request': '1', 'Content-Type': 'application/json' };
  const readWorkspace = async () => (await (await fetch(`${base}/api/workspaces`, { headers: { Cookie: cookie } })).json()).workspaces[0];

  const created = await fetch(`${base}/api/workspaces/qa-event/guests`, { method: 'POST', headers, body: JSON.stringify({ name: 'Walk In', email: 'walkin@example.test', tableId: 1 }) });
  assert.equal(created.status, 201);
  const manualId = (await created.json()).guest.id;
  const staleSnapshot = await readWorkspace();
  assert.ok(staleSnapshot.guests.some((guest) => guest.id === manualId));

  assert.equal((await fetch(`${base}/api/workspaces/qa-event/guests/${manualId}`, { method: 'DELETE', headers: { Cookie: cookie, 'X-Seating-Request': '1' } })).status, 403, 'delete requires the same-origin headers');
  const mecDelete = await fetch(`${base}/api/workspaces/qa-event/guests/MEC-500-0`, { method: 'DELETE', headers });
  assert.equal(mecDelete.status, 409, 'MEC guests cannot be deleted directly');
  assert.ok((await readWorkspace()).guests.some((guest) => guest.id === 'MEC-500-0'));

  const deleted = await fetch(`${base}/api/workspaces/qa-event/guests/${manualId}`, { method: 'DELETE', headers });
  assert.equal(deleted.status, 200);
  assert.deepEqual((await deleted.json()).deleted, { id: manualId, name: 'Walk In' });
  assert.ok(!(await readWorkspace()).guests.some((guest) => guest.id === manualId), 'guest removed from saved data');

  const staleSave = await fetch(`${base}/api/workspaces`, { method: 'PUT', headers: { ...headers, 'X-Base-Revision': String((await fetch(`${base}/api/workspaces/revision`, { headers: { Cookie: cookie } }).then((response) => response.json())).revision) }, body: JSON.stringify({ currentWorkspaceId: 'qa-event', workspaces: [staleSnapshot] }) });
  assert.equal(staleSave.status, 200);
  const afterStaleSave = await readWorkspace();
  assert.ok(!afterStaleSave.guests.some((guest) => guest.id === manualId), 'a stale tab cannot resurrect a deleted manual guest');
  assert.ok(afterStaleSave.guests.some((guest) => guest.id === 'MEC-500-0'), 'other guests survive the stale save');

  assert.equal((await fetch(`${base}/api/workspaces/qa-event/guests/${manualId}`, { method: 'DELETE', headers })).status, 404, 'deleting twice reports not found');
  const second = await fetch(`${base}/api/workspaces/qa-event/guests`, { method: 'POST', headers, body: JSON.stringify({ name: 'Walk In Again', email: 'walkin@example.test' }) });
  assert.equal(second.status, 201, 'the email can be reused after deletion');
  console.log('Integration passed: manual guest delete requires auth and same-origin, refuses MEC guests, persists, survives stale saves, and frees the email.');
} finally {
  child.kill();
  await rm(temporaryRoot, { recursive: true, force: true });
}
