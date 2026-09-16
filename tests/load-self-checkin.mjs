import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const concurrentUsers = 500;
const temp = await mkdtemp(path.join(tmpdir(), 'seating-studio-self-checkin-load-'));
const dataFile = path.join(temp, 'workspaces.json');
const authFile = path.join(temp, 'auth');
const port = 18878;
const baseUrl = `http://127.0.0.1:${port}`;
const origin = 'http://localhost:4173';

const tables = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, name: `Table ${index + 1}`, capacity: 10, zone: index < 10 ? 'VIP' : 'Main' }));
const guests = Array.from({ length: concurrentUsers }, (_, index) => ({
  id: `LOAD-${index + 1}`,
  name: `Load Guest ${index + 1}`,
  email: `load-${index + 1}@example.test`,
  company: `Company ${index % 40}`,
  title: 'Attendee',
  ticketName: 'Gala ticket',
  tableId: Math.floor(index / 10) + 1,
  vip: index < 100,
  checkedIn: false,
  checkInHistory: []
}));

await writeFile(authFile, `load-admin:${await bcrypt.hash('load-test-password', 4)}\n`, { mode: 0o600 });
await writeFile(dataFile, JSON.stringify({
  workspaces: [{
    id: 'load-event',
    details: { name: 'Seating Load Test', dateLabel: '08 Sep 2026', venue: 'Test venue', startTime: '7:00 PM', selfCheckInEnabled: true, selfCheckInVerification: false },
    tables,
    guests,
    campaign: {},
    published: false,
    updatedAt: new Date().toISOString()
  }],
  currentWorkspaceId: 'load-event',
  profile: { name: 'Load test', role: 'Administrator' }
}, null, 2));

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: path.resolve('.'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port), AUTH_FILE: authFile, DATA_FILE: dataFile, USERS_FILE: path.join(temp, 'users.json'), SESSION_SECRET: 'load-test-session-secret-that-is-long-enough', NODE_ENV: 'test', EMAIL_TEST_TRANSPORT: 'json' }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, amount) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * amount) - 1)];
async function waitForApi() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await sleep(50);
  }
  throw new Error('Load-test API did not start');
}

async function timedRequest(url, options) {
  const started = performance.now();
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, duration: performance.now() - started };
}

try {
  await waitForApi();
  const commonHeaders = { Origin: origin, 'X-Seating-Request': '1', 'Content-Type': 'application/json' };

  const startWall = performance.now();
  const starts = await Promise.all(guests.map((guest) => timedRequest(`${baseUrl}/api/public/self-check-in/load-event/start`, {
    method: 'POST', headers: commonHeaders, body: JSON.stringify({ email: guest.email })
  })));
  const startTotal = performance.now() - startWall;
  assert.equal(starts.filter((result) => result.status === 200).length, concurrentUsers, `start failures: ${JSON.stringify(starts.filter((result) => result.status !== 200).slice(0, 3))}`);

  const checkInWall = performance.now();
  const checkIns = await Promise.all(starts.map((started, index) => timedRequest(`${baseUrl}/api/public/self-check-in/load-event/guests/${guests[index].id}`, {
    method: 'PATCH',
    headers: { ...commonHeaders, Authorization: `Bearer ${started.body.accessToken}` },
    body: JSON.stringify({ checkedIn: true })
  })));
  const checkInTotal = performance.now() - checkInWall;
  assert.equal(checkIns.filter((result) => result.status === 200).length, concurrentUsers, `check-in failures: ${JSON.stringify(checkIns.filter((result) => result.status !== 200).slice(0, 3))}`);

  const persisted = JSON.parse(await readFile(dataFile, 'utf8'));
  const checkedIn = persisted.workspaces[0].guests.filter((guest) => guest.checkedIn).length;
  assert.equal(checkedIn, concurrentUsers, 'Every successful check-in must be durably persisted');

  const startDurations = starts.map((result) => result.duration);
  const checkInDurations = checkIns.map((result) => result.duration);
  const metrics = {
    concurrentUsers,
    successes: { lookup: starts.length, checkIn: checkIns.length, persisted: checkedIn },
    lookupMs: { wall: Math.round(startTotal), p50: Math.round(percentile(startDurations, 0.5)), p95: Math.round(percentile(startDurations, 0.95)), max: Math.round(Math.max(...startDurations)) },
    checkInMs: { wall: Math.round(checkInTotal), p50: Math.round(percentile(checkInDurations, 0.5)), p95: Math.round(percentile(checkInDurations, 0.95)), max: Math.round(Math.max(...checkInDurations)) }
  };
  assert.ok(startTotal < 15_000 && checkInTotal < 15_000, `500-user wall time exceeded the 15-second safety threshold: ${JSON.stringify(metrics)}`);
  console.log(JSON.stringify(metrics, null, 2));
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2_000)]);
  await rm(temp, { recursive: true, force: true });
}
