import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'seating-ui-qa-'));
await writeFile(path.join(root, 'auth'), `qa-user:${bcrypt.hashSync('qa-password', 10)}`);
await writeFile(path.join(root, 'data.json'), JSON.stringify({ currentWorkspaceId: 'qa-event', profile: { name: 'QA Admin', role: 'Test' }, workspaces: [{
  id: 'qa-event', details: { name: 'Annual Awards Night', dateLabel: '12 March 2027', startTime: '7:00 PM', endTime: '11:00 PM', venue: 'Grand Harbour Hotel', mecEventId: '', defaultSeats: 10, tablesPerRow: 12, tableRows: [10, 11, 12, 7], vipZone: 'Stage', selfCheckInEnabled: true, selfCheckInVerification: false },
  tables: Array.from({ length: 40 }, (_, index) => ({ id: index + 1, name: `Table ${String(index + 1).padStart(2, '0')}`, capacity: 10, zone: index < 10 ? 'Stage' : 'Main' })),
  guests: Array.from({ length: 10 }, (_, i) => ({ id: `qa-${i}`, name: i === 0 ? 'Alexander Montgomery' : `Sample Guest ${i + 1}`, company: i === 0 ? 'Northwind Integrated Services' : ['Alpha Group','Alpha Group','Beta LLC','Beta LLC','Gamma Co','Gamma Co','Delta','Epsilon','Zeta','Eta'][i], title: i < 4 ? ['Chief Executive Officer','Director','Managing Director','Head of Operations'][i] : 'Manager', email: `sample${i}@example.test`, bookingId: String(i + 1), attendeeKey: '0', invoiceKey: i < 2 ? 'stAN48xy' : `QA${String(i).padStart(6, '0')}`, ticketName: i === 0 ? 'VIP Gala Guest' : 'Gala Guest', tableId: i < 2 ? 1 : null, vip: i === 0, checkedIn: i === 0, checkedInAt: i === 0 ? '2027-03-12T15:04:00Z' : '', paymentStatus: i < 8 ? 'Complimentary & confirmed' : 'Paid & confirmed', bookingMembership: { source: 'woocommerce-purchaser', status: 'active', levels: [{ name: i < 4 ? 'Premium Corporate Member' : i < 8 ? 'Corporate Member' : 'Associate Membership', active: true }], checkedAt: '2026-09-05T00:00:00Z' } })), campaign: {}, published: false
}] }));
const child = spawn(process.execPath, ['server/index.js'], { stdio: 'inherit', env: { ...process.env, PORT: '8787', AUTH_FILE: path.join(root, 'auth'), DATA_FILE: path.join(root, 'data.json'), SESSION_SECRET: 'isolated-ui-qa-secret-at-least-32-characters', NODE_ENV: 'test', EMAIL_TEST_TRANSPORT: 'json', EMAIL_FROM_ADDRESS: 'events@example.test', CAMPAIGN_SEND_INTERVAL_MS: '800' } });
const cleanup = async () => { child.kill(); await rm(root, { recursive: true, force: true }); process.exit(); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
child.on('exit', cleanup);
