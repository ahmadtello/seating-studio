import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'seating-studio-self-checkin-'));
const authFile = path.join(temporaryRoot, 'auth.htpasswd');
const dataFile = path.join(temporaryRoot, 'workspaces.json');
const port = 18788;
const base = `http://127.0.0.1:${port}`;
const currentEventDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date());
const mutationHeaders = { Origin: 'http://localhost:4173', 'X-Seating-Request': '1', 'Content-Type': 'application/json' };
await mkdir(temporaryRoot, { recursive: true });
await writeFile(authFile, `qa-user:${bcrypt.hashSync('qa-password', 10)}\n`);

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), AUTH_FILE: authFile, DATA_FILE: dataFile, SESSION_SECRET: 'self-checkin-test-secret-that-is-long-enough', NODE_ENV: 'test', EMAIL_TEST_TRANSPORT: 'json', EMAIL_FROM_ADDRESS: 'no-reply@example.test', EMAIL_FROM_NAME: 'Seating QA' },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Test API did not start');
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ username: 'qa-user', password: 'qa-password' }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (login.status !== 200 || !cookie) throw new Error('Admin login failed');
  const payload = {
    workspaces: [{
      id: 'qa-event',
      details: { name: 'QA Gala', dateLabel: currentEventDate, startTime: '7:00 PM', endTime: '11:00 PM', venue: 'QA Ballroom', defaultSeats: 10, tablesPerRow: 5, zones: ['Main floor'], selfCheckInEnabled: true, selfCheckInVerification: false },
      tables: [{ id: 1, name: '01 - Sponsor Co', capacity: 10, zone: 'Main floor' }],
      guests: [
        { id: 'guest-one', name: 'Guest One', email: 'family@example.test', company: 'Acme Co', title: 'Director', ticketName: 'Gala Guest', tableId: 1, invoiceKey: 'privateQR1' },
        { id: 'guest-two', name: 'Guest Two', email: 'family@example.test', company: 'Acme Co', title: 'Manager', ticketName: 'Gala Guest', tableId: 1 }
      ], campaign: {}, published: true
    }], currentWorkspaceId: 'qa-event', profile: { name: 'QA Admin', role: 'Tester' }
  };
  const adminHeaders = { ...mutationHeaders, Cookie: cookie };
  const save = await fetch(`${base}/api/workspaces`, { method: 'PUT', headers: { ...adminHeaders, 'X-Base-Revision': String((await fetch(`${base}/api/workspaces/revision`, { headers: { Cookie: cookie } }).then((response) => response.json())).revision) }, body: JSON.stringify(payload) });
  if (save.status !== 200) throw new Error('Workspace seed failed');

  const publicEvent = await fetch(`${base}/api/public/self-check-in/qa-event`).then((response) => response.json());
  if (publicEvent.event?.name !== 'QA Gala' || publicEvent.event?.endTime !== '11:00 PM' || publicEvent.verificationRequired) throw new Error('Public event settings are incorrect');
  const publicLanding = await fetch(`${base}/api/public/self-check-in`).then((response) => response.json());
  if (publicLanding.events?.length !== 1 || publicLanding.currentEvent?.id !== 'qa-event') throw new Error('The same-day public event was not selected automatically');
  const missing = await fetch(`${base}/api/public/self-check-in/qa-event/start`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ email: 'missing@example.test' }) });
  if (missing.status !== 404) throw new Error('Unknown email was accepted without verification');
  const direct = await fetch(`${base}/api/public/self-check-in/qa-event/start`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ email: 'FAMILY@example.test' }) });
  const directData = await direct.json();
  if (direct.status !== 200 || !directData.verified || !directData.accessToken || directData.guests.length !== 2 || directData.guests.some((guest) => 'invoiceKey' in guest)) throw new Error('Email-only self check-in did not open matching registrations safely');
  const unauthorized = await fetch(`${base}/api/public/self-check-in/qa-event/guests/guest-one`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ checkedIn: true }) });
  if (unauthorized.status !== 401) throw new Error('Public check-in accepted a missing access token');
  const arrival = await fetch(`${base}/api/public/self-check-in/qa-event/guests/guest-one`, { method: 'PATCH', headers: { ...mutationHeaders, Authorization: `Bearer ${directData.accessToken}` }, body: JSON.stringify({ checkedIn: true }) });
  const arrivalData = await arrival.json();
  if (arrival.status !== 200 || !arrivalData.guest.checkedIn || arrivalData.guest.checkedInBy !== 'Self check-in' || arrivalData.guest.tableName !== 'Table 1') throw new Error('Self check-in did not save the arrival and table details');
  if (JSON.stringify(arrivalData).includes('Sponsor Co')) throw new Error('Self check-in leaked the admin-only table name');

  payload.workspaces[0].details.selfCheckInVerification = true;
  const enableVerification = await fetch(`${base}/api/workspaces`, { method: 'PUT', headers: { ...adminHeaders, 'X-Base-Revision': String((await fetch(`${base}/api/workspaces/revision`, { headers: { Cookie: cookie } }).then((response) => response.json())).revision) }, body: JSON.stringify(payload) });
  if (enableVerification.status !== 200) throw new Error('Verification setting did not save');
  const challenge = await fetch(`${base}/api/public/self-check-in/qa-event/start`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ email: 'family@example.test' }) });
  const challengeData = await challenge.json();
  if (challenge.status !== 200 || !challengeData.verificationRequired || !challengeData.challengeId || !/^\d{6}$/.test(challengeData.testCode || '')) throw new Error('Verification challenge was not created');
  const invalidCode = await fetch(`${base}/api/public/self-check-in/qa-event/verify`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ challengeId: challengeData.challengeId, code: '000000' }) });
  if (invalidCode.status !== 400) throw new Error('Invalid verification code was accepted');
  const verified = await fetch(`${base}/api/public/self-check-in/qa-event/verify`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ challengeId: challengeData.challengeId, code: challengeData.testCode }) });
  const verifiedData = await verified.json();
  if (verified.status !== 200 || !verifiedData.verified || verifiedData.guests.length !== 2) throw new Error('Valid verification code failed');

  payload.workspaces[0].details.selfCheckInEnabled = false;
  const disable = await fetch(`${base}/api/workspaces`, { method: 'PUT', headers: { ...adminHeaders, 'X-Base-Revision': String((await fetch(`${base}/api/workspaces/revision`, { headers: { Cookie: cookie } }).then((response) => response.json())).revision) }, body: JSON.stringify(payload) });
  if (disable.status !== 200) throw new Error('Self check-in disable setting did not save');
  const closed = await fetch(`${base}/api/public/self-check-in/qa-event`);
  if (closed.status !== 404) throw new Error('Disabled self check-in remained public');
  console.log('Integration passed: per-event self check-in enablement, optional email verification, shared-email registrations, token protection, arrival persistence, and public closure.');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
