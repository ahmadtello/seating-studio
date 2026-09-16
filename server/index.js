import express from 'express';
import QRCode from 'qrcode';
import { loadMecTickets } from './mec-tickets.js';
import helmet from 'helmet';
import { copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import sanitizeHtml from 'sanitize-html';
import { bookingPaymentStatus } from './booking-eligibility.js';
import { normalizeTableNumbers, tableAdminTitle, tableNumber, tableTitle } from '../shared/table-labels.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const dataFile = path.resolve(process.env.DATA_FILE || './data/workspaces.json');
const usersFile = path.resolve(process.env.USERS_FILE || path.join(path.dirname(dataFile), 'users.json'));
const allowedOrigins = new Set(String(process.env.ALLOWED_ORIGINS || 'http://localhost:4173').split(',').map((origin) => origin.trim()).filter(Boolean));
const mecBaseUrl = process.env.MEC_BASE_URL || '';
const mecOrigin = (() => { try { return mecBaseUrl ? new URL(mecBaseUrl).origin : ''; } catch { return ''; } })();
const mecHost = (() => { try { return mecOrigin ? new URL(mecOrigin).hostname : ''; } catch { return ''; } })();
const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:4173';
const ticketBaseUrl = process.env.TICKET_BASE_URL || '';
const authFile = process.env.AUTH_FILE || '/etc/nginx/seating.htpasswd';
const sessionName = 'seating_session';
const sessionLifetimeSeconds = 12 * 60 * 60;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be configured');
const [authUsername, storedPasswordHash] = (await readFile(authFile, 'utf8')).trim().split(':', 2);
if (!authUsername || !storedPasswordHash) throw new Error('Authentication file is invalid');

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb', strict: true }));

const cleanText = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : '';
const cleanIdentifier = (value, max = 120) => value == null ? '' : String(value).slice(0, max);
const cleanInvoiceKey = (value) => /^[A-Za-z0-9._-]{1,120}$/.test(String(value || '')) ? String(value) : '';
const cleanNumber = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
const cleanInteger = (value, min, max, fallback) => Number.isInteger(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
const buildTableRows = (tableCount, rowSize) => {
  const rows = [];
  for (let remaining = tableCount; remaining > 0; remaining -= rowSize) rows.push(Math.min(rowSize, remaining));
  return rows;
};
const cleanTableRows = (value, tableCount, fallbackSize) => {
  if (value == null) return buildTableRows(tableCount, fallbackSize);
  if (!Array.isArray(value) || (!value.length && tableCount) || value.length > 100) throw new Error('Invalid table row layout');
  const rows = value.map(Number);
  if (rows.some((row) => !Number.isInteger(row) || row < 1 || row > 20)) throw new Error('Each table row must contain between 1 and 20 tables');
  if (rows.reduce((sum, row) => sum + row, 0) !== tableCount) throw new Error('Table row layout must match the number of tables');
  return rows;
};
const cleanHeader = (value, max = 300) => cleanText(value, max).replace(/[\r\n]+/g, ' ').trim();
const cleanMembership = value => ({
  source: value?.source === 'woocommerce-purchaser' ? 'woocommerce-purchaser' : 'legacy-mec-account',
  status: ['active', 'inactive', 'none', 'no-account', 'unavailable'].includes(value?.status) ? value.status : 'unknown',
  levels: Array.isArray(value?.levels) ? value.levels.slice(0, 30).map(level => ({ name: cleanText(level.name, 160), active: level.active === true })).filter(level => level.name) : [],
  checkedAt: cleanText(value?.checkedAt, 40)
});
const isEmail = (value) => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const isAllowedEventUrl = (value) => { if (!mecHost) return false; try { const url = new URL(String(value)); return url.protocol === 'https:' && url.hostname === mecHost; } catch { return false; } };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const sanitizeEmailHtml = (value) => sanitizeHtml(cleanText(value, 300_000), {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'html', 'head', 'body', 'style', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'center'],
  allowedAttributes: {
    '*': ['style', 'class', 'id', 'title', 'role', 'dir', 'lang', 'align', 'width', 'height', 'cellspacing', 'cellpadding', 'border', 'bgcolor', 'valign'],
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    col: ['span']
  },
  allowedSchemes: ['http', 'https', 'mailto', 'cid'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  enforceHtmlBoundary: true
});

function normalizePayload(body) {
  if (!body || !Array.isArray(body.workspaces) || body.workspaces.length > 30) throw new Error('Invalid workspace payload');
  const workspaces = body.workspaces.map((workspace) => {
    if (!workspace || typeof workspace !== 'object') throw new Error('Invalid workspace');
    const id = cleanText(workspace.id, 100);
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid workspace ID');
    const details = workspace.details || {};
    const tables = Array.isArray(workspace.tables) ? normalizeTableNumbers(workspace.tables.slice(0, 100).map((table) => ({
      id: cleanNumber(table.id, 1, 1000, 1),
      number: table.number,
      name: cleanText(table.name, 80),
      capacity: cleanNumber(table.capacity, 4, 20, 10),
      capacityOverride: typeof table.capacityOverride === 'boolean' ? table.capacityOverride : Number(table.capacity) !== Number(details.defaultSeats || 10),
      zone: cleanText(table.zone, 60)
    }))) : [];
    const tableIds = new Set(tables.map((table) => table.id));
    const guests = Array.isArray(workspace.guests) ? workspace.guests.slice(0, 5000).map((guest) => ({
      id: cleanText(guest.id, 100),
      name: cleanText(guest.name, 160),
      company: cleanText(guest.company, 180),
      title: cleanText(guest.title, 180),
      email: cleanText(guest.email, 254),
      source: ['mec', 'manual', 'import'].includes(guest.source) ? guest.source : guest.bookingId ? 'mec' : 'import',
      vip: Boolean(guest.vip),
      tableId: tableIds.has(Number(guest.tableId)) ? Number(guest.tableId) : null,
      bookingId: cleanIdentifier(guest.bookingId, 100),
      attendeeKey: cleanIdentifier(guest.attendeeKey, 120),
      invoiceKey: cleanInvoiceKey(guest.invoiceKey),
      transactionId: cleanInvoiceKey(guest.transactionId),
      qrToken: cleanInvoiceKey(guest.qrToken),
      ticketName: cleanText(guest.ticketName, 160),
      paymentStatus: cleanText(guest.paymentStatus, 60),
      bookingMembership: cleanMembership(guest.bookingMembership),
      checkedIn: Boolean(guest.checkedIn),
      checkedInAt: cleanText(guest.checkedInAt, 40),
      checkedInBy: cleanText(guest.checkedInBy, 100),
      checkInHistory: Array.isArray(guest.checkInHistory) ? guest.checkInHistory.slice(-20).map((entry) => ({
        checkedIn: Boolean(entry.checkedIn),
        at: cleanText(entry.at, 40),
        by: cleanText(entry.by, 100)
      })) : []
    })) : [];
    if (guests.some((guest) => guest.source === 'manual' && (!guest.name.trim() || !isEmail(guest.email.trim())))) throw new Error('Invalid manual guest: name and email are required');
    const campaign = workspace.campaign || {};
    const tablesPerRow = cleanInteger(details.tablesPerRow, 1, 20, 5);
    const tableRows = cleanTableRows(details.tableRows, tables.length, tablesPerRow);
    return {
      id,
      details: {
        name: cleanText(details.name, 160),
        dateLabel: cleanText(details.dateLabel, 80),
        venue: cleanText(details.venue, 180),
        defaultSeats: cleanNumber(details.defaultSeats, 4, 20, 10),
        tablesPerRow,
        tableRows,
        zones: [...new Set([...(Array.isArray(details.zones) ? details.zones : []), ...tables.map(table => table.zone)].map(zone => cleanText(zone, 60).trim()).filter(Boolean))].slice(0, 30),
        vipZone: cleanText(details.vipZone ?? (tables.some(t => t.zone === 'Stage') ? 'Stage' : ''), 60),
        seatingRules: {
          style: ['balanced', 'company', 'networking'].includes(details.seatingRules?.style) ? details.seatingRules.style : 'balanced',
          tableUsage: ['efficient', 'spread'].includes(details.seatingRules?.tableUsage) ? details.seatingRules.tableUsage : 'efficient',
          priorityMemberships: Array.isArray(details.seatingRules?.priorityMemberships) ? [...new Set(details.seatingRules.priorityMemberships.map(value => cleanText(value, 160).trim()).filter(Boolean))].slice(0, 30) : ['Premium Corporate Member'],
          balanceLeaders: details.seatingRules?.balanceLeaders !== false
        },
        mecEventId: /^\d{1,12}$/.test(String(details.mecEventId || '')) ? String(details.mecEventId) : '',
        startTime: cleanText(details.startTime, 30),
        endTime: cleanText(details.endTime, 30),
        organizerId: cleanIdentifier(details.organizerId, 30),
        categories: cleanText(details.categories, 240),
        ticketSummary: cleanText(details.ticketSummary, 300),
        eventUrl: isAllowedEventUrl(details.eventUrl) ? String(details.eventUrl).slice(0, 500) : '',
        manualEventFields: Array.isArray(details.manualEventFields) ? [...new Set(details.manualEventFields.filter((field) => ['name', 'dateLabel', 'venue', 'startTime', 'endTime'].includes(field)))].slice(0, 5) : [],
        selfCheckInEnabled: details.selfCheckInEnabled === true,
        selfCheckInVerification: details.selfCheckInVerification === true,
        lastSyncedAt: cleanText(details.lastSyncedAt, 40)
      },
      tables,
      guests,
      campaign: {
        subject: cleanText(campaign.subject, 200),
        replyTo: cleanText(campaign.replyTo, 254),
        htmlBody: sanitizeEmailHtml(campaign.htmlBody),
        attachCalendar: campaign.attachCalendar !== false,
        includeMecQr: Boolean(campaign.includeMecQr),
        preparedAt: cleanText(campaign.preparedAt, 40),
        deliveries: {},
        sendJob: null,
        testEmailLog: []
      },
      published: Boolean(workspace.published),
      publishedAt: cleanText(workspace.publishedAt, 40),
      updatedAt: new Date().toISOString()
    };
  });
  const currentWorkspaceId = workspaces.some((item) => item.id === body.currentWorkspaceId) ? body.currentWorkspaceId : workspaces[0]?.id;
  const submittedProfile = body.profile || {};
  const profile = {
    name: cleanText(submittedProfile.name, 100) || 'Event Admin',
    role: cleanText(submittedProfile.role, 100) || 'Administrator'
  };
  return { workspaces, currentWorkspaceId, profile };
}

async function readData() {
  try { return JSON.parse(await readFile(dataFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { workspaces: [], currentWorkspaceId: null, profile: { name: 'Event Admin', role: 'Administrator' } }; throw error; }
}

async function writeJsonAtomic(filePath, payload, mode = 0o640) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o750 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(payload, null, 2), { mode });
  await rename(temporary, filePath);
}

async function writeData(payload) {
  await writeJsonAtomic(dataFile, payload);
}

const historyDir = path.join(path.dirname(dataFile), 'history');
const HISTORY_LIMIT = 1000;

// Keeps a copy of the saved plan before each admin save so an overwrite can always be rolled back.
async function snapshotData(revision) {
  await mkdir(historyDir, { recursive: true, mode: 0o750 });
  try { await copyFile(dataFile, path.join(historyDir, `workspaces-${new Date().toISOString().replace(/[:.]/g, '-')}-r${revision}.json`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return; }
  const files = (await readdir(historyDir)).filter((name) => name.startsWith('workspaces-')).sort();
  await Promise.all(files.slice(0, Math.max(0, files.length - HISTORY_LIMIT)).map((name) => unlink(path.join(historyDir, name)).catch(() => {})));
}

const dataRevision = (data) => Number.isInteger(data?.revision) && data.revision >= 0 ? data.revision : 0;

async function readUsers() {
  try {
    const data = JSON.parse(await readFile(usersFile, 'utf8'));
    return { users: Array.isArray(data.users) ? data.users : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { users: [] };
    throw error;
  }
}

async function writeUsers(payload) {
  await writeJsonAtomic(usersFile, payload, 0o600);
}

let mutationQueue = Promise.resolve();
function withDataMutation(action) {
  const pending = mutationQueue.then(action, action);
  mutationQueue = pending.catch(() => {});
  return pending;
}

const checkInBatch = [];
let checkInBatchTimer = null;

async function flushCheckInBatch() {
  checkInBatchTimer = null;
  const requests = checkInBatch.splice(0, checkInBatch.length);
  if (!requests.length) return;
  try {
    const results = await withDataMutation(async () => {
      const data = await readData();
      let changed = false;
      const responses = requests.map(({ workspaceId, guestId, checkedIn, operator, publicOnly }) => {
        const workspace = (data.workspaces || []).find((item) => item.id === workspaceId && (!publicOnly || item.details?.selfCheckInEnabled === true));
        if (!workspace) return { status: 404, error: publicOnly ? 'Self check-in is not available for this event.' : 'Event workspace not found' };
        const guest = (workspace.guests || []).find((item) => item.id === guestId);
        if (!guest) return { status: 404, error: 'Guest not found.' };

        // Public retries are idempotent, while staff changes remain auditable.
        if (publicOnly && guest.checkedIn) return { status: 200, guest: checkInGuestView(workspace, guest) };
        const now = new Date().toISOString();
        guest.checkedIn = checkedIn;
        guest.checkedInAt = checkedIn ? now : '';
        guest.checkedInBy = checkedIn ? operator : '';
        guest.checkInHistory = [...(Array.isArray(guest.checkInHistory) ? guest.checkInHistory : []), { checkedIn, at: now, by: operator }].slice(-20);
        workspace.updatedAt = now;
        changed = true;
        return { status: 200, guest: checkInGuestView(workspace, guest, !publicOnly) };
      });
      if (changed) await writeData(data);
      return responses;
    });
    requests.forEach((request, index) => request.resolve(results[index]));
  } catch (error) {
    requests.forEach((request) => request.reject(error));
  }
}

function queueCheckInMutation(update) {
  return new Promise((resolve, reject) => {
    checkInBatch.push({ ...update, resolve, reject });
    if (!checkInBatchTimer) checkInBatchTimer = setTimeout(flushCheckInBatch, 25);
  });
}

let userMutationQueue = Promise.resolve();
function withUserMutation(action) {
  const pending = userMutationQueue.then(action, action);
  userMutationQueue = pending.catch(() => {});
  return pending;
}

function preserveServerManagedState(nextData, currentData) {
  const currentWorkspaces = new Map((currentData.workspaces || []).map((workspace) => [workspace.id, workspace]));
  for (const workspace of nextData.workspaces) {
    const currentWorkspace = currentWorkspaces.get(workspace.id);
    const currentGuests = new Map((currentWorkspace?.guests || []).map((guest) => [guest.id, guest]));
    for (const guest of workspace.guests) {
      const current = currentGuests.get(guest.id);
      if (!current) continue;
      guest.checkedIn = Boolean(current.checkedIn);
      guest.checkedInAt = cleanText(current.checkedInAt, 40);
      guest.checkedInBy = cleanText(current.checkedInBy, 100);
      guest.checkInHistory = Array.isArray(current.checkInHistory) ? current.checkInHistory.slice(-20) : [];
      if (current.invoiceKey) guest.invoiceKey = cleanInvoiceKey(current.invoiceKey);
      if (current.transactionId) guest.transactionId = cleanInvoiceKey(current.transactionId);
      if (current.qrToken && !guest.qrToken) guest.qrToken = cleanInvoiceKey(current.qrToken);
      if (current.bookingMembership?.checkedAt && ((current.bookingMembership.source === 'woocommerce-purchaser' && guest.bookingMembership?.source !== 'woocommerce-purchaser') || !guest.bookingMembership?.checkedAt || Date.parse(current.bookingMembership.checkedAt) > Date.parse(guest.bookingMembership.checkedAt))) {
        guest.bookingMembership = cleanMembership(current.bookingMembership);
        guest.paymentStatus = cleanText(current.paymentStatus, 60);
      }
    }
    const submittedGuestIds = new Set(workspace.guests.map((guest) => guest.id));
    for (const currentGuest of currentWorkspace?.guests || []) {
      if (currentGuest.source === 'manual' && !submittedGuestIds.has(currentGuest.id)) workspace.guests.push(currentGuest);
    }
    // Manual guests deleted through the API stay deleted even if a stale browser tab submits them again.
    workspace.deletedGuestIds = Array.isArray(currentWorkspace?.deletedGuestIds) ? currentWorkspace.deletedGuestIds.slice(-1000) : [];
    if (workspace.deletedGuestIds.length) {
      const deleted = new Set(workspace.deletedGuestIds);
      workspace.guests = workspace.guests.filter((guest) => !deleted.has(guest.id));
    }
    workspace.campaign.testEmailLog = Array.isArray(currentWorkspace?.campaign?.testEmailLog) ? currentWorkspace.campaign.testEmailLog.slice(-20) : [];
    // Delivery records belong to the server; a browser save never replaces them.
    workspace.campaign.deliveries = currentWorkspace?.campaign?.deliveries && typeof currentWorkspace.campaign.deliveries === 'object' ? currentWorkspace.campaign.deliveries : {};
    workspace.campaign.sendJob = currentWorkspace?.campaign?.sendJob || null;
  }
  return nextData;
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin || !allowedOrigins.has(origin) || req.get('x-seating-request') !== '1') return res.status(403).json({ error: 'Request rejected' });
  next();
}

const sign = (value) => createHmac('sha256', process.env.SESSION_SECRET).update(value).digest('base64url');

function issueSession(account) {
  const payload = Buffer.from(JSON.stringify({ username: account.username, role: account.role, expires: Date.now() + sessionLifetimeSeconds * 1000, nonce: randomBytes(12).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionName}=`));
  if (!cookie) return null;
  const [payload, signature] = cookie.slice(sessionName.length + 1).split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const suppliedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof session.username === 'string' && ['admin', 'checkin'].includes(session.role) && session.expires > Date.now() ? session : null;
  } catch { return null; }
}

async function resolveAccount(username) {
  if (username === authUsername) return { username: authUsername, displayName: 'Event Admin', role: 'admin', active: true, passwordHash: storedPasswordHash };
  const data = await readUsers();
  const account = data.users.find((user) => user.username === username);
  return account && account.active !== false ? account : null;
}

async function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Authentication required' });
  try {
    const account = await resolveAccount(session.username);
    if (!account || account.role !== session.role) return res.status(401).json({ error: 'Authentication required' });
    req.seatingSession = session;
    req.seatingUser = { username: account.username, displayName: account.displayName || account.username, role: account.role };
    next();
  } catch (error) { next(error); }
}

function requireAdmin(req, res, next) {
  if (req.seatingUser?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
  next();
}

function mailConfiguration() {
  const testTransport = process.env.NODE_ENV === 'test' && process.env.EMAIL_TEST_TRANSPORT === 'json';
  const relayUrl = cleanText(process.env.WORDPRESS_MAIL_RELAY_URL, 500).trim();
  const relaySecret = typeof process.env.WORDPRESS_MAIL_RELAY_SECRET === 'string' ? process.env.WORDPRESS_MAIL_RELAY_SECRET : '';
  const host = cleanHeader(process.env.SMTP_HOST, 253);
  const port = cleanNumber(process.env.SMTP_PORT, 1, 65535, 587);
  const user = cleanHeader(process.env.SMTP_USER, 254);
  const pass = typeof process.env.SMTP_PASS === 'string' ? process.env.SMTP_PASS : '';
  const fromAddress = cleanHeader(process.env.EMAIL_FROM_ADDRESS, 254);
  const fromName = cleanHeader(process.env.EMAIL_FROM_NAME || 'Event Team', 100);
  let relayConfigured = false;
  try {
    relayConfigured = new URL(relayUrl).protocol === 'https:' && relaySecret.length >= 32;
  } catch {
    relayConfigured = false;
  }
  const smtpConfigured = Boolean(host && user && pass);
  return {
    testTransport,
    relayUrl,
    relaySecret,
    relayConfigured,
    host,
    port,
    user,
    pass,
    fromAddress,
    fromName,
    provider: testTransport ? 'Test transport' : relayConfigured ? 'WordPress mail relay' : 'SMTP',
    configured: isEmail(fromAddress) && (testTransport || relayConfigured || smtpConfigured)
  };
}

function parseEventDate(value) {
  const match = cleanText(value, 80).match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
  if (!match) return null;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const month = months[match[2].slice(0, 3).toLowerCase()];
  if (month == null) return null;
  return { year: Number(match[3]), month, day: Number(match[1]) };
}

function parseEventTime(value, fallbackHour) {
  const match = cleanText(value, 30).match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return { hour: fallbackHour, minute: 0 };
  let hour = Math.min(23, Number(match[1]));
  const period = match[3]?.toLowerCase();
  if (period === 'pm' && hour < 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  return { hour, minute: Math.min(59, Number(match[2] || 0)) };
}

const formatCalendarDate = (date) => `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}00`;
const escapeCalendar = (value) => String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([;,])/g, '\\$1');

function buildCalendarInvite(workspace) {
  const date = parseEventDate(workspace.details?.dateLabel);
  if (!date) return '';
  const startTime = parseEventTime(workspace.details?.startTime, 19);
  const endTime = parseEventTime(workspace.details?.endTime, startTime.hour + 3);
  const start = new Date(Date.UTC(date.year, date.month, date.day, startTime.hour, startTime.minute));
  let end = new Date(Date.UTC(date.year, date.month, date.day, endTime.hour, endTime.minute));
  if (end <= start) end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
  const timeZone = /^[A-Za-z0-9_+\/-]{1,64}$/.test(process.env.EVENT_TIMEZONE || '') ? process.env.EVENT_TIMEZONE : 'UTC';
  const publicBaseHost = (() => { try { return new URL(publicBaseUrl).host; } catch { return 'localhost'; } })();
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Seating Studio//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:event-${workspace.id}@${publicBaseHost}`, `DTSTAMP:${formatCalendarDate(new Date())}Z`,
    `DTSTART;TZID=${timeZone}:${formatCalendarDate(start)}`, `DTEND;TZID=${timeZone}:${formatCalendarDate(end)}`,
    `SUMMARY:${escapeCalendar(workspace.details?.name || 'Event')}`, `LOCATION:${escapeCalendar(workspace.details?.venue || '')}`,
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
}

const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0] || 'Guest';
const tableNumberOf = (table) => String(tableNumber(table) ?? '—');
const ticketKeyFor = (guest) => cleanInvoiceKey(guest?.qrToken) || cleanInvoiceKey(guest?.invoiceKey) || cleanInvoiceKey(guest?.transactionId);
const ticketUrlFor = (guest) => (ticketBaseUrl && ticketKeyFor(guest)) ? `${ticketBaseUrl}${ticketKeyFor(guest)}` : '';
const ticketQrSignature = (workspaceId, guestId) => sign(`ticket-qr:${workspaceId}:${guestId}`);
const ticketQrUrl = (workspace, guest) => ticketUrlFor(guest) ? `${publicBaseUrl}/api/ticket-qr/${encodeURIComponent(workspace.id)}/${encodeURIComponent(guest.id)}?s=${ticketQrSignature(workspace.id, guest.id)}` : '';
const NO_QR_MESSAGE = 'Your name is on our guest list. When you arrive, simply give your full name or email address at the registration desk and our team will check you in.';
const qrCodeBlock = (imageUrl) => imageUrl
  ? `<table role="presentation" align="center" cellspacing="0" cellpadding="0" style="margin:0 auto"><tr><td style="padding:14px;background:#ffffff;border:1px solid #d8e3dc;border-radius:12px"><img src="${escapeHtml(imageUrl)}" width="180" height="180" alt="Your check-in QR code" style="display:block;width:180px;height:180px"></td></tr></table>`
  : `<p style="margin:0;padding:16px 18px;background:#f3f6f2;border:1px solid #d8e3dc;border-radius:12px;color:#26372e;font-size:15px;line-height:1.6">${NO_QR_MESSAGE}</p>`;

// Without a QR, a "present the QR code" paragraph directly above {{qr_code}} would contradict the
// no-QR message, so that one paragraph is dropped. Nothing else in the template changes.
const applyQrCode = (html, imageUrl) => (imageUrl ? html : html.replace(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?\bQR code\b(?:(?!<\/p>)[\s\S])*?<\/p>\s*(?=\{\{qr_code\}\})/gi, ''))
  .split('{{qr_code}}').join(qrCodeBlock(imageUrl));

function renderCampaignEmail(workspace, subject, guest, table, htmlBody = '', { test = true } = {}) {
  const details = workspace.details || {};
  const safeName = escapeHtml(guest.name || 'Guest');
  const safeEvent = escapeHtml(details.name || 'the event');
  const safeTable = escapeHtml(tableNumber(table) == null ? 'Table preview' : tableTitle(table));
  const safeZone = escapeHtml(table.zone || 'Seating area');
  const safeDate = escapeHtml(details.dateLabel || 'Date to be confirmed');
  const safeVenue = escapeHtml(details.venue || 'Venue to be confirmed');
  const safeTime = escapeHtml(details.startTime || 'See event details');
  const safeTicket = escapeHtml(guest.ticketName || 'Event ticket');
  const customTemplate = sanitizeEmailHtml(htmlBody).trim();
  const variables = {
    guest_name: safeName,
    event_name: safeEvent,
    event_date: safeDate,
    start_time: safeTime,
    venue: safeVenue,
    table_name: safeTable,
    table_zone: safeZone,
    ticket_name: safeTicket,
    first_name: escapeHtml(firstNameOf(guest.name)),
    table_number: escapeHtml(tableNumberOf(table))
  };
  const customHtml = Object.entries(variables).reduce((html, [key, value]) => html.split(`{{${key}}}`).join(value), customTemplate);
  const customHtmlWithQr = applyQrCode(customHtml, ticketQrUrl(workspace, guest));
  return {
    subject: test ? `[TEST] ${subject}` : subject,
    text: `${test ? 'TEST EMAIL\n\n' : ''}Dear ${guest.name || 'Guest'},\n\nWe look forward to welcoming you to ${details.name || 'the event'}.\n\nYour table: ${tableNumber(table) == null ? 'Table preview' : tableTitle(table)} (${table.zone || 'Seating area'})\nDate: ${details.dateLabel || 'To be confirmed'}\nTime: ${details.startTime || 'See event details'}\nVenue: ${details.venue || 'To be confirmed'}\nTicket: ${guest.ticketName || 'Event ticket'}${test ? '\n\nThis is a test email. No guest campaign has been sent.' : ''}`,
    html: customHtmlWithQr || `<!doctype html><html><body style="margin:0;background:#edf0ec;font-family:Arial,sans-serif;color:#17201b"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#edf0ec;padding:24px 12px"><tr><td align="center"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#fff;border-radius:12px;overflow:hidden"><tr><td style="padding:12px 28px;background:#e8f4ed;color:#176e4c;font-size:12px;font-weight:700;letter-spacing:.08em">TEST EMAIL · NO GUEST CAMPAIGN SENT</td></tr><tr><td style="padding:32px 34px;text-align:center"><div style="font-size:22px;font-weight:800;color:#173e2b">${safeEvent}</div><p style="margin:28px 0 5px;color:#176e4c;font-size:12px;font-weight:700">${safeDate}</p><h1 style="margin:0;font-size:30px;line-height:1.15">Your place is ready.</h1><p style="margin:12px auto 24px;max-width:430px;color:#657068;font-size:15px;line-height:1.6">Dear ${safeName}, we look forward to welcoming you to ${safeEvent}.</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#173e2b;color:#fff;border-radius:10px"><tr><td style="padding:22px;text-align:left"><div style="font-size:11px;letter-spacing:.12em;color:#b7cabe">YOUR TABLE</div><div style="margin:6px 0;font-size:38px;font-weight:800">${safeTable}</div><div style="font-size:13px;color:#d8e3dc">${safeZone}</div></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:18px"><tr><td style="padding:8px;font-size:12px;color:#657068"><b style="display:block;color:#17201b">Start</b>${safeTime}</td><td style="padding:8px;font-size:12px;color:#657068"><b style="display:block;color:#17201b">Venue</b>${safeVenue}</td><td style="padding:8px;font-size:12px;color:#657068"><b style="display:block;color:#17201b">Ticket</b>${safeTicket}</td></tr></table><p style="margin:24px 0 0;color:#849087;font-size:11px;line-height:1.5">This test uses the current campaign settings. A guest-specific MEC QR will be added only after its live ticket payload is verified.</p></td></tr></table></td></tr></table></body></html>`
  };
}

async function sendViaWordPress(configuration, mail) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const body = JSON.stringify({
    kind: mail.kind || 'campaign-test',
    to: mail.to,
    replyTo: mail.replyTo || '',
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    calendar: mail.calendar || '',
    inlineAssets: Array.isArray(mail.inlineAssets) ? mail.inlineAssets : []
  });
  const signature = createHmac('sha256', configuration.relaySecret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
  const response = await fetch(configuration.relayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Seating-Studio/1.0',
      'X-Seating-Studio-Timestamp': timestamp,
      'X-Seating-Studio-Nonce': nonce,
      'X-Seating-Studio-Signature': signature
    },
    body,
    signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.sent !== true) {
    const error = new Error('WordPress mail relay rejected the request');
    error.code = 'MAIL_RELAY_REJECTED';
    throw error;
  }
  return { messageId: cleanText(result.messageId || `relay-${nonce}`, 200), response: String(response.status) };
}

async function sendTransactionalMail(configuration, mail) {
  if (configuration.relayConfigured && !configuration.testTransport) return sendViaWordPress(configuration, mail);
  const transport = configuration.testTransport
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
      host: configuration.host,
      port: configuration.port,
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || configuration.port === 465,
      requireTLS: configuration.port !== 465 && String(process.env.SMTP_REQUIRE_TLS || 'true').toLowerCase() !== 'false',
      auth: { user: configuration.user, pass: configuration.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      disableFileAccess: true,
      disableUrlAccess: true
    });
  return transport.sendMail({
    from: { name: configuration.fromName, address: configuration.fromAddress },
    to: mail.to,
    replyTo: mail.replyTo || undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    icalEvent: mail.calendar ? { method: 'PUBLISH', filename: 'event.ics', content: mail.calendar } : undefined,
    headers: mail.kind === 'self-checkin-code' ? { 'X-Seating-Studio-Self-Check-In': 'verification' } : mail.kind === 'campaign' ? { 'X-Seating-Studio-Campaign': 'guest' } : { 'X-Seating-Studio-Campaign-Test': 'true' },
    disableFileAccess: true,
    disableUrlAccess: true
  });
}

async function sendTestCampaign(workspace, options) {
  const configuration = mailConfiguration();
  if (!configuration.configured) return { configuration, error: 'not-configured' };
  const assignedGuest = (workspace.guests || []).find((guest) => guest.id === options.previewGuestId && guest.tableId)
    || (workspace.guests || []).find((guest) => guest.tableId)
    || { name: 'Sample Guest', ticketName: 'Event ticket', tableId: null };
  const table = (workspace.tables || []).find((item) => item.id === assignedGuest.tableId) || { name: 'Table preview', zone: 'Main floor' };
  const message = renderCampaignEmail(workspace, options.subject, assignedGuest, table, options.htmlBody);
  const calendar = options.attachCalendar ? buildCalendarInvite(workspace) : '';
  const info = await sendTransactionalMail(configuration, {
    kind: 'campaign-test', to: options.to, replyTo: options.replyTo,
    subject: message.subject, text: message.text, html: message.html, calendar, inlineAssets: message.inlineAssets
  });
  return { configuration, info, previewName: assignedGuest.name };
}

function slidingWindowLimit(store, key, { limit, windowMs, maxKeys = 10_000 }) {
  const now = Date.now();
  const recent = (store.get(key) || []).filter((time) => now - time < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  store.set(key, recent);
  if (store.size > maxKeys) {
    for (const [storedKey, times] of store) {
      if (!times.some((time) => now - time < windowMs)) store.delete(storedKey);
      if (store.size <= maxKeys) break;
    }
    while (store.size > maxKeys) store.delete(store.keys().next().value);
  }
  return true;
}

const attempts = new Map();
function loginRateLimit(req, res, next) {
  if (!slidingWindowLimit(attempts, req.ip, { limit: 10, windowMs: 15 * 60 * 1000, maxKeys: 5_000 })) return res.status(429).json({ error: 'Too many attempts' });
  next();
}

const CAMPAIGN_SEND_INTERVAL_MS = cleanNumber(process.env.CAMPAIGN_SEND_INTERVAL_MS, 0, 60_000, 3000);
const CAMPAIGN_MAX_CONSECUTIVE_FAILURES = 5;
const campaignWorkers = new Set();
const normalizedEmail = (value) => String(value || '').trim().toLowerCase();

// Recipients are seated guests with a valid email. "unsent" covers never-emailed and failed guests;
// "changed" covers guests already emailed whose table number or address has since changed.
function campaignAudience(workspace, mode) {
  const tables = new Map((workspace.tables || []).map((table) => [table.id, table]));
  const deliveries = workspace.campaign?.deliveries || {};
  const counts = { seated: 0, unseated: 0, noEmail: 0, sent: 0, failed: 0, unsent: 0, changed: 0 };
  const unsent = [];
  const changed = [];
  for (const guest of workspace.guests || []) {
    const table = tables.get(guest.tableId);
    if (!table) { counts.unseated += 1; continue; }
    counts.seated += 1;
    const email = normalizedEmail(guest.email);
    if (!isEmail(email)) { counts.noEmail += 1; continue; }
    const delivery = deliveries[guest.id];
    if (delivery?.status === 'sent') {
      counts.sent += 1;
      if (delivery.to !== email || delivery.tableNumber !== tableNumberOf(table)) changed.push(guest.id);
    } else {
      if (delivery?.status === 'failed') counts.failed += 1;
      unsent.push(guest.id);
    }
  }
  counts.unsent = unsent.length;
  counts.changed = changed.length;
  return { counts, recipients: mode === 'changed' ? changed : mode === 'unsent' ? unsent : [] };
}

const publicSendJob = (job) => job ? {
  id: job.id, mode: job.mode, status: job.status, subject: job.template?.subject || '', total: job.total, sent: job.sent, failed: job.failed, skipped: job.skipped,
  startedAt: job.startedAt, startedBy: job.startedBy, finishedAt: job.finishedAt || '', pauseReason: job.pauseReason || ''
} : null;

async function runCampaignJob(workspaceId, jobId) {
  const key = `${workspaceId}:${jobId}`;
  if (campaignWorkers.has(key)) return;
  campaignWorkers.add(key);
  let consecutiveFailures = 0;
  try {
    for (;;) {
      const step = await withDataMutation(async () => {
        const data = await readData();
        const workspace = (data.workspaces || []).find((item) => item.id === workspaceId);
        const job = workspace?.campaign?.sendJob;
        if (!job || job.id !== jobId || job.status !== 'running') return null;
        const finish = async (status) => { job.status = status; job.finishedAt = new Date().toISOString(); await writeData(data); return null; };
        if (job.stopRequested) return finish('stopped');
        if (job.cursor >= job.recipients.length) return finish('completed');
        const guestId = job.recipients[job.cursor];
        job.cursor += 1;
        const guest = (workspace.guests || []).find((item) => item.id === guestId);
        const table = guest && (workspace.tables || []).find((item) => item.id === guest.tableId);
        const email = normalizedEmail(guest?.email);
        workspace.campaign.deliveries ||= {};
        const previous = workspace.campaign.deliveries[guestId];
        // Re-check at send time: the guest may have been unseated, removed or already emailed since the job started.
        const alreadyCurrent = previous?.status === 'sent' && previous.to === email && table && previous.tableNumber === tableNumberOf(table);
        if (!guest || !table || !isEmail(email) || alreadyCurrent || previous?.status === 'sending') {
          job.skipped += 1;
          await writeData(data);
          return { skipped: true };
        }
        workspace.campaign.deliveries[guestId] = { status: 'sending', to: email, tableNumber: tableNumberOf(table), at: new Date().toISOString(), jobId };
        await writeData(data);
        return { workspace: structuredClone({ id: workspace.id, details: workspace.details, tables: workspace.tables }), guest: structuredClone(guest), table: structuredClone(table), email, template: job.template };
      });
      if (!step) break;
      if (step.skipped) continue;

      let outcome;
      try {
        const message = renderCampaignEmail(step.workspace, step.template.subject, step.guest, step.table, step.template.htmlBody, { test: false });
        const info = await sendTransactionalMail(mailConfiguration(), {
          kind: 'campaign', to: step.email, replyTo: step.template.replyTo,
          subject: message.subject, text: message.text, html: message.html,
          calendar: step.template.attachCalendar ? buildCalendarInvite(step.workspace) : '', inlineAssets: message.inlineAssets
        });
        outcome = { status: 'sent', messageId: cleanText(info?.messageId, 200) };
        consecutiveFailures = 0;
      } catch (error) {
        console.error(`[seating-api] Campaign email failed: ${error.code || error.name || 'delivery-error'}`);
        outcome = { status: 'failed', error: error.code === 'MAIL_RELAY_REJECTED' ? 'The mail provider rejected this email.' : 'The email could not be handed to the mail provider.' };
        consecutiveFailures += 1;
      }

      const keepGoing = await withDataMutation(async () => {
        const data = await readData();
        const workspace = (data.workspaces || []).find((item) => item.id === workspaceId);
        if (!workspace) return false;
        workspace.campaign ||= {};
        workspace.campaign.deliveries ||= {};
        workspace.campaign.deliveries[step.guest.id] = { ...outcome, to: step.email, tableNumber: tableNumberOf(step.table), at: new Date().toISOString(), jobId };
        const job = workspace.campaign.sendJob;
        if (job?.id === jobId) {
          job[outcome.status === 'sent' ? 'sent' : 'failed'] += 1;
          if (consecutiveFailures >= CAMPAIGN_MAX_CONSECUTIVE_FAILURES && job.status === 'running') {
            job.status = 'paused';
            job.pauseReason = `Paused after ${CAMPAIGN_MAX_CONSECUTIVE_FAILURES} failed emails in a row. Check the mail provider, then send again.`;
            job.finishedAt = new Date().toISOString();
          }
        }
        await writeData(data);
        return job?.id === jobId && job.status === 'running';
      });
      if (!keepGoing) break;
      if (CAMPAIGN_SEND_INTERVAL_MS) await new Promise((resolve) => setTimeout(resolve, CAMPAIGN_SEND_INTERVAL_MS));
    }
  } catch (error) {
    console.error(`[seating-api] Campaign job stopped: ${error.name}`);
  } finally {
    campaignWorkers.delete(key);
  }
}

// A restart interrupts a running job. An email marked "sending" may or may not have left, so it is
// reported as failed with that caveat, and it is only resent if the organiser sends again.
async function recoverInterruptedCampaigns() {
  await withDataMutation(async () => {
    const data = await readData();
    let changed = false;
    for (const workspace of data.workspaces || []) {
      const campaign = workspace.campaign;
      if (!campaign) continue;
      for (const delivery of Object.values(campaign.deliveries || {})) {
        if (delivery?.status === 'sending') { delivery.status = 'failed'; delivery.error = 'Interrupted by a server restart. It may already have been delivered.'; changed = true; }
      }
      if (campaign.sendJob?.status === 'running') {
        campaign.sendJob.status = 'paused';
        campaign.sendJob.pauseReason = 'Paused by a server restart. Send again to continue with guests not yet emailed.';
        campaign.sendJob.finishedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await writeData(data);
  });
}

const testEmailAttempts = new Map();
function testEmailRateLimit(req, res, next) {
  const key = `${req.seatingUser?.username || req.ip}:${req.ip}`;
  if (!slidingWindowLimit(testEmailAttempts, key, { limit: 5, windowMs: 10 * 60 * 1000, maxKeys: 5_000 })) return res.status(429).json({ error: 'Too many test emails. Please wait before trying again.' });
  next();
}

app.get('/api/auth/session', async (req, res, next) => {
  try {
    const session = readSession(req);
    const account = session ? await resolveAccount(session.username) : null;
    if (!account || account.role !== session?.role) return res.json({ authenticated: false });
    res.json({ authenticated: true, username: account.username, displayName: account.displayName || account.username, role: account.role });
  } catch (error) { next(error); }
});
app.post('/api/auth/login', requireSameOrigin, loginRateLimit, async (req, res, next) => {
  try {
    const username = cleanText(req.body?.username, 100).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
    const account = await resolveAccount(username);
    const comparisonHash = (account?.passwordHash || storedPasswordHash).replace(/^\$2y\$/, '$2b$');
    const validPassword = await bcrypt.compare(password, comparisonHash);
    if (!account || !validPassword) return res.status(401).json({ error: 'Invalid credentials' });
    attempts.delete(req.ip);
    res.setHeader('Set-Cookie', `${sessionName}=${issueSession(account)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionLifetimeSeconds}`);
    res.json({ authenticated: true, username: account.username, displayName: account.displayName || account.username, role: account.role });
  } catch (error) { next(error); }
});
app.post('/api/auth/logout', requireSameOrigin, (req, res) => {
  res.setHeader('Set-Cookie', `${sessionName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  res.json({ authenticated: false });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/workspaces', requireAuth, requireAdmin, async (_req, res, next) => { try { const data = await readData(); res.json({ ...data, revision: dataRevision(data) }); } catch (error) { next(error); } });
app.get('/api/workspaces/revision', requireAuth, requireAdmin, async (_req, res, next) => { try { res.json({ revision: dataRevision(await readData()) }); } catch (error) { next(error); } });
app.put('/api/workspaces', requireAuth, requireAdmin, requireSameOrigin, async (req, res, next) => {
  try {
    const payload = normalizePayload(req.body);
    const baseRevision = Number(req.get('X-Base-Revision'));
    const result = await withDataMutation(async () => {
      const current = await readData();
      const currentRevision = dataRevision(current);
      // A browser holding an older copy must reload instead of replacing newer work.
      if (!Number.isInteger(baseRevision) || req.get('X-Base-Revision') == null || baseRevision !== currentRevision) return { conflict: true, revision: currentRevision };
      const next = preserveServerManagedState(payload, current);
      for (const workspace of next.workspaces) {
        if (new Set(workspace.tables.map(t => t.id)).size !== workspace.tables.length) throw new Error('Invalid layout: duplicate table IDs');
        if (workspace.tables.some(t => !Number.isInteger(t.capacity) || workspace.guests.filter(g => g.tableId === t.id).length > t.capacity)) throw new Error('Invalid layout: a table exceeds its seat capacity');
        if (workspace.guests.some(g => g.tableId && !workspace.tables.some(t => t.id === g.tableId))) throw new Error('Invalid layout: an occupied table was removed');
      }
      next.revision = currentRevision + 1;
      await snapshotData(currentRevision);
      await writeData(next);
      return { revision: next.revision };
    });
    if (result.conflict) return res.status(409).json({ error: 'This seating plan was changed by someone else. Reload to get the latest version before editing.', conflict: true, revision: result.revision });
    res.json({ saved: true, revision: result.revision, updatedAt: new Date().toISOString() });
  }
  catch (error) { if (error.message.startsWith('Invalid')) return res.status(400).json({ error: error.message }); next(error); }
});

app.post('/api/workspaces/:workspaceId/guests', requireAuth, requireAdmin, requireSameOrigin, async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    const name = cleanText(req.body?.name, 160).trim();
    const email = cleanText(req.body?.email, 254).trim().toLowerCase();
    const company = cleanText(req.body?.company, 180).trim();
    const title = cleanText(req.body?.title, 180).trim();
    const ticketName = cleanText(req.body?.ticketName, 160).trim();
    const requestedTableId = req.body?.tableId == null || req.body.tableId === '' ? null : Number(req.body.tableId);
    if (!/^[a-zA-Z0-9-]+$/.test(workspaceId) || !name || !isEmail(email)) return res.status(400).json({ error: 'Full name and a valid email address are required.' });

    const guest = await withDataMutation(async () => {
      const data = await readData();
      const workspace = (data.workspaces || []).find((item) => item.id === workspaceId);
      if (!workspace) return { status: 404, error: 'Event workspace not found.' };
      if ((workspace.guests || []).some((item) => String(item.email || '').trim().toLowerCase() === email)) return { status: 409, error: 'A guest with this email address already exists in the event.' };

      let tableId = null;
      if (requestedTableId != null) {
        const table = (workspace.tables || []).find((item) => Number(item.id) === requestedTableId);
        if (!table) return { status: 400, error: 'Select a valid table or leave the guest unseated.' };
        const occupied = (workspace.guests || []).filter((item) => Number(item.tableId) === requestedTableId).length;
        if (occupied >= Number(table.capacity || 0)) return { status: 409, error: `${tableAdminTitle(table)} is already full.` };
        tableId = requestedTableId;
      }

      const created = {
        id: `MANUAL-${Date.now()}-${randomBytes(6).toString('hex')}`,
        name,
        email,
        company,
        title,
        ticketName,
        tableId,
        vip: Boolean(req.body?.vip),
        source: 'manual',
        bookingId: '',
        attendeeKey: '',
        invoiceKey: '',
        transactionId: '',
        qrToken: '',
        paymentStatus: 'Manually added',
        checkedIn: false,
        checkedInAt: '',
        checkedInBy: '',
        checkInHistory: []
      };
      workspace.guests ||= [];
      workspace.guests.unshift(created);
      workspace.updatedAt = new Date().toISOString();
      await writeData(data);
      return { guest: created };
    });
    if (guest.error) return res.status(guest.status).json({ error: guest.error });
    res.status(201).json(guest);
  } catch (error) { next(error); }
});

app.delete('/api/workspaces/:workspaceId/guests/:guestId', requireAuth, requireAdmin, requireSameOrigin, async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    const guestId = cleanText(req.params.guestId, 100);
    if (!/^[a-zA-Z0-9-]+$/.test(workspaceId) || !/^[A-Za-z0-9_-]+$/.test(guestId)) return res.status(400).json({ error: 'Invalid guest reference.' });
    const result = await withDataMutation(async () => {
      const data = await readData();
      const workspace = (data.workspaces || []).find((item) => item.id === workspaceId);
      if (!workspace) return { status: 404, error: 'Event workspace not found.' };
      const guest = (workspace.guests || []).find((item) => item.id === guestId);
      if (!guest) return { status: 404, error: 'Guest not found. They may already have been deleted.' };
      if (guest.source !== 'manual') return { status: 409, error: 'Only manually added guests can be deleted. MEC guests are removed by syncing after their booking is cancelled or set to draft.' };
      workspace.guests = workspace.guests.filter((item) => item.id !== guestId);
      workspace.deletedGuestIds = [...(Array.isArray(workspace.deletedGuestIds) ? workspace.deletedGuestIds : []), guestId].slice(-1000);
      workspace.updatedAt = new Date().toISOString();
      await writeData(data);
      return { deleted: { id: guest.id, name: guest.name } };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (error) { next(error); }
});

app.get('/api/email/status', requireAuth, requireAdmin, (_req, res) => {
  const configuration = mailConfiguration();
  res.json({ configured: configuration.configured, provider: configuration.provider, fromAddress: configuration.configured ? configuration.fromAddress : '' });
});

app.post('/api/workspaces/:workspaceId/campaign/test-email', requireAuth, requireAdmin, requireSameOrigin, testEmailRateLimit, async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    const to = cleanHeader(req.body?.to, 254).toLowerCase();
    const subject = cleanHeader(req.body?.subject, 200);
    const replyTo = cleanHeader(req.body?.replyTo, 254).toLowerCase();
    const previewGuestId = cleanText(req.body?.previewGuestId, 100);
    if (!/^[a-zA-Z0-9-]+$/.test(workspaceId) || !isEmail(to) || !subject || (replyTo && !isEmail(replyTo))) return res.status(400).json({ error: 'Enter a valid test recipient, subject, and reply-to address.' });
    const configuration = mailConfiguration();
    if (!configuration.configured) return res.status(503).json({ error: 'Email delivery is not configured on the server yet.' });
    const data = await readData();
    const workspace = (data.workspaces || []).find((item) => item.id === workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Event workspace not found.' });
    let delivery;
    try {
      delivery = await sendTestCampaign(workspace, { to, subject, replyTo, previewGuestId, htmlBody: sanitizeEmailHtml(req.body?.htmlBody), attachCalendar: req.body?.attachCalendar !== false });
    } catch (error) {
      console.error(`[seating-api] Test email failed: ${error.code || error.name || 'delivery-error'}`);
      return res.status(502).json({ error: 'The mail provider rejected the test. Check the mail delivery settings and try again.' });
    }
    const sentAt = new Date().toISOString();
    const messageId = cleanText(delivery.info?.messageId, 200);
    await withDataMutation(async () => {
      const current = await readData();
      const target = (current.workspaces || []).find((item) => item.id === workspaceId);
      if (!target) return;
      target.campaign ||= {};
      target.campaign.testEmailLog = [...(Array.isArray(target.campaign.testEmailLog) ? target.campaign.testEmailLog : []), { to, sentAt, by: req.seatingUser.username, messageId }].slice(-20);
      target.updatedAt = sentAt;
      await writeData(current);
    });
    res.json({ sent: true, to, sentAt, messageId, previewName: delivery.previewName });
  } catch (error) { next(error); }
});

app.get('/api/workspaces/:workspaceId/campaign/send-status', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    const workspace = ((await readData()).workspaces || []).find((item) => item.id === workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Event workspace not found.' });
    const deliveries = workspace.campaign?.deliveries || {};
    const guestsById = new Map((workspace.guests || []).map((guest) => [guest.id, guest]));
    const failures = Object.entries(deliveries).filter(([, delivery]) => delivery?.status === 'failed').slice(0, 500)
      .map(([guestId, delivery]) => ({ guestId, name: guestsById.get(guestId)?.name || 'Removed guest', to: delivery.to, error: delivery.error || '', at: delivery.at }));
    res.json({
      job: publicSendJob(workspace.campaign?.sendJob),
      counts: campaignAudience(workspace, 'unsent').counts,
      deliveries: Object.fromEntries(Object.entries(deliveries).map(([guestId, delivery]) => [guestId, { status: delivery.status, at: delivery.at, tableNumber: delivery.tableNumber }])),
      failures,
      mailConfigured: mailConfiguration().configured
    });
  } catch (error) { next(error); }
});

app.post('/api/workspaces/:workspaceId/campaign/send', requireAuth, requireAdmin, requireSameOrigin, testEmailRateLimit, async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    const mode = req.body?.mode === 'changed' ? 'changed' : req.body?.mode === 'unsent' ? 'unsent' : '';
    const expectedCount = Number(req.body?.expectedCount);
    const subject = cleanHeader(req.body?.subject, 200).trim();
    const replyTo = cleanHeader(req.body?.replyTo, 254).trim().toLowerCase();
    const htmlBody = sanitizeEmailHtml(req.body?.htmlBody).trim();
    if (!/^[a-zA-Z0-9-]+$/.test(workspaceId) || !mode || !Number.isInteger(expectedCount) || !subject || !htmlBody || (replyTo && !isEmail(replyTo))) return res.status(400).json({ error: 'A subject, email body, valid reply-to address and recipient group are required.' });
    if (req.body?.confirmation !== 'SEND') return res.status(400).json({ error: 'Type SEND to confirm.' });
    if (!mailConfiguration().configured) return res.status(503).json({ error: 'Email delivery is not configured on the server yet.' });
    const result = await withDataMutation(async () => {
      const data = await readData();
      const workspace = (data.workspaces || []).find((item) => item.id === workspaceId);
      if (!workspace) return { status: 404, error: 'Event workspace not found.' };
      if (workspace.campaign?.sendJob?.status === 'running') return { status: 409, error: 'Emails are already being sent for this event.' };
      const { recipients } = campaignAudience(workspace, mode);
      if (!recipients.length) return { status: 400, error: 'There are no guests to email in this group.' };
      if (recipients.length !== expectedCount) return { status: 409, error: `The guest list changed: ${recipients.length} guests would now receive this email. Review the numbers and confirm again.`, count: recipients.length };
      workspace.campaign ||= {};
      const attachCalendar = req.body?.attachCalendar !== false;
      Object.assign(workspace.campaign, { subject, replyTo, htmlBody, attachCalendar });
      workspace.campaign.sendJob = {
        id: randomBytes(8).toString('hex'), mode, status: 'running', recipients, cursor: 0, total: recipients.length, sent: 0, failed: 0, skipped: 0,
        startedAt: new Date().toISOString(), startedBy: req.seatingUser.username, template: { subject, replyTo, htmlBody, attachCalendar }
      };
      await writeData(data);
      return { job: workspace.campaign.sendJob };
    });
    if (result.error) return res.status(result.status).json({ error: result.error, count: result.count });
    runCampaignJob(workspaceId, result.job.id);
    res.status(202).json({ job: publicSendJob(result.job) });
  } catch (error) { next(error); }
});

app.post('/api/workspaces/:workspaceId/campaign/send/stop', requireAuth, requireAdmin, requireSameOrigin, async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    const job = await withDataMutation(async () => {
      const data = await readData();
      const workspace = (data.workspaces || []).find((item) => item.id === workspaceId);
      const current = workspace?.campaign?.sendJob;
      if (!current || current.status !== 'running') return current || null;
      current.stopRequested = true;
      await writeData(data);
      return current;
    });
    if (!job) return res.status(404).json({ error: 'No email send has been started.' });
    res.json({ job: publicSendJob(job) });
  } catch (error) { next(error); }
});

app.get('/api/check-in/events', requireAuth, async (_req, res, next) => {
  try {
    const data = await readData();
    res.json({
      currentWorkspaceId: data.currentWorkspaceId || data.workspaces?.[0]?.id || null,
      events: (data.workspaces || []).map((workspace) => ({ id: workspace.id, details: workspace.details || {} }))
    });
  } catch (error) { next(error); }
});

app.get('/api/users', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const data = await readUsers();
    res.json({ users: data.users.map(({ passwordHash: _passwordHash, ...user }) => user) });
  } catch (error) { next(error); }
});

app.post('/api/users', requireAuth, requireAdmin, requireSameOrigin, async (req, res, next) => {
  try {
    const username = cleanText(req.body?.username, 50).trim().toLowerCase();
    const displayName = cleanText(req.body?.displayName, 100).trim();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!/^[a-z0-9._-]{3,50}$/.test(username) || !displayName || password.length < 12 || password.length > 200) return res.status(400).json({ error: 'Use a valid username, display name, and password of at least 12 characters' });
    if (username === authUsername) return res.status(409).json({ error: 'That username is already in use' });
    const created = await withUserMutation(async () => {
      const data = await readUsers();
      if (data.users.some((user) => user.username === username)) return null;
      const now = new Date().toISOString();
      const user = { username, displayName, role: 'checkin', active: true, passwordHash: await bcrypt.hash(password, 12), createdAt: now, createdBy: req.seatingUser.username };
      data.users.push(user);
      await writeUsers(data);
      const { passwordHash: _passwordHash, ...publicUser } = user;
      return publicUser;
    });
    if (!created) return res.status(409).json({ error: 'That username is already in use' });
    res.status(201).json({ user: created });
  } catch (error) { next(error); }
});

app.patch('/api/users/:username', requireAuth, requireAdmin, requireSameOrigin, async (req, res, next) => {
  try {
    const username = cleanText(req.params.username, 50).toLowerCase();
    if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'Invalid user update' });
    const updated = await withUserMutation(async () => {
      const data = await readUsers();
      const user = data.users.find((item) => item.username === username);
      if (!user) return null;
      user.active = req.body.active;
      user.updatedAt = new Date().toISOString();
      user.updatedBy = req.seatingUser.username;
      await writeUsers(data);
      const { passwordHash: _passwordHash, ...publicUser } = user;
      return publicUser;
    });
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json({ user: updated });
  } catch (error) { next(error); }
});

function checkInGuestView(workspace, guest, includeScannerReference = false) {
  const table = (workspace.tables || []).find((item) => item.id === guest.tableId);
  return {
    id: guest.id,
    name: guest.name,
    email: guest.email,
    company: guest.company,
    title: guest.title,
    vip: Boolean(guest.vip),
    bookingId: guest.bookingId || '',
    attendeeKey: guest.attendeeKey || '',
    ...(includeScannerReference ? { invoiceKey: guest.invoiceKey || '', transactionId: guest.transactionId || '', qrToken: guest.qrToken || '' } : {}),
    ticketName: guest.ticketName || '',
    tableId: guest.tableId || null,
    // Guests and check-in staff only ever see the table number, never the admin label.
    tableName: table ? tableTitle(table) : '',
    tableNumber: table ? tableNumber(table) : null,
    zone: table?.zone || '',
    checkedIn: Boolean(guest.checkedIn),
    checkedInAt: guest.checkedInAt || '',
    checkedInBy: guest.checkedInBy || ''
  };
}

const selfCheckInAttempts = new Map();
const selfCheckInChallenges = new Map();
function selfCheckInRateLimit(req, res, next) {
  const email = cleanHeader(req.body?.email, 254).toLowerCase();
  const ipAllowed = slidingWindowLimit(selfCheckInAttempts, `ip:${req.ip}`, { limit: 750, windowMs: 15 * 60 * 1000, maxKeys: 10_000 });
  const emailAllowed = slidingWindowLimit(selfCheckInAttempts, `email:${sign(email).slice(0, 24)}`, { limit: 5, windowMs: 15 * 60 * 1000, maxKeys: 10_000 });
  if (!ipAllowed || !emailAllowed) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  next();
}

function issueSelfCheckInToken(workspaceId, guestIds) {
  const payload = Buffer.from(JSON.stringify({ kind: 'self-check-in', workspaceId, guestIds, expires: Date.now() + 30 * 60 * 1000, nonce: randomBytes(12).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSelfCheckInToken(req) {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const suppliedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return value.kind === 'self-check-in' && /^[a-zA-Z0-9-]+$/.test(value.workspaceId) && Array.isArray(value.guestIds) && value.expires > Date.now() ? value : null;
  } catch { return null; }
}

function publicSelfCheckInPayload(workspace, guestIds) {
  return {
    event: { id: workspace.id, name: workspace.details?.name || 'Event', dateLabel: workspace.details?.dateLabel || '', venue: workspace.details?.venue || '', startTime: workspace.details?.startTime || '', endTime: workspace.details?.endTime || '' },
    guests: (workspace.guests || []).filter((guest) => guestIds.includes(guest.id)).map((guest) => checkInGuestView(workspace, guest))
  };
}

const ticketResolveAttempts = new Map();
const ticketResolveCache = new Map();
app.get('/api/check-in/resolve-ticket', requireAuth, async (req, res, next) => {
  try {
    if (!mecOrigin) return res.status(503).json({ error: 'MEC is not configured' });
    if (!slidingWindowLimit(ticketResolveAttempts, `${req.seatingUser?.username || ''}:${req.ip}`, { limit: 60, windowMs: 60 * 1000, maxKeys: 5_000 })) return res.status(429).json({ error: 'Too many ticket lookups. Wait a moment and scan again.' });
    const key = String(req.query.key || '').trim();
    if (!/^[A-Za-z0-9._-]{4,64}$/.test(key)) return res.status(400).json({ error: 'Invalid ticket reference' });
    const cached = ticketResolveCache.get(key);
    if (cached?.expires > Date.now()) return cached.invoiceKey ? res.json({ invoiceKey: cached.invoiceKey }) : res.status(404).json({ error: 'Ticket not recognised' });
    let invoiceKey = '';
    try {
      const upstream = await fetch(`${mecOrigin}/invoice/${encodeURIComponent(key)}`, { redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(10_000) });
      const location = upstream.headers.get('location') || '';
      const target = upstream.status >= 300 && upstream.status < 400 && /^https:\/\//i.test(location) ? new URL(location) : null;
      if (target && target.hostname.toLowerCase() === mecHost) {
        const preview = target.searchParams.get('makePreview') || '';
        if (/^[0-9a-f]{40}$/i.test(preview)) invoiceKey = preview;
      }
    } catch { return res.status(502).json({ error: 'The ticket site could not be reached to verify the ticket' }); }
    ticketResolveCache.set(key, { invoiceKey, expires: Date.now() + (invoiceKey ? 15 * 60 * 1000 : 60 * 1000) });
    while (ticketResolveCache.size > 2_000) ticketResolveCache.delete(ticketResolveCache.keys().next().value);
    if (!invoiceKey) return res.status(404).json({ error: 'Ticket not recognised' });
    res.json({ invoiceKey });
  } catch (error) { next(error); }
});

const ticketQrAttempts = new Map();
app.get('/api/ticket-qr/:workspaceId/:guestId', async (req, res, next) => {
  try {
    if (!slidingWindowLimit(ticketQrAttempts, req.ip, { limit: 120, windowMs: 60 * 1000, maxKeys: 10_000 })) return res.status(429).end();
    const workspaceId = cleanText(req.params.workspaceId, 100);
    const guestId = cleanText(req.params.guestId, 100);
    const signature = String(req.query.s || '');
    if (!/^[a-zA-Z0-9-]+$/.test(workspaceId) || !/^[A-Za-z0-9_-]+$/.test(guestId) || !/^[A-Za-z0-9_-]{20,100}$/.test(signature)) return res.status(404).end();
    if (sign(ticketQrSignature(workspaceId, guestId)) !== sign(signature)) return res.status(404).end();
    const data = await readData();
    const guest = ((data.workspaces || []).find((item) => item.id === workspaceId)?.guests || []).find((item) => item.id === guestId);
    const ticketUrl = ticketUrlFor(guest);
    if (!ticketUrl) return res.status(404).end();
    const png = await QRCode.toBuffer(ticketUrl, { type: 'png', width: 360, margin: 2, errorCorrectionLevel: 'M' });
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.send(png);
  } catch (error) { next(error); }
});

app.get('/api/public/self-check-in', async (_req, res, next) => {
  try {
    const data = await readData();
    const events = (data.workspaces || []).filter((workspace) => workspace.details?.selfCheckInEnabled === true).map((workspace) => ({ id: workspace.id, name: workspace.details?.name || 'Event', dateLabel: workspace.details?.dateLabel || '', venue: workspace.details?.venue || '', startTime: workspace.details?.startTime || '', endTime: workspace.details?.endTime || '' }));
    const timeZone = /^[A-Za-z0-9_+\/-]{1,64}$/.test(process.env.EVENT_TIMEZONE || '') ? process.env.EVENT_TIMEZONE : 'UTC';
    const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const currentEvent = events.find((event) => { const date = parseEventDate(event.dateLabel); return date && date.year === todayParts.year && date.month + 1 === todayParts.month && date.day === todayParts.day; }) || null;
    res.json({ events, currentEvent, timeZone });
  } catch (error) { next(error); }
});

app.get('/api/public/self-check-in/:workspaceId', async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    if (!/^[a-zA-Z0-9-]+$/.test(workspaceId)) return res.status(404).json({ error: 'Self check-in is not available for this event.' });
    const data = await readData();
    const workspace = (data.workspaces || []).find((item) => item.id === workspaceId && item.details?.selfCheckInEnabled === true);
    if (!workspace) return res.status(404).json({ error: 'Self check-in is not available for this event.' });
    res.json({ event: { id: workspace.id, name: workspace.details?.name || 'Event', dateLabel: workspace.details?.dateLabel || '', venue: workspace.details?.venue || '', startTime: workspace.details?.startTime || '', endTime: workspace.details?.endTime || '' }, verificationRequired: workspace.details?.selfCheckInVerification === true });
  } catch (error) { next(error); }
});

app.post('/api/public/self-check-in/:workspaceId/start', requireSameOrigin, selfCheckInRateLimit, async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    const email = cleanHeader(req.body?.email, 254).trim().toLowerCase();
    if (!/^[a-zA-Z0-9-]+$/.test(workspaceId) || !isEmail(email)) return res.status(400).json({ error: 'Enter the email address used for registration.' });
    const data = await readData();
    const workspace = (data.workspaces || []).find((item) => item.id === workspaceId && item.details?.selfCheckInEnabled === true);
    if (!workspace) return res.status(404).json({ error: 'Self check-in is not available for this event.' });
    const guestIds = (workspace.guests || []).filter((guest) => guest.email?.trim().toLowerCase() === email).map((guest) => guest.id);
    if (workspace.details?.selfCheckInVerification !== true) {
      if (!guestIds.length) return res.status(404).json({ error: 'We could not find an active registration for that email address.' });
      return res.json({ verified: true, accessToken: issueSelfCheckInToken(workspaceId, guestIds), ...publicSelfCheckInPayload(workspace, guestIds) });
    }
    const configuration = mailConfiguration();
    if (!configuration.configured) return res.status(503).json({ error: 'Email verification is temporarily unavailable. Please visit the welcome desk.' });
    const challengeId = randomBytes(18).toString('base64url');
    const code = String(randomInt(100000, 1000000));
    const expires = Date.now() + 10 * 60 * 1000;
    for (const [id, challenge] of selfCheckInChallenges) if (challenge.expires <= Date.now()) selfCheckInChallenges.delete(id);
    while (selfCheckInChallenges.size >= 5_000) selfCheckInChallenges.delete(selfCheckInChallenges.keys().next().value);
    selfCheckInChallenges.set(challengeId, { workspaceId, email, guestIds, codeHash: sign(`${challengeId}:${email}:${code}`), expires, attempts: 0 });
    if (guestIds.length) {
      const safeEvent = escapeHtml(workspace.details?.name || 'Event');
      await sendTransactionalMail(configuration, {
        kind: 'self-checkin-code', to: email, subject: `Your check-in code: ${code}`,
        text: `Your verification code for ${workspace.details?.name || 'the event'} is ${code}. It expires in 10 minutes.`,
        html: `<!doctype html><html><body style="margin:0;background:#edf0ec;font-family:Arial,sans-serif;color:#17201b"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:28px 14px"><tr><td align="center"><table role="presentation" width="520" cellspacing="0" cellpadding="0" style="width:100%;max-width:520px;background:#fff;border-radius:12px"><tr><td style="padding:34px;text-align:center"><div style="font-size:22px;font-weight:800;color:#173e2b">${safeEvent}</div><p style="color:#657068">Use this code to check in for ${safeEvent}.</p><div style="margin:24px 0;font-size:38px;letter-spacing:.18em;font-weight:800;color:#176e4c">${code}</div><p style="color:#657068;font-size:13px">This code expires in 10 minutes.</p></td></tr></table></td></tr></table></body></html>`
      });
    }
    res.json({ verificationRequired: true, challengeId, ...(process.env.NODE_ENV === 'test' && configuration.testTransport && guestIds.length ? { testCode: code } : {}) });
  } catch (error) {
    console.error(`[seating-api] Self check-in start failed: ${error.code || error.name || 'delivery-error'}`);
    res.status(502).json({ error: 'We could not start self check-in. Please try again or visit the welcome desk.' });
  }
});

app.post('/api/public/self-check-in/:workspaceId/verify', requireSameOrigin, async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    const challengeId = cleanText(req.body?.challengeId, 100);
    const code = cleanText(req.body?.code, 12).trim();
    const challenge = selfCheckInChallenges.get(challengeId);
    if (!challenge || challenge.workspaceId !== workspaceId || challenge.expires <= Date.now() || challenge.attempts >= 5 || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'That code is invalid or has expired.' });
    challenge.attempts += 1;
    const supplied = Buffer.from(sign(`${challengeId}:${challenge.email}:${code}`));
    const expected = Buffer.from(challenge.codeHash);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || !challenge.guestIds.length) return res.status(400).json({ error: 'That code is invalid or has expired.' });
    selfCheckInChallenges.delete(challengeId);
    const data = await readData();
    const workspace = (data.workspaces || []).find((item) => item.id === workspaceId && item.details?.selfCheckInEnabled === true);
    if (!workspace) return res.status(404).json({ error: 'Self check-in is not available for this event.' });
    res.json({ verified: true, accessToken: issueSelfCheckInToken(workspaceId, challenge.guestIds), ...publicSelfCheckInPayload(workspace, challenge.guestIds) });
  } catch (error) { next(error); }
});

