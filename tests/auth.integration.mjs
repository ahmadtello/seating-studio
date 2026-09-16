import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'seating-studio-auth-'));
const authFile = path.join(temporaryRoot, 'auth.htpasswd');
const dataFile = path.join(temporaryRoot, 'workspaces.json');
const port = 18787;
const base = `http://127.0.0.1:${port}`;
await mkdir(temporaryRoot, { recursive: true });
await writeFile(authFile, `qa-user:${bcrypt.hashSync('qa-password', 10)}\n`);

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    AUTH_FILE: authFile,
    DATA_FILE: dataFile,
    SESSION_SECRET: 'integration-test-session-secret-that-is-long-enough',
    NODE_ENV: 'test',
    EMAIL_TEST_TRANSPORT: 'json',
    EMAIL_FROM_ADDRESS: 'no-reply@example.test',
    EMAIL_FROM_NAME: 'Seating QA'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Test API did not start');

  const malformedJson = await fetch(`${base}/api/workspaces/qa-event/guests`, {
    method: 'POST', headers: { Origin: 'http://localhost:4173', 'X-Seating-Request': '1', 'Content-Type': 'application/json' }, body: '{invalid'
  });
  if (malformedJson.status !== 400) throw new Error(`Malformed JSON returned ${malformedJson.status}`);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:4173', 'X-Seating-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'qa-user', password: 'qa-password' })
  });
  if (login.status !== 200) throw new Error(`Login returned ${login.status}`);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie?.startsWith('seating_session=')) throw new Error('Secure session cookie was not issued');

  const workspace = await fetch(`${base}/api/workspaces`, { headers: { Cookie: cookie } });
  if (workspace.status !== 200) throw new Error(`Authenticated read returned ${workspace.status}`);

  const seededPayload = {
    workspaces: [{
      id: 'qa-event',
      details: { name: 'QA Event', venue: 'Custom ballroom', manualEventFields: ['venue'], defaultSeats: 10, tablesPerRow: 3, zones: ['Main floor', 'Balcony'], vipZone: 'Main floor', seatingRules: { style: 'networking', tableUsage: 'spread', priorityMemberships: ['Premium Corporate Member', 'Corporate Member'], balanceLeaders: false } },
      tables: [{ id: 1, name: 'Table 01', capacity: 10, capacityOverride: true, zone: 'Main floor' }],
      guests: [
        { id: 'qa-guest-1', name: 'Guest One', email: 'one@example.test', tableId: 1, bookingId: '123', attendeeKey: '0', invoiceKey: 'stAN48xy', paymentStatus: 'Complimentary & confirmed', bookingMembership: { source: 'woocommerce-purchaser', status: 'active', levels: [{ name: 'Strategic', active: true }], checkedAt: '2026-09-05T00:00:00Z' } },
        { id: 'qa-guest-2', name: 'Guest Two', email: 'two@example.test', tableId: 1 }
      ],
      campaign: { subject: 'QA seating test', replyTo: 'reply@example.test', htmlBody: '<p onclick="bad()">Hello {{guest_name}}</p><img src="https://example.test/test.jpg" alt="Email image"><script>bad()</script>' }
    }],
    currentWorkspaceId: 'qa-event',
    profile: { name: 'QA Admin', role: 'Tester' }
  };
  const mutationHeaders = { Cookie: cookie, Origin: 'http://localhost:4173', 'X-Seating-Request': '1', 'Content-Type': 'application/json' };
  const save = await fetch(`${base}/api/workspaces`, {
    method: 'PUT',
    headers: { ...mutationHeaders, 'X-Base-Revision': String((await fetch(`${base}/api/workspaces/revision`, { headers: { Cookie: cookie } }).then((response) => response.json())).revision) },
    body: JSON.stringify(seededPayload)
  });
  if (save.status !== 200) throw new Error(`Authenticated save returned ${save.status}`);
  const sanitizedWorkspace = await fetch(`${base}/api/workspaces`, { headers: { Cookie: cookie } }).then((response) => response.json());
  const savedHtml = sanitizedWorkspace.workspaces[0].campaign.htmlBody;
  const savedLayout = sanitizedWorkspace.workspaces[0];
  if (!savedLayout.tables[0].capacityOverride || savedLayout.details.tablesPerRow !== 3 || savedLayout.details.tableRows?.[0] !== 1 || !savedLayout.details.zones.includes('Balcony') || savedLayout.details.venue !== 'Custom ballroom' || savedLayout.details.manualEventFields?.[0] !== 'venue' || savedLayout.guests[0].bookingMembership.levels[0].name !== 'Strategic' || savedLayout.guests[0].invoiceKey !== 'stAN48xy' || savedLayout.details.seatingRules.style !== 'networking' || savedLayout.details.seatingRules.tableUsage !== 'spread' || savedLayout.details.seatingRules.balanceLeaders !== false || savedLayout.details.seatingRules.priorityMemberships.length !== 2) throw new Error('Layout, event overrides, smart seating rules, scanner references, or membership fields did not persist');
  const overfull = structuredClone(seededPayload);
  overfull.workspaces[0].tables[0].capacity = 4;
  overfull.workspaces[0].guests = Array.from({ length: 5 }, (_, i) => ({ id: `overfull-${i}`, name: `Test ${i}`, tableId: 1 }));
  const rejectedCapacity = await fetch(`${base}/api/workspaces`, { method: 'PUT', headers: { ...mutationHeaders, 'X-Base-Revision': String((await fetch(`${base}/api/workspaces/revision`, { headers: { Cookie: cookie } }).then((response) => response.json())).revision) }, body: JSON.stringify(overfull) });
  if (rejectedCapacity.status !== 400) throw new Error('API accepted an over-capacity layout');
  if (!savedHtml.includes('{{guest_name}}') || !savedHtml.includes('https://example.test/test.jpg') || /script|onclick/i.test(savedHtml)) throw new Error('Campaign HTML was not sanitized safely');

  const invalidManualGuest = await fetch(`${base}/api/workspaces/qa-event/guests`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ name: '', email: 'invalid' })
  });
  if (invalidManualGuest.status !== 400) throw new Error(`Invalid manual guest returned ${invalidManualGuest.status}`);
  const manualGuestResponse = await fetch(`${base}/api/workspaces/qa-event/guests`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ name: '  Manual Guest  ', email: 'MANUAL@EXAMPLE.TEST', company: 'Acme Co', title: 'Host', tableId: 1, vip: true })
  });
  const manualGuestData = await manualGuestResponse.json();
  if (manualGuestResponse.status !== 201 || manualGuestData.guest.name !== 'Manual Guest' || manualGuestData.guest.email !== 'manual@example.test' || manualGuestData.guest.source !== 'manual') throw new Error('Manual guest creation failed');
  const duplicateManualGuest = await fetch(`${base}/api/workspaces/qa-event/guests`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ name: 'Duplicate Guest', email: 'manual@example.test' })
  });
  if (duplicateManualGuest.status !== 409) throw new Error(`Duplicate manual guest returned ${duplicateManualGuest.status}`);

  const emailStatus = await fetch(`${base}/api/email/status`, { headers: { Cookie: cookie } }).then((response) => response.json());
  if (!emailStatus.configured || emailStatus.provider !== 'Test transport') throw new Error('Test email transport was not reported as configured');
  const invalidTestEmail = await fetch(`${base}/api/workspaces/qa-event/campaign/test-email`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ to: 'invalid-address', subject: 'QA seating test' })
  });
  if (invalidTestEmail.status !== 400) throw new Error(`Invalid test email returned ${invalidTestEmail.status}`);
  const testEmail = await fetch(`${base}/api/workspaces/qa-event/campaign/test-email`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ to: 'organizer@example.test', subject: 'QA seating test', replyTo: 'reply@example.test', htmlBody: '<p>Hello {{guest_name}}</p>', previewGuestId: 'qa-guest-1', attachCalendar: true })
  });
  const testEmailData = await testEmail.json();
  if (testEmail.status !== 200 || !testEmailData.sent || testEmailData.to !== 'organizer@example.test') throw new Error('Test campaign email failed');

  const checkInList = await fetch(`${base}/api/workspaces/qa-event/check-in`, { headers: { Cookie: cookie } });
  const initialGuests = (await checkInList.json()).guests;
  if (checkInList.status !== 200 || initialGuests.length !== 3 || initialGuests.some((guest) => guest.checkedIn) || initialGuests.find((guest) => guest.id === 'qa-guest-1')?.invoiceKey !== 'stAN48xy') throw new Error('Initial check-in list or scanner reference is invalid');

  const checkInResponses = await Promise.all(initialGuests.map((guest) => fetch(`${base}/api/workspaces/qa-event/check-in/${guest.id}`, {
    method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ checkedIn: true })
  })));
  if (checkInResponses.some((response) => response.status !== 200)) throw new Error('Concurrent check-in failed');

  const legacyPayload = structuredClone(seededPayload);
  legacyPayload.workspaces[0].guests[0].bookingMembership = { status: 'active', levels: [{ name: 'Membership', active: true }], checkedAt: '2099-01-01T00:00:00Z' };
  legacyPayload.workspaces[0].guests[0].paymentStatus = 'Paid & confirmed';
  const staleSave = await fetch(`${base}/api/workspaces`, { method: 'PUT', headers: { ...mutationHeaders, 'X-Base-Revision': String((await fetch(`${base}/api/workspaces/revision`, { headers: { Cookie: cookie } }).then((response) => response.json())).revision) }, body: JSON.stringify(legacyPayload) });
  if (staleSave.status !== 200) throw new Error('Stale workspace save failed');
  const afterStaleSave = await fetch(`${base}/api/workspaces/qa-event/check-in`, { headers: { Cookie: cookie } }).then((response) => response.json());
  if (afterStaleSave.guests.some((guest) => !guest.checkedIn)) throw new Error('A stale workspace save overwrote check-in status');
  if (!afterStaleSave.guests.some((guest) => guest.id === manualGuestData.guest.id)) throw new Error('A stale workspace save removed a manually added guest');
  const afterEmailSave = await fetch(`${base}/api/workspaces`, { headers: { Cookie: cookie } }).then((response) => response.json());
  if (afterEmailSave.workspaces[0].guests[0].bookingMembership.source !== 'woocommerce-purchaser' || afterEmailSave.workspaces[0].guests[0].bookingMembership.levels[0].name !== 'Strategic' || afterEmailSave.workspaces[0].guests[0].paymentStatus !== 'Complimentary & confirmed') throw new Error('Legacy browser overwrote purchaser metadata');
  if (afterEmailSave.workspaces[0].campaign.testEmailLog?.length !== 1) throw new Error('A stale workspace save overwrote the test email audit log');

  const undo = await fetch(`${base}/api/workspaces/qa-event/check-in/qa-guest-1`, {
    method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ checkedIn: false })
  });
  if (undo.status !== 200 || (await undo.json()).guest.checkedIn) throw new Error('Check-in undo failed');

  const createCheckInUser = await fetch(`${base}/api/users`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ username: 'door-team', displayName: 'Door Team', password: 'checkin-password-123' })
  });
  if (createCheckInUser.status !== 201 || (await createCheckInUser.json()).user.role !== 'checkin') throw new Error('Check-in user creation failed');
  const staffLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:4173', 'X-Seating-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'door-team', password: 'checkin-password-123' })
  });
  const staffLoginData = await staffLogin.json();
  const staffCookie = staffLogin.headers.get('set-cookie')?.split(';')[0];
  if (staffLogin.status !== 200 || staffLoginData.role !== 'checkin' || !staffCookie) throw new Error('Check-in user login failed');
  const staffEvents = await fetch(`${base}/api/check-in/events`, { headers: { Cookie: staffCookie } });
  const staffCheckIn = await fetch(`${base}/api/workspaces/qa-event/check-in`, { headers: { Cookie: staffCookie } });
  const blockedWorkspace = await fetch(`${base}/api/workspaces`, { headers: { Cookie: staffCookie } });
  const blockedUsers = await fetch(`${base}/api/users`, { headers: { Cookie: staffCookie } });
  const blockedEmail = await fetch(`${base}/api/email/status`, { headers: { Cookie: staffCookie } });
  const blockedManualGuest = await fetch(`${base}/api/workspaces/qa-event/guests`, { method: 'POST', headers: { ...mutationHeaders, Cookie: staffCookie }, body: JSON.stringify({ name: 'Blocked', email: 'blocked@example.test' }) });
  if (staffEvents.status !== 200 || staffCheckIn.status !== 200 || blockedWorkspace.status !== 403 || blockedUsers.status !== 403 || blockedEmail.status !== 403 || blockedManualGuest.status !== 403) throw new Error('Check-in role permissions are incorrect');
  const disableStaff = await fetch(`${base}/api/users/door-team`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ active: false }) });
  if (disableStaff.status !== 200) throw new Error('Disabling a check-in user failed');
  const disabledSession = await fetch(`${base}/api/auth/session`, { headers: { Cookie: staffCookie } }).then((response) => response.json());
  if (disabledSession.authenticated) throw new Error('Disabled check-in user retained access');

  const csrf = await fetch(`${base}/api/workspaces`, {
    method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaces: [] })
  });
  if (csrf.status !== 403) throw new Error(`CSRF rejection returned ${csrf.status}`);

  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost:4173', 'X-Seating-Request': '1' }
  });
  if (logout.status !== 200) throw new Error(`Logout returned ${logout.status}`);

  console.log('Integration passed: auth, manual guest validation/deduplication, HTML sanitization, restricted staff role, test email delivery/log protection, account disable, concurrent check-in, stale-save protection, undo, CSRF rejection, and logout.');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
