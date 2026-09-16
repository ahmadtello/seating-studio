import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'seating-guest-send-'));
const authFile = path.join(temporaryRoot, 'auth.htpasswd');
const dataFile = path.join(temporaryRoot, 'workspaces.json');
const port = 18795;
const base = `http://127.0.0.1:${port}`;
const origin = 'http://localhost:4173';
const template = '<p>Dear {{first_name}}, you are at table {{table_number}}.</p>{{qr_code}}';
await writeFile(authFile, `qa-user:${bcrypt.hashSync('qa-password', 10)}\n`);
await writeFile(dataFile, JSON.stringify({ currentWorkspaceId: 'qa-event', workspaces: [{
  id: 'qa-event', details: { name: 'QA Gala', dateLabel: '12 March 2027', startTime: '7:00 PM', venue: 'QA Ballroom', defaultSeats: 10 }, campaign: {},
  tables: [{ id: 1, name: '', capacity: 10, zone: 'Main floor' }, { id: 2, name: '', capacity: 10, zone: 'Main floor' }],
  guests: [
    { id: 'MEC-1-0', name: 'Alpha Guest', email: 'alpha@example.test', bookingId: '1', attendeeKey: '0', source: 'mec', tableId: 1, qrToken: 'stTESTKEY01' },
    { id: 'MEC-2-0', name: 'Beta Guest', email: 'BETA@example.test', bookingId: '2', attendeeKey: '0', source: 'mec', tableId: 2 },
    { id: 'MEC-3-0', name: 'Unseated Guest', email: 'unseated@example.test', bookingId: '3', attendeeKey: '0', source: 'mec', tableId: null },
    { id: 'MEC-4-0', name: 'No Email Guest', email: '', bookingId: '4', attendeeKey: '0', source: 'mec', tableId: 2 }
  ]
}, {
  // Simulates a send that was running when the server stopped.
  id: 'interrupted-event', details: { name: 'Interrupted', defaultSeats: 10 }, tables: [{ id: 1, name: '', capacity: 10, zone: 'Main floor' }],
  guests: [{ id: 'MEC-9-0', name: 'Mid Send', email: 'mid@example.test', source: 'mec', tableId: 1 }],
  campaign: { deliveries: { 'MEC-9-0': { status: 'sending', to: 'mid@example.test', tableNumber: '1', at: '2027-03-01T10:00:00.000Z', jobId: 'old' } }, sendJob: { id: 'old', mode: 'unsent', status: 'running', recipients: ['MEC-9-0'], cursor: 1, total: 1, sent: 0, failed: 0, skipped: 0, startedAt: '2027-03-01T10:00:00.000Z', startedBy: 'qa-user', template: { subject: 'Old', replyTo: '', htmlBody: template, attachCalendar: false } } }
}] }));
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), AUTH_FILE: authFile, DATA_FILE: dataFile, SESSION_SECRET: 'integration-test-session-secret-that-is-long-enough', NODE_ENV: 'test', EMAIL_TEST_TRANSPORT: 'json', EMAIL_FROM_ADDRESS: 'events@example.test', CAMPAIGN_SEND_INTERVAL_MS: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Test API did not start');

  assert.equal((await fetch(`${base}/api/workspaces/qa-event/campaign/send-status`)).status, 401, 'status requires a session');
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'X-Seating-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'qa-user', password: 'qa-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: origin, 'X-Seating-Request': '1', 'Content-Type': 'application/json' };
  const status = async (id = 'qa-event') => (await fetch(`${base}/api/workspaces/${id}/campaign/send-status`, { headers: { Cookie: cookie } })).json();
  const send = (body) => fetch(`${base}/api/workspaces/qa-event/campaign/send`, { method: 'POST', headers, body: JSON.stringify({ subject: 'Your table', replyTo: 'reply@example.test', htmlBody: template, attachCalendar: true, confirmation: 'SEND', ...body }) });
  const waitForJob = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await status();
      if (current.job && current.job.status !== 'running') return current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Send job did not finish');
  };

  // A send interrupted by a restart is paused, and its in-flight email is reported rather than silently resent.
  const interrupted = await status('interrupted-event');
  assert.equal(interrupted.job.status, 'paused');
  assert.equal(interrupted.failures.length, 1);
  assert.match(interrupted.failures[0].error, /may already have been delivered/);

  const before = await status();
  assert.deepEqual(before.counts, { seated: 3, unseated: 1, noEmail: 1, sent: 0, failed: 0, unsent: 2, changed: 0 }, 'only seated guests with an email are recipients');
  assert.equal(before.job, null);

  assert.equal((await send({ mode: 'unsent', expectedCount: 2, confirmation: '' })).status, 400, 'typed confirmation is required');
  const mismatch = await send({ mode: 'unsent', expectedCount: 5 });
  assert.equal(mismatch.status, 409, 'a changed recipient count must be reviewed again');
  assert.equal((await mismatch.json()).count, 2);
  assert.equal((await fetch(`${base}/api/workspaces/qa-event/campaign/send`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'sending requires same-origin headers');

  const started = await send({ mode: 'unsent', expectedCount: 2 });
  assert.equal(started.status, 202);
  const done = await waitForJob();
  assert.equal(done.job.status, 'completed');
  assert.equal(done.job.sent, 2);
  assert.equal(done.job.failed, 0);
  assert.equal(done.deliveries['MEC-1-0'].status, 'sent');
  assert.equal(done.deliveries['MEC-2-0'].status, 'sent');
  assert.equal(done.deliveries['MEC-3-0'], undefined, 'unseated guests are never emailed');
  assert.equal(done.counts.unsent, 0);

  assert.equal((await send({ mode: 'unsent', expectedCount: 0 })).status, 400, 'nobody is emailed twice');

  // A browser save that knows nothing about deliveries must not erase them.
  const loaded = await (await fetch(`${base}/api/workspaces`, { headers: { Cookie: cookie } })).json();
  const workspace = loaded.workspaces.find((item) => item.id === 'qa-event');
  workspace.campaign = { subject: 'Edited', replyTo: 'reply@example.test', htmlBody: template };
  workspace.guests.find((guest) => guest.id === 'MEC-1-0').tableId = 2;
  const save = await fetch(`${base}/api/workspaces`, { method: 'PUT', headers: { ...headers, 'X-Base-Revision': String(loaded.revision) }, body: JSON.stringify(loaded) });
  assert.equal(save.status, 200);
  const afterMove = await status();
  assert.equal(afterMove.deliveries['MEC-1-0'].status, 'sent', 'deliveries survive browser saves');
  assert.equal(afterMove.counts.changed, 1, 'a guest moved to another table is offered an updated email');
  assert.equal(afterMove.counts.unsent, 0);

  assert.equal((await send({ mode: 'changed', expectedCount: 1 })).status, 202);
  const resent = await waitForJob();
  assert.equal(resent.job.sent, 1);
  assert.equal(resent.deliveries['MEC-1-0'].tableNumber, '2');
  assert.equal(resent.counts.changed, 0);

  const stop = await fetch(`${base}/api/workspaces/qa-event/campaign/send/stop`, { method: 'POST', headers });
  assert.equal(stop.status, 200, 'stopping a finished send is harmless');
  assert.equal((await stop.json()).job.status, 'completed');

  console.log('Integration passed: only seated guests with emails are sent to, confirmation and count checks, one email per guest, no duplicates, deliveries survive saves, moved guests can be re-sent, and interrupted sends pause safely.');
} finally {
  child.kill();
  await rm(temporaryRoot, { recursive: true, force: true });
}