app.patch('/api/public/self-check-in/:workspaceId/guests/:guestId', requireSameOrigin, async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    const guestId = cleanText(req.params.guestId, 100);
    const access = readSelfCheckInToken(req);
    if (!access || access.workspaceId !== workspaceId || !access.guestIds.includes(guestId)) return res.status(401).json({ error: 'Your check-in session has expired. Please start again.' });
    const updated = await queueCheckInMutation({ workspaceId, guestId, checkedIn: true, operator: 'Self check-in', publicOnly: true });
    if (updated.error) return res.status(updated.status).json({ error: updated.error });
    res.json({ guest: updated.guest });
  } catch (error) { next(error); }
});

app.get('/api/workspaces/:workspaceId/check-in', requireAuth, async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    if (!/^[a-zA-Z0-9-]+$/.test(workspaceId)) return res.status(400).json({ error: 'Invalid workspace ID' });
    const data = await readData();
    const workspace = (data.workspaces || []).find((item) => item.id === workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Event workspace not found' });
    res.json({
      event: { name: workspace.details?.name || '', dateLabel: workspace.details?.dateLabel || '', venue: workspace.details?.venue || '', startTime: workspace.details?.startTime || '', endTime: workspace.details?.endTime || '' },
      guests: (workspace.guests || []).map((guest) => checkInGuestView(workspace, guest, true)),
      refreshedAt: new Date().toISOString()
    });
  } catch (error) { next(error); }
});

