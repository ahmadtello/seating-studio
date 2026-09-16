import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'seating-conflict-'));
const authFile = path.join(temporaryRoot, 'auth.htpasswd');
const dataFile = path.join(temporaryRoot, 'workspaces.json');
const port = 18794;
const base = `http://127.0.0.1:${port}`;
const origin = 'http://localhost:4173';
await writeFile(authFile, `qa-user:${bcrypt.hashSync('qa-password', 10)}\n`);
await writeFile(dataFile, JSON.stringify({ currentWorkspaceId: 'qa-event', workspaces: [{
  id: 'qa-event', details: { name: 'QA Event', defaultSeats: 10 }, campaign: {},
  tables: [{ id: 1, name: '', capacity: 10, zone: 'Main floor' }, { id: 2, name: '', capacity: 10, zone: 'Main floor' }],
  guests: [{ id: 'MEC-1-0', name: 'Guest One', email: 'one@example.test', bookingId: '1', attendeeKey: '0', source: 'mec', tableId: 1 }]
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

  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'X-Seating-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'qa-user', password: 'qa-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: origin, 'X-Seating-Request': '1', 'Content-Type': 'application/json' };
  const load = async () => (await fetch(`${base}/api/workspaces`, { headers: { Cookie: cookie } })).json();
  const save = (data, revision) => fetch(`${base}/api/workspaces`, { method: 'PUT', headers: revision == null ? headers : { ...headers, 'X-Base-Revision': String(revision) }, body: JSON.stringify(data) });

  // Two admins open the plan at the same revision.
  const tabA = await load();
  const tabB = await load();
  assert.equal(tabA.revision, 0);

  tabA.workspaces[0].guests[0].tableId = 2;
  const first = await save(tabA, tabA.revision);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).revision, 1);

  // The second tab still holds the old seating and must not overwrite the newer save.
  tabB.workspaces[0].tables[1].name = 'Stale edit';
  const stale = await save(tabB, tabB.revision);
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.conflict, true);
  assert.equal(staleBody.revision, 1);
  assert.equal((await load()).workspaces[0].guests[0].tableId, 2, 'the newer seating survives the stale save');

  assert.equal((await save(tabB)).status, 409, 'saves from old app versions without a revision are refused');
  assert.equal((await save(tabB, 'abc')).status, 409);

  // After reloading, the second admin can save again, and the revision endpoint tracks it.
  const reloaded = await load();
  reloaded.workspaces[0].tables[1].name = 'Sponsors';
  const second = await save(reloaded, reloaded.revision);
  assert.equal(second.status, 200);
  assert.equal((await (await fetch(`${base}/api/workspaces/revision`, { headers: { Cookie: cookie } })).json()).revision, 2);
  assert.equal((await fetch(`${base}/api/workspaces/revision`)).status, 401, 'revision endpoint requires a session');

  // Check-ins keep the revision so they never force seating editors to reload.
  const checkIn = await fetch(`${base}/api/workspaces/qa-event/check-in/MEC-1-0`, { method: 'PATCH', headers, body: JSON.stringify({ checkedIn: true }) });
  assert.equal(checkIn.status, 200);
  assert.equal((await load()).revision, 2);

  // Every accepted save keeps a restorable copy of the plan it replaced.
  const history = (await readdir(path.join(temporaryRoot, 'history'))).sort();
  assert.equal(history.length, 2);
  assert.match(history[0], /-r0\.json$/);
  const firstSnapshot = JSON.parse(await readFile(path.join(temporaryRoot, 'history', history[0]), 'utf8'));
  assert.equal(firstSnapshot.workspaces[0].guests[0].tableId, 1, 'the snapshot holds the plan before the save');

  console.log('Integration passed: stale and revision-less saves are refused, newer seating survives, check-ins keep the revision, and every save is snapshotted.');
} finally {
  child.kill();
  await rm(temporaryRoot, { recursive: true, force: true });
}