app.patch('/api/workspaces/:workspaceId/check-in/:guestId', requireAuth, requireSameOrigin, async (req, res, next) => {
  try {
    const workspaceId = cleanText(req.params.workspaceId, 100);
    const guestId = cleanText(req.params.guestId, 100);
    if (!/^[a-zA-Z0-9-]+$/.test(workspaceId) || !guestId || typeof req.body?.checkedIn !== 'boolean') return res.status(400).json({ error: 'Invalid check-in request' });
    const operator = cleanText(req.seatingUser?.displayName, 100) || req.seatingSession.username;
    const updated = await queueCheckInMutation({ workspaceId, guestId, checkedIn: req.body.checkedIn, operator, publicOnly: false });
    if (updated.error) return res.status(updated.status).json({ error: updated.error });
    res.json({ guest: updated.guest });
  } catch (error) { next(error); }
});

async function mecRequest(req, res, next, suffix = '') {
  try {
    const eventId = req.params.eventId;
    if (!/^\d{1,12}$/.test(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    if (!mecBaseUrl || !process.env.MEC_API_KEY) return res.status(503).json({ error: 'MEC is not configured' });
    const upstream = await fetch(`${mecBaseUrl}/events/${eventId}${suffix}`, {
      headers: { 'mec-token': process.env.MEC_API_KEY, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(12000)
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch (error) { next(error); }
}

app.get('/api/mec/events/:eventId', requireAuth, requireAdmin, (req, res, next) => mecRequest(req, res, next));
app.get('/api/mec/events/:eventId/tickets', requireAuth, requireAdmin, (req, res, next) => mecRequest(req, res, next, '/tickets'));
app.get('/api/mec/events/:eventId/details', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!/^\d{1,12}$/.test(req.params.eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    if (!mecBaseUrl) return res.status(503).json({ error: 'MEC is not configured' });
    const upstream = await fetch(`${mecBaseUrl}/events/${req.params.eventId}`, {
      headers: { 'mec-token': process.env.MEC_API_KEY, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(12000)
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'MEC event could not be loaded' });
    const event = await upstream.json();
    const data = event.data || {};
    const meta = data.meta || {};
    const location = data.locations?.[meta.mec_location_id] || {};
    const tickets = Object.values(data.tickets || {});
    const dateSource = event.date?.start?.date || meta.mec_start_date || '';
    const dateLabel = /^\d{4}-\d{2}-\d{2}$/.test(dateSource)
      ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${dateSource}T00:00:00Z`))
      : dateSource;
    res.json({
      name: cleanText(data.title, 160),
      dateLabel,
      venue: cleanText([location.name, location.address].filter(Boolean).join(' · '), 180),
      startTime: cleanText(data.time?.start_raw || data.time?.start, 30),
      endTime: cleanText(data.time?.end_raw || data.time?.end, 30),
      organizerId: cleanIdentifier(meta.mec_organizer_id, 30),
      categories: cleanText(Object.values(data.categories || {}).map((category) => category.name).filter(Boolean).join(', '), 240),
      ticketSummary: cleanText(tickets.map((ticket) => `${ticket.name}${ticket.price ? ` (${ticket.price})` : ''}`).join(', '), 300),
      eventUrl: isAllowedEventUrl(data.permalink) ? data.permalink : '',
      lastSyncedAt: new Date().toISOString()
    });
  } catch (error) { next(error); }
});
const mecTicketCache = new Map();
async function knownTicketTokens(eventId) {
  const knownTokens = new Map();
  const data = await readData();
  const workspace = (data.workspaces || []).find((item) => String(item.details?.mecEventId || '') === String(eventId));
  for (const guest of workspace?.guests || []) {
    if (!/^\d{1,20}$/.test(String(guest.bookingId || '')) || !cleanInvoiceKey(guest.qrToken)) continue;
    const tokens = knownTokens.get(String(guest.bookingId)) || {};
    tokens[Number(guest.attendeeKey) + 1] = guest.qrToken;
    knownTokens.set(String(guest.bookingId), tokens);
  }
  return knownTokens;
}
app.get('/api/mec/events/:eventId/confirmed-bookings', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!/^\d{1,12}$/.test(req.params.eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    if (!mecOrigin || !process.env.MEC_UTILITY_API_KEY) return res.status(503).json({ error: 'MEC booking sync is not configured' });
    const upstream = await fetch(`${mecOrigin}/wp-json/mec-utility/v1/events/${req.params.eventId}/attendees/flat?booking_status=active&include_membership=1`, {
      headers: { 'X-API-Key': process.env.MEC_UTILITY_API_KEY, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000)
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'MEC bookings could not be loaded' });
    const payload = await upstream.json();
    // Sync removes guests missing from this feed, so refuse a feed that is not the complete attendee list.
    if (!Array.isArray(payload.attendees) || (payload.count != null && Number(payload.count) !== payload.attendees.length)) return res.status(502).json({ error: 'MEC returned an incomplete attendee list' });
    const paidConfirmed = (payload.attendees || []).filter(attendee => bookingPaymentStatus(attendee));
    const expectedSeats = new Map();
    for (const attendee of paidConfirmed) expectedSeats.set(String(attendee.booking_id), (expectedSeats.get(String(attendee.booking_id)) || 0) + 1);
    const tickets = await loadMecTickets(paidConfirmed.map((attendee) => attendee.booking_id), { apiKey: process.env.MEC_UTILITY_API_KEY, cache: mecTicketCache, knownTokens: await knownTicketTokens(req.params.eventId), expectedSeats, mecBase: mecOrigin });
    const invoiceKeys = new Map([...tickets].map(([bookingId, ticket]) => [bookingId, ticket.invoiceKey]));
    const fieldValue = (attendee, pattern) => {
      const field = (attendee.reg_formatted || []).find((item) => pattern.test(String(item.label || '')));
      return cleanText(field?.value, 180);
    };
    const guests = paidConfirmed.map((attendee) => ({
      id: `MEC-${cleanIdentifier(attendee.booking_id, 40)}-${cleanIdentifier(attendee.key, 60)}`,
      bookingId: cleanIdentifier(attendee.booking_id, 100), attendeeKey: cleanIdentifier(attendee.key, 120),
      ...(invoiceKeys.get(String(attendee.booking_id)) ? { invoiceKey: invoiceKeys.get(String(attendee.booking_id)) } : {}),
      ...(cleanInvoiceKey(tickets.get(String(attendee.booking_id))?.tokens?.[Number(attendee.key) + 1]) ? { qrToken: tickets.get(String(attendee.booking_id)).tokens[Number(attendee.key) + 1] } : {}),
      ...(cleanInvoiceKey(attendee.transaction) ? { transactionId: cleanInvoiceKey(attendee.transaction) } : {}),
      name: cleanText(attendee.name, 160), email: cleanText(attendee.email, 254),
      bookingMembership: cleanMembership(attendee.booking_membership),
      company: fieldValue(attendee, /company|organisation|organization|employer/i) || 'Company not provided',
      title: fieldValue(attendee, /job\s*title|position|designation/i) || 'Title not provided',
      ticketName: cleanText(attendee.ticket_name, 160), paymentStatus: bookingPaymentStatus(attendee), source: 'mec', vip: false, tableId: null
    }));
    res.json({ guests, matchedAttendees: guests.length, invoiceLinkedAttendees: guests.filter((guest) => guest.invoiceKey).length, paidAttendees: guests.filter(g => g.paymentStatus === 'Paid & confirmed').length, complimentaryAttendees: guests.filter(g => g.paymentStatus === 'Complimentary & confirmed').length, activeBookings: Number(payload.active_attendees || 0), pendingBookings: Number(payload.pending_attendees || 0), totalBookings: Number(payload.total_all_attendees || 0), excludedAttendees: Math.max(0, (payload.attendees || []).length - guests.length), syncedAt: new Date().toISOString() });
  } catch (error) { next(error); }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  if (error instanceof SyntaxError && error?.status === 400) return res.status(400).json({ error: 'Request body must be valid JSON' });
  console.error(`[seating-api] ${error.name}: ${error.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

await recoverInterruptedCampaigns();
const server = app.listen(port, '127.0.0.1', () => console.log(`Seating API listening on 127.0.0.1:${port}`));
server.requestTimeout = 15_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.on('error', (error) => { console.error('[seating-api] Server error', error.message); process.exitCode = 1; });
