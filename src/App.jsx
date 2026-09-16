import React, { useEffect, useMemo, useRef, useState } from 'react';
import { applySeatingConfig, mergeConfirmedGuests, membershipLabel } from './seating-config.js';
import { activeMemberships, normalizeSeatingRules, smartAutoAssign } from './smart-seating.js';
import { markManualEventFields, mergeMecEventDetails } from './event-details.js';
import { buildBalancedRows, flattenArrangedRows, moveTableInRows, normalizeTableRows, partitionTables } from './table-layout.js';
import { findGuestsFromScan, invoiceReferenceFromScan } from './checkin-match.js';
import { buildFloorPlanSvg, buildPrintDocument, buildSeatingCsv } from './seating-export.js';
import { duplicateTableNumber, nextTableNumber, normalizeTableNumbers, renumberTablesInOrder, tableAdminTitle, tableLabel, tableNumber, tableTitle } from '../shared/table-labels.js';
import { DEFAULT_EMAIL_HTML, EMAIL_VARIABLES, renderEmailTemplate, templateForEvent } from './email-template.js';
import QRCode from 'qrcode';
import {
  Add24Regular,
  Alert24Regular,
  ArrowDownload24Regular,
  DocumentTable24Regular,
  Image24Regular,
  Print24Regular,
  ArrowSync24Regular,
  ArrowUpload24Regular,
  Calendar24Regular,
  Checkmark24Regular,
  CheckmarkCircle24Regular,
  ChevronDown20Regular,
  ChevronLeft20Regular,
  ChevronRight20Regular,
  Dismiss20Regular,
  ArrowMove24Regular,
  ArrowDown16Regular,
  ArrowLeft16Regular,
  ArrowRight16Regular,
  ArrowUp16Regular,
  ReOrderDotsVertical20Regular,
  TableMoveAbove24Regular,
  Delete24Regular,
  ArrowSwap24Regular,
  Grid24Regular,
  ZoomFit20Regular,
  ZoomIn20Regular,
  ZoomOut20Regular,
  Mail24Regular,
  MoreHorizontal24Regular,
  People24Regular,
  PeopleTeam24Regular,
  PersonAdd24Regular,
  PersonAvailable24Regular,
  QrCode24Regular,
  ScanCamera24Regular,
  Search24Regular,
  Send24Regular,
  SignOutRegular,
  Settings24Regular,
  Sparkle24Regular,
  Star24Filled,
  Star24Regular,
  Table24Regular
} from '@fluentui/react-icons';

const ORG_NAME = import.meta.env.VITE_ORGANIZATION_NAME || 'Seating Studio';
const TICKET_BASE_URL = import.meta.env.VITE_TICKET_BASE_URL || '';

const makeTables = () => Array.from({ length: 45 }, (_, index) => ({
  id: index + 1,
  number: index + 1,
  name: index < 2 ? `Patron ${index + 1}` : '',
  capacity: index < 2 ? 12 : index % 13 === 0 ? 8 : index % 17 === 0 ? 14 : 10,
  zone: index < 10 ? 'Stage' : index < 30 ? 'Main floor' : 'Terrace'
}));

const makeEventWorkspace = (template = null) => {
  const id = `event-${crypto.randomUUID()}`;
  if (!template) return {
    id,
    details: { name: 'New event', dateLabel: '', venue: '', defaultSeats: 10, tablesPerRow: 5, tableRows: [5, 5, 5, 5, 5, 5, 5, 5, 5], zones: ['Main floor'], vipZone: '', mecEventId: '', selfCheckInEnabled: false, selfCheckInVerification: false },
    guests: [],
    tables: makeTables().map((table) => ({ ...table, zone: 'Main floor' })),
    campaign: { subject: '', replyTo: '', htmlBody: DEFAULT_EMAIL_HTML, attachCalendar: true, includeMecQr: false, preparedAt: '' },
    published: false,
    updatedAt: new Date().toISOString()
  };
  const details = template.details || {};
  const copiedZones = details.zones?.length
    ? details.zones
    : [...new Set((template.tables || []).map((table) => table.zone).filter(Boolean))];
  return {
    id,
    details: {
      name: `${details.name || 'Event'} · New event`, dateLabel: '', venue: details.venue || '',
      defaultSeats: details.defaultSeats || 10, tablesPerRow: details.tablesPerRow || 5,
      tableRows: [...(details.tableRows || normalizeTableRows(undefined, template.tables?.length || 45, details.tablesPerRow || 5))],
      zones: [...(copiedZones.length ? copiedZones : ['Main floor'])], vipZone: details.vipZone || '', seatingRules: structuredClone(details.seatingRules || {}),
      mecEventId: '', selfCheckInEnabled: false, selfCheckInVerification: false, manualEventFields: details.venue ? ['venue'] : []
    },
    guests: [],
    tables: normalizeTableNumbers(template.tables || makeTables()).map((table) => ({ id: table.id, number: table.number, name: table.name, capacity: table.capacity, capacityOverride: Boolean(table.capacityOverride), zone: table.zone })),
    campaign: { subject: '', replyTo: template.campaign?.replyTo || '', htmlBody: template.campaign?.htmlBody || DEFAULT_EMAIL_HTML, attachCalendar: template.campaign?.attachCalendar !== false, includeMecQr: false, preparedAt: '' },
    published: false,
    updatedAt: new Date().toISOString()
  };
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const newManualGuest = () => ({ name: '', email: '', company: '', title: '', ticketName: '', tableId: '', vip: false });

const initials = (name) => name.split(' ').slice(0, 2).map((part) => part[0]).join('');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field); field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else field += character;
  }
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function IconButton({ label, children, onClick, className = '' }) {
  return <button className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick}>{children}</button>;
}

function BrandLogo({ tone = 'green', className = '' }) {
  const source = tone === 'white' ? '/brand/logo-white.svg' : '/brand/logo.svg';
  return <img className={`brand-logo ${className}`} src={source} alt={ORG_NAME} width="64" height="64" />;
}

function LoginScreen({ onLogin, error, busy }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const submit = (event) => { event.preventDefault(); onLogin(username, password); };
  return <main className="login-page">
    <section className="login-visual" aria-hidden="true">
      <div className="login-brand"><BrandLogo tone="white" className="login-brand-logo" /><span><strong>{ORG_NAME}</strong>Event Operations</span></div>
      <div className="login-statement"><span>AWARDS · GALA OPERATIONS</span><h1>Every guest,<br />perfectly placed.</h1><p>A private workspace for table planning, guest management and event-day confidence.</p></div>
      <div className="login-floor-motif"><i /><i /><i /><i /><i /><i /><i /></div>
    </section>
    <section className="login-panel">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mobile-brand"><BrandLogo className="login-mobile-logo" /><strong>{ORG_NAME}</strong></div>
        <span className="eyebrow">SECURE ACCESS</span>
        <h2>Welcome back</h2>
        <p>Sign in to manage your event seating workspace.</p>
        <label><span>Username</span><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
        <label><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus /></label>
        {error && <div className="login-error" role="alert">{error}</div>}
        <button className="button primary login-submit" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'}</button>
        <small>Protected connection · Session expires automatically</small>
      </form>
    </section>
  </main>;
}

function Sidebar({ view, setView, onSettings, onTeam, onLogout, onProfile, profile, planHealth, guestCount, userRole }) {
  const adminItems = [
    { id: 'seating', label: 'Seating plan', icon: <Grid24Regular /> },
    { id: 'guests', label: 'Guest directory', icon: <People24Regular /> },
    { id: 'checkin', label: 'On-site check-in', icon: <PersonAvailable24Regular /> },
    { id: 'messages', label: 'Messages & tickets', icon: <Mail24Regular /> }
  ];
  const items = userRole === 'admin' ? adminItems : adminItems.filter((item) => item.id === 'checkin');
  return (
    <aside className="sidebar">
      <div className="brand-block">
        <BrandLogo tone="white" className="sidebar-logo" />
        <div><strong>{ORG_NAME}</strong><span>Event Operations</span></div>
      </div>
      <nav className="primary-nav" aria-label="Primary navigation">
        <span className="nav-label">Gala workspace</span>
        {items.map((item) => (
          <button key={item.id} className={view === item.id ? 'nav-item active' : 'nav-item'} onClick={() => setView(item.id)} aria-label={item.label}>
            {item.icon}<span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        {userRole === 'admin' && <div className="event-health">
          <div className="health-ring" style={{ '--health': `${planHealth}%` }}><span>{planHealth}%</span></div>
          <div><strong>Guests seated</strong><span>{guestCount === 0 ? 'No guests loaded' : planHealth === 100 ? 'Complete' : 'In progress'}</span></div>
        </div>}
        {userRole === 'admin' && <button className="nav-item" onClick={onTeam} aria-label="Team access"><PeopleTeam24Regular /><span>Team access</span></button>}
        {userRole === 'admin' && <button className="nav-item" onClick={onSettings} aria-label="Event settings"><Settings24Regular /><span>Event settings</span></button>}
        <div className="profile-row">
          <button className="profile-main" onClick={userRole === 'admin' ? onProfile : undefined} aria-label={userRole === 'admin' ? 'Edit profile' : 'Signed-in user'}><div className="avatar">{initials(profile.name || 'Event Admin')}</div><span><strong>{profile.name || 'Event Admin'}</strong><small>{profile.role || (userRole === 'admin' ? 'Administrator' : 'Check-in staff')}</small></span></button>
          <IconButton label="Log out" onClick={onLogout}><SignOutRegular /></IconButton>
        </div>
      </div>
    </aside>
  );
}

export default function App() {
  return <DashboardApp />;
}

function Header({ view, onImport, fileRef, eventDetails, onPublish, published, workspaces, currentWorkspaceId, onWorkspace, onManageEvents }) {
  const labels = { seating: 'Seating plan', guests: 'Guest directory', checkin: 'On-site check-in', messages: 'Messages & tickets' };
  return (
    <header className="topbar">
      <div>
        <div className="breadcrumb"><select className="workspace-select" value={currentWorkspaceId} onChange={(event) => onWorkspace(event.target.value)} aria-label="Current event">{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.details.name}</option>)}</select><ChevronRight20Regular /> {labels[view]}</div>
        <h1>{labels[view]}</h1>
      </div>
      <div className="header-actions">
        <IconButton label="Manage events" onClick={onManageEvents}><Calendar24Regular /></IconButton>
        <div className="event-date"><Calendar24Regular /><span><b>{eventDetails.dateLabel}{eventDetails.startTime ? ` · ${eventDetails.startTime}` : ''}</b>{eventDetails.venue}</span></div>
        <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={onImport} />
        {view !== 'checkin' && <button className="button secondary" onClick={() => fileRef.current?.click()}><ArrowUpload24Regular /> Import CSV</button>}
        {view !== 'checkin' && <button className="button primary" onClick={onPublish} title="Mark the current saved arrangement as the approved plan"><Checkmark24Regular /> {published ? 'Plan published' : 'Publish plan'}</button>}
      </div>
    </header>
  );
}

function Modal({ title, subtitle, children, onClose, actions, wide = false }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal-card ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label={`Close ${title}`} onClick={onClose}><Dismiss20Regular /></IconButton></div>
        <div className="modal-content">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </section>
    </div>
  );
}

function EventSettingsModal({ workspace, onClose, onSave }) {
  const [draft, setDraft] = useState(workspace.details);
  const [seatScope, setSeatScope] = useState('standard');
  const [error, setError] = useState('');
  const field = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  return <Modal title="Event settings" subtitle="Details and defaults for this seating workspace." onClose={onClose} actions={<><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" onClick={() => { try { const result = applySeatingConfig(workspace.tables, workspace.guests, workspace.details, draft, seatScope); onSave({ ...result, details: markManualEventFields(workspace.details, result.details) }); } catch (e) { setError(e.message); } }}>Save changes</button></>}>
    <div className="settings-grid">
      <label className="modal-field full"><span>Event name</span><input value={draft.name} onChange={(event) => field('name', event.target.value)} /></label>
      <label className="modal-field"><span>Event date</span><input value={draft.dateLabel} onChange={(event) => field('dateLabel', event.target.value)} placeholder="04 Dec 2026" /></label>
      <label className="modal-field"><span>Default table size</span><select value={draft.defaultSeats} onChange={(event) => field('defaultSeats', Number(event.target.value))}>{Array.from({ length: 17 }, (_, i) => i + 4).map((size) => <option key={size} value={size}>{size} seats</option>)}</select></label>
      <label className="modal-field full"><span>Apply seat count to</span><select value={seatScope} onChange={e => setSeatScope(e.target.value)}><option value="standard">Standard tables (keep custom capacities)</option><option value="all">All tables (replace custom capacities)</option><option value="new">New tables only</option></select><small>Standard tables update immediately when saved. Occupied seats are protected.</small></label>
      <label className="modal-field full"><span>Venue</span><input value={draft.venue} onChange={(event) => field('venue', event.target.value)} /><small>A venue edited here is kept when MEC refreshes the event details.</small></label>
      <label className="modal-field full"><span>MEC event ID</span><input value={draft.mecEventId} onChange={(event) => field('mecEventId', event.target.value.replace(/\D/g, ''))} placeholder="Optional" /><small>Enter an MEC event ID to load its live name, date, venue, times and ticket details.</small></label>
      {draft.lastSyncedAt && <div className="api-details full"><span>LIVE MEC DETAILS</span><div><strong>{draft.startTime || 'Time unavailable'} – {draft.endTime || 'Time unavailable'}</strong><small>{draft.categories || 'No categories'} · Organizer #{draft.organizerId || '—'}</small><small>{draft.ticketSummary || 'Ticket details unavailable'}</small></div><em>Synced {new Date(draft.lastSyncedAt).toLocaleString()}</em></div>}
      <div className="self-checkin-settings full">
        <div><strong>Guest self check-in</strong><p>Let guests find their registration by email and mark themselves as arrived.</p></div>
        <label className="toggle-line"><input type="checkbox" checked={draft.selfCheckInEnabled === true} onChange={(event) => field('selfCheckInEnabled', event.target.checked)} /><i /><span><strong>Enable public self check-in page</strong><small>Turn this off after the event to close public access.</small></span></label>
        <label className={`toggle-line ${draft.selfCheckInEnabled === true ? '' : 'disabled'}`}><input type="checkbox" disabled={draft.selfCheckInEnabled !== true} checked={draft.selfCheckInVerification === true} onChange={(event) => field('selfCheckInVerification', event.target.checked)} /><i /><span><strong>Require email verification code</strong><small>Optional. When off, an exact registration email opens check-in immediately.</small></span></label>
        {draft.selfCheckInEnabled === true && <div className="self-checkin-link"><span>Guest page</span><strong>{`${window.location.origin}/self-check-in/${workspace.id}`}</strong><button type="button" className="button secondary" onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/self-check-in/${workspace.id}`)}>Copy link</button></div>}
      </div>
    </div>
    {error && <p className="form-error checkin-error" role="alert">{error}</p>}
  </Modal>;
}

function EventManagerModal({ workspaces, currentWorkspaceId, onClose, onSwitch, onEdit, onCreate, onDuplicate, onDelete, readOnly = false }) {
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  return <Modal wide title={readOnly ? 'Switch event' : 'Manage events'} subtitle={readOnly ? 'Choose the event you are checking in.' : 'Create, configure and switch between independent event workspaces.'} onClose={onClose} actions={!readOnly && <><span className="event-limit">{workspaces.length} of 30 event workspaces</span><button className="button secondary" disabled={workspaces.length >= 30} onClick={() => onDuplicate(currentWorkspaceId)}>Duplicate current setup</button><button className="button primary" disabled={workspaces.length >= 30} onClick={onCreate}><Add24Regular /> New event</button></>}>
    <div className="event-manager-list">
      {workspaces.map((item) => {
        const assigned = (item.guests || []).filter((guest) => guest.tableId).length;
        const active = item.id === currentWorkspaceId;
        const confirming = confirmDeleteId === item.id;
        return <article key={item.id} className={`event-manager-card ${active ? 'active' : ''}`}>
          <div className="event-manager-main"><span className="event-manager-status">{active ? 'CURRENT EVENT' : item.published ? 'PLAN PUBLISHED' : 'DRAFT'}</span><strong>{item.details?.name || 'Untitled event'}</strong><small>{[item.details?.dateLabel, item.details?.venue].filter(Boolean).join(' · ') || 'Event details not completed'}</small></div>
          <div className="event-manager-metrics"><span><strong>{(item.guests || []).length}</strong> guests</span><span><strong>{assigned}</strong> seated</span><span><strong>{(item.tables || []).length}</strong> tables</span></div>
          <div className="event-manager-tags">{item.details?.mecEventId && <span>MEC #{item.details.mecEventId}</span>}{item.details?.selfCheckInEnabled && <span>Self check-in open</span>}</div>
          <div className="event-manager-actions">
            {!active && <button className="button secondary" onClick={() => onSwitch(item.id)}>Open event</button>}
            {!readOnly && <button className="button secondary" onClick={() => onEdit(item.id)}>Settings</button>}
            {!readOnly && <button className="event-delete-button" disabled={workspaces.length === 1} onClick={() => setConfirmDeleteId(item.id)}>Delete</button>}
          </div>
          {confirming && <div className="event-delete-confirm" role="alert"><span>Delete this event, its guests and seating plan?</span><button onClick={() => setConfirmDeleteId('')}>Cancel</button><button onClick={() => onDelete(item.id)}>Delete event</button></div>}
        </article>;
      })}
    </div>
  </Modal>;
}

function ProfileModal({ profile, onClose, onSave }) {
  const [draft, setDraft] = useState(profile);
  return <Modal title="Administrator profile" subtitle="Shown only inside this private dashboard." onClose={onClose} actions={<><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" onClick={() => onSave(draft)}>Save profile</button></>}>
    <div className="settings-grid">
      <label className="modal-field full"><span>Display name</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value.slice(0, 100) }))} /></label>
      <label className="modal-field full"><span>Role</span><input value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value.slice(0, 100) }))} /></label>
    </div>
  </Modal>;
}

function TeamAccessModal({ onClose }) {
  const [users, setUsers] = useState([]);
  const [draft, setDraft] = useState({ displayName: '', username: '', password: '' });
  const [status, setStatus] = useState({ busy: false, error: '', message: '' });
  const loadUsers = () => fetch('/api/users', { headers: { Accept: 'application/json' } })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error('Team accounts could not be loaded.')))
    .then((data) => setUsers(data.users || []))
    .catch((error) => setStatus((current) => ({ ...current, error: error.message })));
  useEffect(() => { loadUsers(); }, []);
  const createUser = async () => {
    setStatus({ busy: true, error: '', message: '' });
    try {
      const response = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seating-Request': '1' }, body: JSON.stringify(draft) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Account could not be created.');
      setUsers((current) => [...current, data.user]);
      setDraft({ displayName: '', username: '', password: '' });
      setStatus({ busy: false, error: '', message: 'Check-in account created. Share the credentials securely with that staff member.' });
    } catch (error) { setStatus({ busy: false, error: error.message, message: '' }); }
  };
  const setActive = async (user, active) => {
    setStatus({ busy: true, error: '', message: '' });
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.username)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Seating-Request': '1' }, body: JSON.stringify({ active }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Account could not be updated.');
      setUsers((current) => current.map((item) => item.username === user.username ? data.user : item));
      setStatus({ busy: false, error: '', message: `${user.displayName} is now ${active ? 'active' : 'disabled'}.` });
    } catch (error) { setStatus({ busy: false, error: error.message, message: '' }); }
  };
  const canCreate = draft.displayName.trim() && /^[a-z0-9._-]{3,50}$/.test(draft.username) && draft.password.length >= 12;
  return <Modal wide title="Team access" subtitle="Create restricted accounts for staff working at the check-in desk." onClose={onClose}>
    <div className="team-access-layout">
      <section className="team-create">
        <h3>Add check-in staff</h3><p>This role can only view event arrivals, search guests, scan tickets and record or undo check-ins.</p>
        <label className="modal-field"><span>Staff display name</span><input value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} /></label>
        <label className="modal-field"><span>Username</span><input autoComplete="off" value={draft.username} onChange={(event) => setDraft((current) => ({ ...current, username: event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '') }))} /><small>Letters, numbers, dots, underscores and hyphens.</small></label>
        <label className="modal-field"><span>Temporary password</span><input type="password" autoComplete="new-password" value={draft.password} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))} /><small>At least 12 characters. The password is never displayed again.</small></label>
        <button className="button primary" onClick={createUser} disabled={!canCreate || status.busy}>Create check-in account</button>
      </section>
      <section className="team-list-section">
        <h3>Check-in accounts</h3>
        <div className="team-list">{users.map((user) => <article key={user.username}><div className="avatar small">{initials(user.displayName)}</div><span><strong>{user.displayName}</strong><small>@{user.username} · Check-in only</small></span><button className={`button ${user.active === false ? 'primary' : 'secondary'}`} onClick={() => setActive(user, user.active === false)} disabled={status.busy}>{user.active === false ? 'Enable' : 'Disable'}</button></article>)}</div>
        {users.length === 0 && <div className="team-empty">No check-in accounts yet.</div>}
      </section>
    </div>
    {status.error && <div className="checkin-error" role="alert"><Alert24Regular />{status.error}</div>}
    {status.message && <div className="success-note team-note"><Checkmark24Regular />{status.message}</div>}
  </Modal>;
}

function TableVisual({ table, guests, selected, onSelect, onDropGuest, compact = false }) {
  const assigned = guests.filter((guest) => guest.tableId === table.id);
  const seats = Array.from({ length: table.capacity });
  const size = compact ? 118 : 154;
  const center = size / 2;
  const radius = compact ? 48 : 62;
  return (
    <button
      className={`table-unit ${selected ? 'selected' : ''} ${compact ? 'compact' : ''}`}
      onClick={() => onSelect(table.id)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDropGuest(event.dataTransfer.getData('guestId'), table.id); }}
      aria-label={`${tableAdminTitle(table)}, ${assigned.length} of ${table.capacity} seats assigned`}
    >
      <div className="table-shape" style={{ width: size, height: size }}>
        <div className="table-top">
          <strong>{tableNumber(table)}</strong>
          <span>{assigned.length}/{table.capacity}</span>
        </div>
        {seats.map((_, index) => {
          const angle = (index / table.capacity) * Math.PI * 2 - Math.PI / 2;
          const x = center + Math.cos(angle) * radius - 13;
          const y = center + Math.sin(angle) * radius - 13;
          const guest = assigned[index];
          return (
            <span
              key={index}
              className={guest ? `seat filled ${guest.vip ? 'vip' : ''}` : 'seat'}
              style={{ transform: `translate(${x}px, ${y}px)` }}
              title={guest?.name || 'Open seat'}
            >{guest ? initials(guest.name) : ''}</span>
          );
        })}
      </div>
      <span className={`zone-name ${tableLabel(table) ? 'has-label' : ''}`} title={tableLabel(table) ? `${tableLabel(table)} (admin only)` : undefined}>{tableLabel(table) || table.zone}</span>
    </button>
  );
}

const NO_MEMBERSHIP = 'No active membership';
const BOOKING_LABELS = { 'Paid & confirmed': 'Paid', 'Complimentary & confirmed': 'Complimentary', 'Manually added': 'Manually added' };
// Category keys: "membership:<level>" or "booking:<payment status>".
const guestCategories = (guest) => {
  const levels = (guest.bookingMembership?.levels || []).filter((level) => level.active).map((level) => level.name);
  return [...(levels.length ? levels : [NO_MEMBERSHIP]).map((level) => `membership:${level}`), ...(guest.paymentStatus ? [`booking:${guest.paymentStatus}`] : [])];
};

function GuestPool({ guests, tables, query, setQuery, companyFilter, setCompanyFilter, onImportClick, onAutoAssign, onUnassign }) {
  const [vipFirst, setVipFirst] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('');
  const unseated = guests.filter((guest) => !guest.tableId);
  const companyList = [...new Set(unseated.map((guest) => guest.company))];
  const categoryCounts = unseated.reduce((counts, guest) => { for (const key of guestCategories(guest)) counts.set(key, (counts.get(key) || 0) + 1); return counts; }, new Map());
  const categoryOptions = (group) => [...categoryCounts].filter(([key]) => key.startsWith(`${group}:`))
    .map(([key, count]) => ({ key, count, label: group === 'booking' ? BOOKING_LABELS[key.slice(8)] || key.slice(8) : key.slice(11) }))
    .sort((a, b) => (a.label === NO_MEMBERSHIP) - (b.label === NO_MEMBERSHIP) || b.count - a.count);
  useEffect(() => { if (categoryFilter && !categoryCounts.has(categoryFilter)) setCategoryFilter(''); }, [categoryFilter, categoryCounts.has(categoryFilter)]);
  const filtered = unseated.filter((guest) => {
    const needle = query.toLowerCase();
    return (!needle || `${guest.name} ${guest.company} ${guest.title}`.toLowerCase().includes(needle)) && (!companyFilter || guest.company === companyFilter) && (!categoryFilter || guestCategories(guest).includes(categoryFilter));
  }).sort((a, b) => vipFirst ? Number(b.vip) - Number(a.vip) : a.name.localeCompare(b.name));
  const openSeats = tables.reduce((sum, table) => sum + table.capacity, 0) - guests.filter((guest) => guest.tableId).length;
  return (
    <section className="guest-pool">
      <div className="panel-heading">
        <div><h2>Guest pool</h2><span>{unseated.length} awaiting a seat</span></div>
        <IconButton label="Import guest list" onClick={onImportClick}><PersonAdd24Regular /></IconButton>
      </div>
      <div className="search-box"><Search24Regular /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, company or title" aria-label="Search guests" /></div>
      <div className="pool-filters">
        <label><span>Company</span><select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}><option value="">All companies</option>{companyList.map(company => <option key={company}>{company}</option>)}</select><ChevronDown20Regular /></label>
        <button className={`filter-button ${vipFirst ? 'active' : ''}`} aria-pressed={vipFirst} onClick={() => setVipFirst((value) => !value)}>VIP first</button>
        <label className={`category-filter ${categoryFilter ? 'active' : ''}`}><span>Category</span><select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} aria-label="Filter guest pool by category"><option value="">All categories</option>
          {[['membership', 'Membership level'], ['booking', 'Booking type']].map(([group, title]) => {
            const options = categoryOptions(group);
            return options.length ? <optgroup key={group} label={title}>{options.map((option) => <option key={option.key} value={option.key}>{option.label} ({option.count})</option>)}</optgroup> : null;
          })}
        </select><ChevronDown20Regular /></label>
      </div>
      <div className="guest-list">
        {filtered.map((guest) => (
          <article
            className="guest-row"
            key={guest.id}
            draggable
            onDragStart={(event) => { event.dataTransfer.setData('guestId', guest.id); event.dataTransfer.effectAllowed = 'move'; }}
          >
            <div className={`avatar small ${guest.vip ? 'vip-avatar' : ''}`}>{initials(guest.name)}</div>
            <div className="guest-copy"><strong>{guest.name}</strong><span>{guest.title}</span><small>{guest.company}</small></div>
            {guest.vip && <span className="vip-tag">VIP</span>}
          </article>
        ))}
        {filtered.length === 0 && <div className="empty-state"><Search24Regular /><strong>{unseated.length ? 'No matching guests' : 'Everyone is seated'}</strong><span>{unseated.length ? 'Try clearing one of your filters.' : 'Select a table to review its guests.'}</span></div>}
      </div>
      <div className="auto-seat-card">
        <div><Sparkle24Regular /><strong>Smart seating</strong></div>
        <p>Uses companies, purchaser memberships, VIP status, job seniority, zones and capacity.</p>
        <button className="button primary wide" onClick={onAutoAssign} disabled={!unseated.length || openSeats <= 0}><Sparkle24Regular /> Plan auto-assign for {unseated.length}</button>
      </div>
    </section>
  );
}

function AutoAssignModal({ guests, tables, details, onClose, onApply }) {
  const membershipNames = [...new Set(guests.flatMap(activeMemberships))].sort();
  const counts = Object.fromEntries(membershipNames.map(name => [name, guests.filter(guest => activeMemberships(guest).includes(name)).length]));
  const [rules, setRules] = useState(() => normalizeSeatingRules(details.seatingRules, membershipNames));
  const preview = smartAutoAssign(guests, tables, details, rules);
  const summary = preview.summary;
  const update = changes => setRules(current => ({ ...current, ...changes }));
  const toggleMembership = name => update({ priorityMemberships: rules.priorityMemberships.includes(name) ? rules.priorityMemberships.filter(item => item !== name) : [...rules.priorityMemberships, name] });
  return <Modal wide title="Smart auto-assign" subtitle="Preview and choose how the remaining guests should be seated. Manual assignments stay locked." onClose={onClose} actions={<><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={!summary.newlyAssigned} onClick={() => onApply(preview)}><Sparkle24Regular /> Apply {summary.newlyAssigned} assignments</button></>}>
    <div className="smart-rules-grid">
      <label className="modal-field"><span>Seating style</span><select value={rules.style} onChange={event => update({ style: event.target.value })}><option value="balanced">Balanced networking</option><option value="company">Keep companies together</option><option value="networking">Maximum company mix</option></select><small>{rules.style === 'balanced' ? 'Creates colleague pairs, then mixes companies and memberships.' : rules.style === 'company' ? 'Keeps larger company groups together where capacity allows.' : 'Spreads colleagues apart to introduce more companies at each table.'}</small></label>
      <label className="modal-field"><span>Table usage</span><select value={rules.tableUsage} onChange={event => update({ tableUsage: event.target.value })}><option value="efficient">Fill tables efficiently</option><option value="spread">Spread across all tables</option></select><small>{rules.tableUsage === 'efficient' ? 'Uses comfortably full tables instead of leaving many nearly empty.' : 'Balances occupancy across every configured table.'}</small></label>
      <label className="toggle-line full"><input type="checkbox" checked={rules.balanceLeaders} onChange={event => update({ balanceLeaders: event.target.checked })} /><i /><span><strong>Balance senior leaders</strong><small>Distributes chairs, C-suite, VPs, directors and heads rather than concentrating them.</small></span></label>
    </div>
    <section className="priority-memberships">
      <div className="smart-section-heading"><div><h3>Priority guests</h3><p>VIP-marked guests are always prioritized. Choose purchaser memberships to prioritize with them.</p></div><span>{details.vipZone ? `Preferred area: ${details.vipZone}` : 'No priority area configured'}</span></div>
      {membershipNames.length ? <div className="membership-choice-grid">{membershipNames.map(name => <label key={name} className="membership-choice"><input type="checkbox" checked={rules.priorityMemberships.includes(name)} onChange={() => toggleMembership(name)} /><span><strong>{name}</strong><small>{counts[name]} guests</small></span></label>)}</div> : <p className="muted">No active purchaser memberships are available. Sync confirmed bookings to refresh them.</p>}
      {!details.vipZone && <p className="smart-warning"><Alert24Regular /> Set a VIP priority area in Tables & zones to place selected memberships near the preferred area.</p>}
    </section>
    <section className="smart-preview">
      <div className="smart-section-heading"><div><h3>Assignment preview</h3><p>This recalculates as you change the rules.</p></div><span>{summary.existingAssignmentsKept} existing assignments kept</span></div>
      <div className="smart-preview-grid">
        <div><strong>{summary.newlyAssigned}</strong><span>Guests assigned now</span></div>
        <div><strong>{summary.usedTables}<small> / {summary.totalTables}</small></strong><span>Tables used</span></div>
        <div><strong>{summary.guestsWithColleague}</strong><span>Guests with a colleague</span></div>
        <div><strong>{summary.mixedCompanyTables}</strong><span>Mixed-company tables</span></div>
        <div><strong>{summary.mixedMembershipTables}</strong><span>Mixed-membership tables</span></div>
        <div><strong>{summary.priorityZone ? `${summary.priorityInZone}/${summary.priorityTotal}` : '—'}</strong><span>Priority guests in preferred area</span></div>
      </div>
      {summary.unseated > 0 && <p className="smart-warning"><Alert24Regular /> {summary.unseated} guests cannot be assigned because the room does not have enough open seats.</p>}
      <p className="security-note">This preview never moves guests you seated manually. To rebuild the entire room, cancel, use <strong>Clear all seating</strong>, then return here.</p>
    </section>
  </Modal>;
}

function TableNumberField({ table, onNumber }) {
  const [draft, setDraft] = useState(String(tableNumber(table) ?? ''));
  useEffect(() => { setDraft(String(tableNumber(table) ?? '')); }, [table.id, table.number]);
  const commit = () => { if (!onNumber(table.id, draft)) setDraft(String(tableNumber(table) ?? '')); };
  return <label className="table-number-field"><span>Table no.</span><input type="number" inputMode="numeric" min="1" max="999" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} aria-label="Table number shown to guests" /></label>;
}

function Inspector({ table, guests, zones, onCapacity, onZone, onName, onNumber, onUnassign, onClose, onAddGuest, onMoveGuest }) {
  const assigned = guests.filter((guest) => guest.tableId === table.id);
  const grouped = assigned.reduce((map, guest) => ({ ...map, [guest.company]: (map[guest.company] || 0) + 1 }), {});
  return (
    <aside className="inspector">
      <div className="panel-heading inspector-heading">
        <div><span className="table-kicker">Table setup</span><div className="table-identity"><TableNumberField table={table} onNumber={onNumber} /><label className="table-label-field"><span>Name <em>admin only</em></span><input className="table-name-input" value={tableLabel(table)} maxLength={80} placeholder="e.g. sponsor or company" onChange={(event) => onName(table.id, event.target.value)} aria-label="Table name, visible to admins only" /></label></div><small className="table-identity-note">Guests and check-in staff see only “{tableTitle(table)}”.</small><label className="zone-editor"><span>Zone</span><select aria-label="Table zone" value={table.zone} onChange={(event) => onZone(table.id, event.target.value)}>{zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select><small>Manage areas in Tables & zones.</small></label></div>
        <IconButton label="Close table inspector" onClick={onClose}><Dismiss20Regular /></IconButton>
      </div>
      <div className="capacity-control">
        <div><span>Seat capacity</span><strong>{table.capacity}</strong></div>
        <div className="stepper">
          <button aria-label="Remove a seat" disabled={table.capacity <= Math.max(4, assigned.length)} onClick={() => onCapacity(table.id, table.capacity - 1)}>−</button>
          <span>{table.capacity}</span>
          <button aria-label="Add a seat" disabled={table.capacity >= 20} onClick={() => onCapacity(table.id, table.capacity + 1)}>+</button>
        </div>
      </div>
      <div className="inspector-block">
        <div className="block-title"><strong>Company mix</strong><span>{Object.keys(grouped).length} companies</span></div>
        <div className="company-mix">
          {Object.entries(grouped).slice(0, 5).map(([company, count]) => (
            <div key={company}><span>{company}</span><b>{count}</b></div>
          ))}
          {assigned.length === 0 && <p className="muted">Drop guests onto this table to start building the mix.</p>}
        </div>
      </div>
      <div className="inspector-block seated-block">
        <div className="block-title"><strong>Seated guests</strong><span>{assigned.length} of {table.capacity}</span></div>
        <div className="seated-list">
          {assigned.map((guest, index) => (
            <div className="seated-row" key={guest.id} draggable title="Drag onto another table to move" onDragStart={(event) => { event.dataTransfer.setData('guestId', guest.id); event.dataTransfer.effectAllowed = 'move'; }}>
              <span className="seat-number">{String(index + 1).padStart(2, '0')}</span>
              <div><strong>{guest.name}</strong><span>{guest.company}</span></div>
              <IconButton label={`Move ${guest.name} to another table`} onClick={() => onMoveGuest(guest.id)}><ArrowMove24Regular /></IconButton>
              <IconButton label={`Unseat ${guest.name}`} onClick={() => onUnassign(guest.id)}><Dismiss20Regular /></IconButton>
            </div>
          ))}
        </div>
      </div>
      <button className="button secondary wide" onClick={onAddGuest} disabled={assigned.length >= table.capacity}><Add24Regular /> Add guests to table</button>
    </aside>
  );
}

// Typed row sizes apply on blur or Enter, so intermediate keystrokes never add or remove tables.
function RowCountInput({ index, value, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => { const count = Number(draft); if (draft.trim() === '' || !onCommit(index, count)) setDraft(String(value)); };
  return <input type="number" inputMode="numeric" min="1" max="20" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} aria-label={`Tables in row ${index + 1}`} />;
}

function LayoutModal({ tables, guests, details, onClose, onApply }) {
  const [tableRows, setTableRows] = useState(() => normalizeTableRows(details.tableRows, tables.length, details.tablesPerRow || 5));
  const [seats, setSeats] = useState(details.defaultSeats || 10);
  const [scope, setScope] = useState('standard');
  const [zones, setZones] = useState([...new Set([...(details.zones || []), ...tables.map(t => t.zone)].filter(Boolean))]);
  const [tableZones, setTableZones] = useState(Object.fromEntries(tables.map(t => [t.id, t.zone])));
  const [newZone, setNewZone] = useState('');
  const [vipZone, setVipZone] = useState(details.vipZone ?? (tables.some(t => t.zone === 'Stage') ? 'Stage' : ''));
  const [error, setError] = useState('');
  // Tables in room order; rows take consecutive tables, so inserting here keeps later rows unchanged.
  const [draftTables, setDraftTables] = useState(tables);
  const originalIds = new Set(tables.map((table) => table.id));
  const addedTables = draftTables.filter((table) => !originalIds.has(table.id));
  // The total is always the sum of the rows.
  const tableCount = draftTables.length;
  const seatedTableIds = new Set(guests.filter((guest) => guest.tableId).map((guest) => guest.tableId));
  const rowStart = (rows, index) => rows.slice(0, index).reduce((sum, row) => sum + row, 0);
  const createTable = (list, zone) => ({ id: Math.max(0, ...list.map((table) => Number(table.id) || 0)) + 1, number: nextTableNumber(list), name: '', capacity: Number(seats) || 10, capacityOverride: false, zone });
  // Sets one row's size by adding new empty tables at, or removing empty tables from, the end of that row. Other rows never shift.
  const setRowCount = (index, count) => {
    const rows = tableRows.map(Number);
    const current = rows[index];
    if (!Number.isInteger(count) || count < 1) { setError(`Row ${index + 1} needs at least one table. Remove the row instead.`); return false; }
    if (count > 20) { setError('Each row can hold up to 20 tables.'); return false; }
    if (count === current) return true;
    const end = rowStart(rows, index) + current;
    let list = [...draftTables];
    const addedZones = {};
    if (count > current) {
      if (list.length + count - current > 100) { setError('The room can hold up to 100 tables.'); return false; }
      const zone = (list[end - 1] && tableZones[list[end - 1].id]) || zones[0] || 'Main floor';
      const inserted = [];
      for (let step = current; step < count; step += 1) { const table = createTable([...list, ...inserted], zone); inserted.push(table); addedZones[table.id] = zone; }
      list = [...list.slice(0, end), ...inserted, ...list.slice(end)];
    } else {
      const removing = list.slice(end - (current - count), end);
      const occupied = removing.find((table) => seatedTableIds.has(table.id));
      if (occupied) { setError(`${tableAdminTitle(occupied)} has seated guests. Move them to another table before removing it from row ${index + 1}.`); return false; }
      const removingIds = new Set(removing.map((table) => table.id));
      list = list.filter((table) => !removingIds.has(table.id));
    }
    setDraftTables(list);
    setTableZones((existing) => ({ ...existing, ...addedZones }));
    setTableRows(rows.map((row, rowIndex) => rowIndex === index ? count : row));
    setError('');
    return true;
  };
  const removeAddedTable = (tableId) => {
    const position = draftTables.findIndex((table) => table.id === tableId);
    if (position < 0) return;
    const rows = tableRows.map(Number);
    let offset = 0;
    const rowIndex = rows.findIndex((row) => { offset += row; return position < offset; });
    if (rowIndex < 0 || rows[rowIndex] <= 1) { setError('That row needs at least one table. Remove the row instead.'); return; }
    setDraftTables((current) => current.filter((table) => table.id !== tableId));
    setTableZones((current) => { const next = { ...current }; delete next[tableId]; return next; });
    setTableRows(rows.map((row, index) => index === rowIndex ? row - 1 : row));
    setError('');
  };
  const [renumberOpen, setRenumberOpen] = useState(false);
  const renumberChanges = renumberTablesInOrder(draftTables).filter((table, index) => tableNumber(draftTables[index]) !== table.number).length;
  const applyRenumber = () => {
    setDraftTables((current) => renumberTablesInOrder(current));
    setRenumberOpen(false);
    setError('');
  };
  const rowOfTable = (tableId) => {
    const position = draftTables.findIndex((table) => table.id === tableId);
    let offset = 0;
    return tableRows.map(Number).findIndex((row) => { offset += row; return position < offset; }) + 1;
  };
  const addRow = () => {
    if (draftTables.length >= 100) { setError('The room can hold up to 100 tables.'); return; }
    const last = draftTables[draftTables.length - 1];
    const zone = (last && tableZones[last.id]) || zones[0] || 'Main floor';
    const table = createTable(draftTables, zone);
    setDraftTables([...draftTables, table]);
    setTableZones((current) => ({ ...current, [table.id]: zone }));
    setTableRows([...tableRows.map(Number), 1]);
    setError('');
  };
  const removeRow = (index) => {
    const rows = tableRows.map(Number);
    if (rows.length === 1) { setError('The room needs at least one row.'); return; }
    const start = rowStart(rows, index);
    const removing = draftTables.slice(start, start + rows[index]);
    const occupied = removing.filter((table) => seatedTableIds.has(table.id));
    if (occupied.length) { setError(`Row ${index + 1} has seated guests at ${occupied.map(tableAdminTitle).join(', ')}. Move them before removing the row.`); return; }
    const removingIds = new Set(removing.map((table) => table.id));
    setDraftTables(draftTables.filter((table) => !removingIds.has(table.id)));
    setTableRows(rows.filter((_, rowIndex) => rowIndex !== index));
    setError('');
  };
  const renameZone = (index, name) => { const old = zones[index]; if (vipZone === old) setVipZone(name); setZones(current => current.map((z, i) => i === index ? name : z)); setTableZones(current => Object.fromEntries(Object.entries(current).map(([id, z]) => [id, z === old ? name : z]))); };
  const apply = () => { try {
    if (zones.some(z => !z.trim()) || new Set(zones.map(z => z.trim().toLowerCase())).size !== zones.length) throw new Error('Use a unique, non-empty name for each zone.');
    const orderedTables = draftTables.map((table) => originalIds.has(table.id) ? table : { ...table, capacity: Number(seats) || table.capacity });
    const duplicate = duplicateTableNumber(orderedTables);
    if (duplicate != null) throw new Error(`Two tables use number ${duplicate}. Change one of them, or renumber the tables in room order.`);
    const keptIds = new Set(orderedTables.map((table) => table.id));
    if (guests.some((guest) => guest.tableId && !keptIds.has(guest.tableId))) throw new Error('A removed table still has seated guests. Move them before applying.');
    const result = applySeatingConfig(orderedTables, guests, details, { tableCount: orderedTables.length, tableRows, defaultSeats: seats, zones, vipZone: zones.includes(vipZone) ? vipZone.trim() : '', tableZones: Object.fromEntries(Object.entries(tableZones).map(([id,z]) => [id,z.trim()])) }, scope);
    onApply(result);
  } catch (e) { setError(e.message); } };
  return <Modal wide title="Tables & zones" subtitle="Set the room layout, table sizes and seating areas for this event." onClose={onClose} actions={<><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" onClick={apply}>Apply layout</button></>}>
    <div className="settings-grid">
      <div className="modal-field table-count-summary"><span>Number of tables</span><output aria-live="polite">{tableCount}</output><small>Updates automatically from the rows below.</small></div>
      <label className="modal-field"><span>Default seats per table</span><input type="number" min="4" max="20" value={seats} onChange={e => setSeats(e.target.value)} /></label>
      <label className="modal-field"><span>Apply seat count to</span><select value={scope} onChange={e => setScope(e.target.value)}><option value="standard">Standard tables (keep custom sizes)</option><option value="all">All tables</option><option value="new">New tables only</option></select></label>
    </div>
    <section className="table-row-editor" aria-labelledby="table-row-heading">
      <div className="table-row-heading"><div><h3 id="table-row-heading">Table rows</h3><p>Set how many tables appear in each physical row, from the stage toward the back of the room.</p></div><span className="row-total">{tableCount} {tableCount === 1 ? 'table' : 'tables'}</span></div>
      <div className="table-row-list">
        {tableRows.map((row, index) => <div className="table-row-field" key={index}><span>Row {index + 1}</span><button type="button" className="row-step-table" onClick={() => setRowCount(index, Number(row) - 1)} disabled={Number(row) <= 1} aria-label={`Remove the last table from row ${index + 1}`} title="Remove the last table of this row">−</button><RowCountInput index={index} value={Number(row)} onCommit={setRowCount} /><button type="button" className="row-add-table" onClick={() => setRowCount(index, Number(row) + 1)} disabled={Number(row) >= 20 || tableCount >= 100} aria-label={`Add a new empty table to row ${index + 1}`} title="Add a new empty table to the end of this row"><Add24Regular /></button><button type="button" className="row-remove" onClick={() => removeRow(index)} disabled={tableRows.length === 1} aria-label={`Remove row ${index + 1}`}><Dismiss20Regular /></button></div>)}
      </div>
      <p className="row-add-hint">Change a row with <b>−</b> and <b>+</b>, or type a number and press Enter. Tables are added to or removed from the end of that row only, so other rows keep their tables. The total updates automatically, new tables take the next free number, and tables with seated guests are never removed.</p>
      {addedTables.length > 0 && <div className="row-added-tables" role="status">{addedTables.map((table) => <span key={table.id}><Add24Regular /> {tableTitle(table)} · Row {rowOfTable(table.id)}<button type="button" onClick={() => removeAddedTable(table.id)} aria-label={`Undo adding ${tableTitle(table)}`}><Dismiss20Regular /></button></span>)}</div>}
      <div className="renumber-block">
        {!renumberOpen ? <button type="button" className="button secondary" onClick={() => setRenumberOpen(true)} disabled={!renumberChanges}>Renumber tables in room order</button>
          : <div className="renumber-confirm" role="alert"><p><strong>Renumber {renumberChanges} {renumberChanges === 1 ? 'table' : 'tables'}?</strong> Tables will be numbered 1 to {draftTables.length} from row 1, left to right. Guests who already received a table number by email, or checked in, will see a different number. Table names and seated guests stay with their tables.</p><div><button type="button" className="button secondary" onClick={() => setRenumberOpen(false)}>Keep current numbers</button><button type="button" className="button primary" onClick={applyRenumber}>Renumber</button></div></div>}
        {!renumberOpen && <small>{renumberChanges ? `${renumberChanges} ${renumberChanges === 1 ? 'table is' : 'tables are'} out of room order. Numbers only change when you renumber and apply.` : 'Table numbers already follow room order.'}</small>}
      </div>
      <div className="table-row-actions"><button type="button" className="button secondary" onClick={addRow}><Add24Regular /> Add row</button><button type="button" className="button secondary" onClick={() => { setTableRows(buildBalancedRows(Number(tableCount), tableRows.length)); setError(''); }}>Balance rows</button><span>{tableRows.length} {tableRows.length === 1 ? 'row' : 'rows'} · {tableCount} {tableCount === 1 ? 'table' : 'tables'}</span></div>
    </section>
    <div className="room-zone-editor"><h3>Zones</h3><p>Zones are named areas of your room. Rename an area here, then choose which tables belong to it.</p>
      {zones.map((z, index) => <div className="zone-editor-row" key={index}><input aria-label={`Zone ${index + 1} name`} maxLength={60} value={z} onChange={e => renameZone(index, e.target.value)} /><span>{Object.values(tableZones).filter(v => v === z).length} tables</span><button className="button secondary" disabled={zones.length === 1} onClick={() => { const fallback = zones.find((_, i) => i !== index); setZones(zones.filter((_, i) => i !== index)); setTableZones(current => Object.fromEntries(Object.entries(current).map(([id, value]) => [id, value === z ? fallback : value]))); }}>Remove</button></div>)}
      <div className="zone-editor-row"><input aria-label="New zone name" placeholder="New zone name" maxLength={60} value={newZone} onChange={e => setNewZone(e.target.value)} /><button className="button secondary" disabled={!newZone.trim()} onClick={() => { if (zones.some(z => z.trim().toLowerCase() === newZone.trim().toLowerCase())) { setError('That zone already exists.'); return; } setZones([...zones, newZone.trim()]); setNewZone(''); setError(''); }}>Add zone</button></div>
      <p>Removing a zone moves its tables to the first remaining zone. New tables use the first zone.</p>
      <label className="modal-field"><span>VIP priority area for auto-assign</span><select value={zones.includes(vipZone) ? vipZone : ''} onChange={e => setVipZone(e.target.value)}><option value="">No preferred area</option>{zones.map((z, i) => <option key={i} value={z}>{z || 'Name this zone'}</option>)}</select><small>VIPs are seated here first if space is available. Existing assignments stay unchanged.</small></label>
      <div className="zone-table-list">{draftTables.map(t => <label className="zone-editor-row" key={t.id}><span>{tableAdminTitle(t)}<small>{t.capacity} seats{(t.capacityOverride ?? (t.capacity !== Number(details.defaultSeats || 10))) ? ' · Custom' : ''}</small></span><select aria-label={`Zone for ${t.name}`} value={tableZones[t.id]} onChange={e => setTableZones({ ...tableZones, [t.id]: e.target.value })}>{zones.map((z, i) => <option key={i} value={z}>{z || 'Name this zone'}</option>)}</select></label>)}</div>
    </div>
    {error && <p className="form-error checkin-error" role="alert">{error}</p>}
  </Modal>;
}

function ArrangeTablesModal({ tables, guests, details, onClose, onApply }) {
  const initialRows = useMemo(() => partitionTables(tables, normalizeTableRows(details.tableRows, tables.length, details.tablesPerRow || 5)), [tables, details.tableRows, details.tablesPerRow]);
  const [rows, setRows] = useState(initialRows);
  const [selected, setSelected] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [dropRow, setDropRow] = useState(null);
  const [renumber, setRenumber] = useState(false);
  const [message, setMessage] = useState('');
  const seatedByTable = useMemo(() => guests.reduce((counts, guest) => (guest.tableId ? counts.set(guest.tableId, (counts.get(guest.tableId) || 0) + 1) : counts), new Map()), [guests]);
  const signature = (list) => list.map((row) => row.map((table) => table.id).join(',')).filter(Boolean).join('|');
  const changed = signature(rows) !== signature(initialRows);
  const move = (from, to) => {
    const result = moveTableInRows(rows, from, to);
    if (result.reason === 'full') { setMessage(`Row ${to.row + 1} already has the maximum of 20 tables.`); return; }
    if (!result.moved) return;
    const table = rows[from.row][from.index];
    setRows(result.rows);
    const row = result.rows.findIndex((list) => list.some((item) => item.id === table.id));
    setSelected({ row, index: result.rows[row].findIndex((item) => item.id === table.id) });
    setMessage('');
  };
  const selectedTable = selected ? rows[selected.row]?.[selected.index] : null;
  const addRow = () => { setRows((current) => [...current, []]); setMessage(''); };
  const originalIds = useMemo(() => new Set(tables.map((table) => table.id)), [tables]);
  const addedCount = rows.flat().filter((table) => !originalIds.has(table.id)).length;
  // New tables join the end of the row with the next free number, the row's area and the default seat count.
  const addTableToRow = (rowIndex) => {
    const all = rows.flat();
    if (all.length >= 100) { setMessage('The room can hold up to 100 tables.'); return; }
    if (rows[rowIndex].length >= 20) { setMessage(`Row ${rowIndex + 1} already has the maximum of 20 tables.`); return; }
    const neighbour = rows[rowIndex].at(-1) || rows.slice(0, rowIndex).flat().at(-1) || all[0];
    const table = {
      id: Math.max(0, ...all.map((item) => Number(item.id) || 0), ...tables.map((item) => Number(item.id) || 0)) + 1,
      number: nextTableNumber(all), name: '', capacity: Number(details.defaultSeats) || 10, capacityOverride: false,
      zone: neighbour?.zone || details.zones?.[0] || 'Main floor'
    };
    setRows((current) => current.map((row, index) => index === rowIndex ? [...row, table] : row));
    setSelected({ row: rowIndex, index: rows[rowIndex].length });
    setMessage('');
  };
  const removeAddedTable = (tableId) => { setRows((current) => current.map((row) => row.filter((table) => table.id !== tableId))); setSelected(null); setMessage(''); };
  const removeEmptyRow = (index) => { setRows((current) => current.filter((_, rowIndex) => rowIndex !== index)); setSelected(null); };
  const reset = () => { setRows(initialRows); setSelected(null); setRenumber(false); setMessage(''); };
  const emptyRows = rows.filter((row) => !row.length).length;
  const apply = () => {
    const { tables: ordered, tableRows } = flattenArrangedRows(rows);
    onApply({ tables: renumber ? renumberTablesInOrder(ordered) : ordered, tableRows, renumbered: renumber, added: addedCount });
  };
  const startDrag = (event, position) => { setDragging(position); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', `${position.row}:${position.index}`); };
  const endDrag = () => { setDragging(null); setDropRow(null); };
  const dropAt = (event, to) => { event.preventDefault(); event.stopPropagation(); if (dragging) move(dragging, to); endDrag(); };
  return <Modal wide title="Arrange tables" subtitle="Drag tables to reorder them or move them between rows. Guests stay with their tables." onClose={onClose}
    actions={<><button className="button secondary" onClick={reset} disabled={!changed && !renumber}>Reset</button><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" onClick={apply} disabled={!changed && !renumber}><Checkmark24Regular /> Apply arrangement</button></>}>
    <div className="arrange-toolbar" aria-live="polite">
      {selectedTable ? <>
        <span className="arrange-selected"><b>{tableTitle(selectedTable)}</b>{tableLabel(selectedTable) && <small>{tableLabel(selectedTable)}</small>} · Row {selected.row + 1}, position {selected.index + 1}</span>
        <div className="arrange-steps">
          <button type="button" aria-label="Move left" title="Move left" disabled={selected.index === 0} onClick={() => move(selected, { row: selected.row, index: selected.index - 1 })}><ArrowLeft16Regular /></button>
          <button type="button" aria-label="Move right" title="Move right" disabled={selected.index >= rows[selected.row].length - 1} onClick={() => move(selected, { row: selected.row, index: selected.index + 2 })}><ArrowRight16Regular /></button>
          <button type="button" aria-label="Move to the row above" title="Move to the row above" disabled={selected.row === 0} onClick={() => move(selected, { row: selected.row - 1, index: Math.min(selected.index, rows[selected.row - 1].length) })}><ArrowUp16Regular /></button>
          <button type="button" aria-label="Move to the row below" title="Move to the row below" disabled={selected.row >= rows.length - 1} onClick={() => move(selected, { row: selected.row + 1, index: Math.min(selected.index, rows[selected.row + 1].length) })}><ArrowDown16Regular /></button>
          <label>Move to<select value={selected.row} onChange={(event) => { const row = Number(event.target.value); if (row !== selected.row) move(selected, { row, index: rows[row].length }); }} aria-label="Move the selected table to row">{rows.map((row, index) => <option key={index} value={index}>Row {index + 1} ({row.length})</option>)}</select></label>
          <button type="button" className="arrange-done" onClick={() => setSelected(null)}>Done</button>
        </div>
      </> : <span className="arrange-hint">Drag a table onto another table to place it before that one, or onto a row’s empty space to add it at the end. Use <b>+ Table</b> on a row to add a new empty table there. On a tablet, tap a table and use the arrows.</span>}
    </div>
    {message && <p className="form-error checkin-error" role="alert">{message}</p>}
    <div className="arrange-room">
      <div className="arrange-stage"><span>MAIN STAGE</span></div>
      {rows.map((row, rowIndex) => <section key={rowIndex} className={`arrange-row ${dropRow === rowIndex ? 'drop-target' : ''} ${row.length ? '' : 'empty'}`}
        onDragOver={(event) => { if (dragging) { event.preventDefault(); setDropRow(rowIndex); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropRow((current) => current === rowIndex ? null : current); }}
        onDrop={(event) => dropAt(event, { row: rowIndex, index: row.length })}>
        <header><strong>Row {rowIndex + 1}</strong><span>{row.length ? `${row.length} ${row.length === 1 ? 'table' : 'tables'}` : 'Empty, removed when you apply'}</span><button type="button" className="arrange-add-table" onClick={() => addTableToRow(rowIndex)} disabled={row.length >= 20 || rows.flat().length >= 100} aria-label={`Add a new table to row ${rowIndex + 1}`}><Add24Regular /> Table</button>{!row.length && <button type="button" className="arrange-remove-row" onClick={() => removeEmptyRow(rowIndex)} aria-label={`Remove empty row ${rowIndex + 1}`}><Dismiss20Regular /></button>}</header>
        <div className="arrange-tables">
          {row.map((table, index) => {
            const isSelected = selected?.row === rowIndex && selected?.index === index;
            const seated = seatedByTable.get(table.id) || 0;
            const isNew = !originalIds.has(table.id);
            return <div key={table.id} className="arrange-slot"><button type="button" draggable className={`arrange-table ${isSelected ? 'selected' : ''} ${isNew ? 'new' : ''} ${dragging?.row === rowIndex && dragging?.index === index ? 'dragging' : ''}`}
              aria-pressed={isSelected} aria-label={`${tableAdminTitle(table)}, row ${rowIndex + 1} position ${index + 1}, ${seated} of ${table.capacity} seated`}
              onClick={() => setSelected(isSelected ? null : { row: rowIndex, index })}
              onDragStart={(event) => startDrag(event, { row: rowIndex, index })} onDragEnd={endDrag}
              onDragOver={(event) => { if (dragging) { event.preventDefault(); setDropRow(rowIndex); } }}
              onDrop={(event) => dropAt(event, { row: rowIndex, index })}>
              <ReOrderDotsVertical20Regular className="arrange-grip" />
              <strong>{tableNumber(table)}</strong>
              <small>{isNew ? 'New' : tableLabel(table) || table.zone}</small>
              <span className={seated >= table.capacity ? 'full' : ''}>{seated}/{table.capacity}</span>
            </button>{isNew && <button type="button" className="arrange-remove-new" onClick={() => removeAddedTable(table.id)} aria-label={`Remove new ${tableTitle(table)}`} title="Remove this new table"><Dismiss20Regular /></button>}</div>;
          })}
          {!row.length && <div className="arrange-empty">Drop a table here</div>}
        </div>
      </section>)}
      <button type="button" className="button secondary arrange-add-row" onClick={addRow}><Add24Regular /> Add row</button>
    </div>
    <label className="export-check arrange-renumber"><input type="checkbox" checked={renumber} onChange={(event) => setRenumber(event.target.checked)} /><span><strong>Renumber tables 1 to {rows.flat().length} in this new order</strong><small>Off keeps every table’s current number. Guests who already received a table number by email will see a different number if you renumber.</small></span></label>
    {addedCount > 0 && <p className="arrange-note added">{addedCount} new {addedCount === 1 ? 'table' : 'tables'} will be added with the next free {addedCount === 1 ? 'number' : 'numbers'} and {Number(details.defaultSeats) || 10} seats each.</p>}
    {emptyRows > 0 && <p className="arrange-note">{emptyRows} empty {emptyRows === 1 ? 'row' : 'rows'} will be removed when you apply.</p>}
  </Modal>;
}

function SeatingViewSwitch({ mode, onChange }) {
  const views = [
    { id: 'floor', label: 'Floor plan', icon: <Grid24Regular /> },
    { id: 'tables', label: 'Table list', icon: <Table24Regular /> },
    { id: 'guests', label: 'Guest register', icon: <People24Regular /> }
  ];
  return <div className="seating-view-switch" role="tablist" aria-label="Seating presentation">
    {views.map((view) => <button key={view.id} type="button" role="tab" aria-selected={mode === view.id} className={mode === view.id ? 'active' : ''} onClick={() => onChange(view.id)}>{view.icon}<span>{view.label}</span></button>)}
  </div>;
}

const seatsWord = (count) => `${count} ${count === 1 ? 'seat' : 'seats'}`;
const guestsWord = (count) => `${count} ${count === 1 ? 'guest' : 'guests'}`;

function AddGuestsModal({ table, guests, onClose, onAdd }) {
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const openSeats = Math.max(0, table.capacity - guests.filter((guest) => guest.tableId === table.id).length);
  const seatsLeft = openSeats - selectedIds.length;
  const needle = query.trim().toLowerCase();
  const available = guests.filter((guest) => !guest.tableId && `${guest.name} ${guest.company} ${guest.title}`.toLowerCase().includes(needle));
  const toggle = (guestId) => setSelectedIds((current) => current.includes(guestId) ? current.filter((id) => id !== guestId) : current.length < openSeats ? [...current, guestId] : current);
  return <Modal title={`Add guests to ${tableAdminTitle(table)}`} subtitle={selectedIds.length ? `${selectedIds.length} selected · ${seatsWord(seatsLeft)} left` : `${seatsWord(openSeats)} available · select one or more guests`} onClose={onClose}
    actions={<><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={!selectedIds.length} onClick={() => { onAdd(selectedIds, table.id); onClose(); }}><Add24Regular /> {selectedIds.length > 1 ? `Add ${selectedIds.length} guests` : 'Add guest'}</button></>}>
    <div className="search-box modal-search"><Search24Regular /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search unseated guests" /></div>
    <div className="modal-guest-list">
      {available.slice(0, 50).map((guest) => {
        const selected = selectedIds.includes(guest.id);
        return <button key={guest.id} type="button" className={selected ? 'selected' : ''} aria-pressed={selected} disabled={!selected && !seatsLeft} onClick={() => toggle(guest.id)}><div className={`avatar small ${guest.vip ? 'vip-avatar' : ''}`}>{selected ? <Checkmark24Regular /> : initials(guest.name)}</div><span><strong>{guest.name}</strong><small>{guest.title || 'Job title not provided'}{guest.company ? ` · ${guest.company}` : ''}</small></span>{selected ? <CheckmarkCircle24Regular /> : <Add24Regular />}</button>;
      })}
      {!available.length && <div className="modal-list-empty">{query ? 'No unseated guests match this search.' : 'Every guest is already assigned to a table.'}</div>}
    </div>
  </Modal>;
}

function MoveGuestsModal({ sourceTable, initialGuestId, initialTargetId = null, tables, guests, onClose, onMove, onSwap }) {
  const [selectedIds, setSelectedIds] = useState([initialGuestId]);
  const [targetId, setTargetId] = useState(initialTargetId);
  const [swapWithId, setSwapWithId] = useState(null);
  const [query, setQuery] = useState('');
  const seatedHere = guests.filter((guest) => guest.tableId === sourceTable.id);
  const needle = query.trim().toLowerCase();
  const destinations = tables.filter((table) => table.id !== sourceTable.id && (table.id === targetId || `${tableAdminTitle(table)} ${table.zone}`.toLowerCase().includes(needle)))
    .map((table) => { const seated = guests.filter((guest) => guest.tableId === table.id); return { table, seated, openSeats: Math.max(0, table.capacity - seated.length) }; });
  const target = destinations.find((item) => item.table.id === targetId);
  const fits = (item) => selectedIds.length > 0 && item.openSeats >= selectedIds.length;
  // A one-for-one swap is offered only where a plain move cannot fit.
  const swappable = (item) => selectedIds.length === 1 && !fits(item) && item.seated.length > 0;
  const swapping = Boolean(target && swappable(target));
  const mover = guests.find((guest) => guest.id === selectedIds[0]);
  const partner = swapping ? target.seated.find((guest) => guest.id === swapWithId) : null;
  const toggle = (guestId) => setSelectedIds((current) => current.includes(guestId) ? current.filter((id) => id !== guestId) : [...current, guestId]);
  const chooseTarget = (tableId) => { setTargetId(tableId); setSwapWithId(null); };
  const canMove = Boolean(target && fits(target));
  const confirm = () => { if (canMove) onMove(selectedIds, target.table.id); else if (partner) onSwap(mover.id, partner.id); onClose(); };
  const subtitle = !target ? `${guestsWord(selectedIds.length)} selected · choose a destination table`
    : swapping && partner ? `${mover.name} to ${tableAdminTitle(target.table)} · ${partner.name} to ${tableAdminTitle(sourceTable)}`
    : swapping ? `${tableAdminTitle(target.table)} is full · choose a guest to swap with`
    : fits(target) ? `${guestsWord(selectedIds.length)} selected · to ${tableAdminTitle(target.table)}`
    : selectedIds.length > 1 ? `${tableAdminTitle(target.table)} has ${seatsWord(target.openSeats)} open · swaps are one guest at a time` : `${guestsWord(selectedIds.length)} selected`;
  return <Modal title={`Move guests from ${tableAdminTitle(sourceTable)}`} subtitle={subtitle} onClose={onClose}
    actions={<><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={!canMove && !partner} onClick={confirm}>{partner ? <><ArrowSwap24Regular /> Swap guests</> : <><ArrowMove24Regular /> {target && canMove ? `Move ${guestsWord(selectedIds.length)} to ${tableAdminTitle(target.table)}` : 'Move guests'}</>}</button></>}>
    <div className="move-section-label">Guests to move</div>
    <div className="modal-guest-list compact">
      {seatedHere.map((guest) => {
        const selected = selectedIds.includes(guest.id);
        return <button key={guest.id} type="button" className={selected ? 'selected' : ''} aria-pressed={selected} onClick={() => toggle(guest.id)}><div className={`avatar small ${guest.vip ? 'vip-avatar' : ''}`}>{selected ? <Checkmark24Regular /> : initials(guest.name)}</div><span><strong>{guest.name}</strong><small>{guest.title || 'Job title not provided'}{guest.company ? ` · ${guest.company}` : ''}</small></span>{selected ? <CheckmarkCircle24Regular /> : <Add24Regular />}</button>;
      })}
    </div>
    <div className="move-section-label">Destination table</div>
    <div className="search-box modal-search"><Search24Regular /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tables or areas" aria-label="Search destination tables" /></div>
    <div className="move-table-list">
      {destinations.map((item) => <button key={item.table.id} type="button" className={`${item.table.id === targetId ? 'selected' : ''} ${swappable(item) ? 'swap' : ''}`} aria-pressed={item.table.id === targetId} disabled={!fits(item) && !swappable(item)} onClick={() => chooseTarget(item.table.id)}>
        <strong>{tableAdminTitle(item.table)}</strong><small>{item.table.zone} · {swappable(item) ? (item.openSeats ? `${item.openSeats} open · swap` : 'Full · swap') : item.openSeats ? `${item.openSeats} open` : 'Full'}</small>
      </button>)}
      {!destinations.length && <div className="modal-list-empty">No tables match this search.</div>}
    </div>
    {swapping && <>
      <div className="move-section-label swap-label">Swap {mover.name} with a guest at {tableAdminTitle(target.table)}</div>
      <div className="modal-guest-list compact">
        {target.seated.map((guest) => {
          const selected = guest.id === swapWithId;
          return <button key={guest.id} type="button" className={selected ? 'selected' : ''} aria-pressed={selected} onClick={() => setSwapWithId(selected ? null : guest.id)}><div className={`avatar small ${guest.vip ? 'vip-avatar' : ''}`}>{selected ? <Checkmark24Regular /> : initials(guest.name)}</div><span><strong>{guest.name}</strong><small>{guest.title || 'Job title not provided'}{guest.company ? ` · ${guest.company}` : ''}</small></span>{selected ? <CheckmarkCircle24Regular /> : <ArrowSwap24Regular />}</button>;
        })}
      </div>
    </>}
  </Modal>;
}

function TableRosterView({ tables, guests, zones, onOpenTable, onPlaceGuests, onDropGuest, onMoveGuest, onUnassignGuest }) {
  const [query, setQuery] = useState('');
  const [zone, setZone] = useState('');
  const [occupancy, setOccupancy] = useState('all');
  const [addingTableId, setAddingTableId] = useState(null);
  const needle = query.trim().toLowerCase();
  const rows = tables.map((table) => {
    const assigned = guests.filter((guest) => guest.tableId === table.id);
    return { table, assigned, openSeats: Math.max(0, table.capacity - assigned.length) };
  }).filter(({ table, assigned }) => {
    const matchesZone = !zone || table.zone === zone;
    const matchesOccupancy = occupancy === 'all' || (occupancy === 'occupied' && assigned.length) || (occupancy === 'empty' && !assigned.length) || (occupancy === 'full' && assigned.length >= table.capacity);
    const haystack = `${tableAdminTitle(table)} ${table.zone} ${assigned.map((guest) => `${guest.name} ${guest.company} ${guest.title} ${membershipLabel(guest)}`).join(' ')}`.toLowerCase();
    return matchesZone && matchesOccupancy && (!needle || haystack.includes(needle));
  });
  const addingTable = tables.find((table) => table.id === addingTableId);
  return <main className="alternate-seating-view" role="tabpanel" aria-label="Table list">
    <div className="seating-list-toolbar">
      <div className="search-box large"><Search24Regular /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tables or seated guests" aria-label="Search table list" /></div>
      <label>Area<select value={zone} onChange={(event) => setZone(event.target.value)} aria-label="Filter table list by area"><option value="">Every area</option>{zones.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>Occupancy<select value={occupancy} onChange={(event) => setOccupancy(event.target.value)} aria-label="Filter tables by occupancy"><option value="all">Every table</option><option value="occupied">Occupied</option><option value="full">Full</option><option value="empty">Empty</option></select></label>
      <span>{rows.length} of {tables.length} tables</span>
    </div>
    <div className="table-roster-list">
      {rows.map(({ table, assigned, openSeats }) => <article className="table-roster" key={table.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const guestId = event.dataTransfer.getData('guestId'); if (guestId) onDropGuest(guestId, table.id); }}>
        <header>
          <div><span className="table-kicker">{table.zone}</span><h3>{tableTitle(table)}{tableLabel(table) && <small className="table-admin-label" title="Visible to admins only">{tableLabel(table)}</small>}</h3></div>
          <div className="roster-capacity"><strong>{assigned.length} / {table.capacity}</strong><span>{openSeats ? `${openSeats} open` : 'Full'}</span></div>
          <div className="roster-header-actions"><button type="button" className="button primary" disabled={!openSeats} onClick={() => setAddingTableId(table.id)}><Add24Regular /> Add guests</button><button type="button" className="button secondary" onClick={() => onOpenTable(table.id)}><Grid24Regular /> Floor</button></div>
        </header>
        {assigned.length ? <ol className="roster-guests">{assigned.map((guest, index) => <li key={guest.id} draggable onDragStart={(event) => { event.dataTransfer.setData('guestId', guest.id); event.dataTransfer.effectAllowed = 'move'; }}>
          <span className="seat-number">{String(index + 1).padStart(2, '0')}</span>
          <div className="roster-identity"><strong>{guest.name}</strong><span>{guest.title || 'Job title not provided'}{guest.company ? ` · ${guest.company}` : ''}</span></div>
          <span className={`membership-badge ${guest.bookingMembership?.status === 'active' ? 'active' : ''}`}>{membershipLabel(guest)}</span>
          <div className="roster-tags">{guest.vip && <span className="vip-tag">VIP</span>}{guest.checkedIn && <span className="arrival-tag"><CheckmarkCircle24Regular /> Arrived</span>}</div>
          <IconButton className="roster-move" label={`Move ${guest.name} to another table`} onClick={() => onMoveGuest(table.id, guest.id)}><ArrowMove24Regular /></IconButton>
          <IconButton className="roster-remove" label={`Remove ${guest.name} from ${tableTitle(table)}`} onClick={() => onUnassignGuest(guest.id)}><Dismiss20Regular /></IconButton>
        </li>)}</ol> : <div className="roster-empty"><People24Regular /><span>No guests assigned to this table.</span></div>}
      </article>)}
      {!rows.length && <div className="alternate-empty"><Search24Regular /><h3>No matching tables</h3><p>Try another search or clear the area and occupancy filters.</p></div>}
    </div>
    {addingTable && <AddGuestsModal table={addingTable} guests={guests} onClose={() => setAddingTableId(null)} onAdd={onPlaceGuests} />}
  </main>;
}

function GuestSeatingRegister({ tables, guests, zones, onChangeTable }) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [zone, setZone] = useState('');
  const tableOrder = new Map(tables.map((table, index) => [table.id, index]));
  const tableMap = new Map(tables.map((table) => [table.id, table]));
  const occupiedByTable = new Map(tables.map((table) => [table.id, guests.filter((guest) => guest.tableId === table.id).length]));
  const seatByGuest = new Map();
  tables.forEach((table) => guests.filter((guest) => guest.tableId === table.id).forEach((guest, index) => seatByGuest.set(guest.id, index + 1)));
  const needle = query.trim().toLowerCase();
  const rows = [...guests].sort((first, second) => {
    const firstTable = tableOrder.has(first.tableId) ? tableOrder.get(first.tableId) : Number.MAX_SAFE_INTEGER;
    const secondTable = tableOrder.has(second.tableId) ? tableOrder.get(second.tableId) : Number.MAX_SAFE_INTEGER;
    return firstTable - secondTable || (seatByGuest.get(first.id) || 0) - (seatByGuest.get(second.id) || 0) || first.name.localeCompare(second.name);
  }).filter((guest) => {
    const table = tableMap.get(guest.tableId);
    const matchesScope = scope === 'all' || (scope === 'seated' && table) || (scope === 'unseated' && !table) || (scope === 'vip' && guest.vip);
    const matchesZone = !zone || table?.zone === zone;
    const haystack = `${guest.name} ${guest.email} ${guest.company} ${guest.title} ${membershipLabel(guest)} ${table ? tableAdminTitle(table) : 'unseated'} ${table?.zone || ''}`.toLowerCase();
    return matchesScope && matchesZone && (!needle || haystack.includes(needle));
  });
  return <main className="alternate-seating-view guest-register-view" role="tabpanel" aria-label="Guest seating register">
    <div className="seating-list-toolbar">
      <div className="search-box large"><Search24Regular /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search guest, company, membership or table" aria-label="Search seating register" /></div>
      <label>Status<select value={scope} onChange={(event) => setScope(event.target.value)} aria-label="Filter seating register by status"><option value="all">All guests</option><option value="seated">Seated</option><option value="unseated">Unseated</option><option value="vip">VIP</option></select></label>
      <label>Area<select value={zone} onChange={(event) => setZone(event.target.value)} aria-label="Filter seating register by area"><option value="">Every area</option>{zones.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <span>{rows.length} of {guests.length} guests</span>
    </div>
    <div className="seating-register-wrap">
      <table className="seating-register">
        <thead><tr><th>Seat</th><th>Guest</th><th>Company & title</th><th>Purchaser membership</th><th>Table & area</th><th>Status</th></tr></thead>
        <tbody>{rows.map((guest) => {
          const table = tableMap.get(guest.tableId);
          return <tr key={guest.id}>
            <td data-label="Seat"><span className="seat-number">{table ? String(seatByGuest.get(guest.id)).padStart(2, '0') : '—'}</span></td>
            <td data-label="Guest"><div className="guest-cell"><div className={`avatar small ${guest.vip ? 'vip-avatar' : ''}`}>{initials(guest.name)}</div><span><strong>{guest.name}</strong><small>{guest.email || 'No email recorded'}</small></span></div></td>
            <td data-label="Company & title"><strong className="register-company">{guest.company || 'Not provided'}</strong><small className="register-title">{guest.title || 'Job title not provided'}</small></td>
            <td data-label="Purchaser membership"><span className={`membership-badge ${guest.bookingMembership?.status === 'active' ? 'active' : ''}`}>{membershipLabel(guest)}</span></td>
            <td data-label="Table & area"><select className={`register-table-select ${table ? '' : 'unseated'}`} aria-label={`Table for ${guest.name}`} value={guest.tableId || ''} onChange={(event) => onChangeTable(guest.id, event.target.value ? Number(event.target.value) : null)}><option value="">Unseated</option>{tables.filter((option) => option.id === guest.tableId || occupiedByTable.get(option.id) < option.capacity).map((option) => <option key={option.id} value={option.id}>{tableAdminTitle(option)} · {option.zone} · {Math.max(0, option.capacity - occupiedByTable.get(option.id))} open</option>)}</select></td>
            <td data-label="Status"><div className="roster-tags">{guest.vip && <span className="vip-tag">VIP</span>}<span className={guest.checkedIn ? 'arrival-tag' : 'awaiting-tag'}>{guest.checkedIn && <CheckmarkCircle24Regular />}{guest.checkedIn ? 'Arrived' : 'Awaiting'}</span></div></td>
          </tr>;
        })}</tbody>
      </table>
      {!rows.length && <div className="alternate-empty"><Search24Regular /><h3>No matching guests</h3><p>Try another search or clear the status and area filters.</p></div>}
    </div>
  </main>;
}

const EXPORT_PRESETS = [
  { id: 'admin', label: 'Admin pack', hint: 'Branded cover, floor plan, tables and A–Z list with table names', options: { sections: { floor: true, tables: true, guests: true }, cover: true, showLabels: true, includeCompany: true, includeEmail: false } },
  { id: 'desk', label: 'Registration desk', hint: 'Seating by table and A–Z list, numbers only', options: { sections: { floor: false, tables: true, guests: true }, cover: false, showLabels: false, includeCompany: true, includeEmail: false } },
  { id: 'venue', label: 'Venue floor plan', hint: 'Room layout with table numbers for the venue team', options: { sections: { floor: true, tables: false, guests: false }, cover: false, showLabels: false, includeCompany: false, includeEmail: false } }
];
const fileSlug = (value) => String(value || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'event';
const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

function ExportModal({ tables, guests, details, zones, onClose }) {
  const [options, setOptions] = useState({ ...EXPORT_PRESETS[0].options, zone: '', paper: 'A4' });
  const [status, setStatus] = useState('');
  const set = (changes) => { setOptions((current) => ({ ...current, ...changes })); setStatus(''); };
  const setSection = (key, value) => set({ sections: { ...options.sections, [key]: value } });
  const activePreset = EXPORT_PRESETS.find((preset) => JSON.stringify(preset.options) === JSON.stringify({ sections: options.sections, cover: options.cover, showLabels: options.showLabels, includeCompany: options.includeCompany, includeEmail: options.includeEmail }))?.id;
  const input = { tables, guests, details, zone: options.zone };
  const preview = useMemo(() => buildFloorPlanSvg({ ...input, showLabels: options.showLabels }), [tables, guests, details, options.zone, options.showLabels]);
  const anySection = Object.values(options.sections).some(Boolean);
  const printPdf = () => {
    const html = buildPrintDocument({ ...input, paper: options.paper, sections: options.sections, cover: options.cover, showLabels: options.showLabels, includeCompany: options.includeCompany, includeEmail: options.includeEmail });
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    const previousTitle = document.title;
    frame.onload = () => {
      const view = frame.contentWindow;
      document.title = frame.contentDocument?.title || previousTitle;
      const cleanup = () => { document.title = previousTitle; setTimeout(() => frame.remove(), 500); };
      view.addEventListener('afterprint', cleanup, { once: true });
      // Print only once the Manrope font and the awards artwork are ready, so the PDF matches the brand.
      const fontsReady = frame.contentDocument?.fonts?.ready || Promise.resolve();
      Promise.race([fontsReady, new Promise((resolve) => setTimeout(resolve, 3000))]).then(() => setTimeout(() => { view.focus(); view.print(); }, 150));
      setTimeout(() => { if (document.body.contains(frame)) cleanup(); }, 120000);
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
    setStatus('Print dialog opened. Choose “Save as PDF” as the destination to keep a copy.');
  };
  const downloadPng = async () => {
    setStatus('Preparing image…');
    try {
      const scale = 2;
      const image = new Image();
      const source = URL.createObjectURL(new Blob([preview.svg], { type: 'image/svg+xml;charset=utf-8' }));
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = source; });
      const canvas = document.createElement('canvas');
      canvas.width = preview.width * scale; canvas.height = preview.height * scale;
      const context = canvas.getContext('2d');
      context.scale(scale, scale);
      context.drawImage(image, 0, 0, preview.width, preview.height);
      URL.revokeObjectURL(source);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      downloadBlob(blob, `${fileSlug(details.name)}-floor-plan${options.zone ? `-${fileSlug(options.zone)}` : ''}.png`);
      setStatus('Floor plan image downloaded.');
    } catch { setStatus('The image could not be created in this browser. Use Print / Save as PDF instead.'); }
  };
  const downloadExcel = async () => {
    setStatus('Preparing the Excel workbook…');
    try {
      const { buildSeatingWorkbookBuffer } = await import('./seating-workbook.js');
      const buffer = await buildSeatingWorkbookBuffer({ ...input, includeLabels: options.showLabels, includeEmail: options.includeEmail });
      downloadBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileSlug(details.name)}-seating${options.zone ? `-${fileSlug(options.zone)}` : ''}.xlsx`);
      setStatus('Excel workbook downloaded: Seating, Tables and Guests A–Z sheets in event colours.');
    } catch { setStatus('The Excel workbook could not be created. Try again, or download the plain CSV.'); }
  };
  const downloadCsv = () => {
    const csv = buildSeatingCsv({ ...input, includeLabels: options.showLabels, includeEmail: options.includeEmail });
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${fileSlug(details.name)}-seating${options.zone ? `-${fileSlug(options.zone)}` : ''}.csv`);
    setStatus('Seating spreadsheet downloaded. It opens in Excel with Arabic and accented names intact.');
  };
  const check = (checked, onChange, title, hint) => <label className="export-check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span><strong>{title}</strong>{hint && <small>{hint}</small>}</span></label>;
  return <Modal wide title="Export seating" subtitle={`${preview.model.tableCount} tables · ${preview.model.seatedCount} of ${preview.model.capacity} seats filled${options.zone ? ` · ${options.zone}` : ''}`} onClose={onClose}
    actions={<><button className="button secondary" onClick={downloadExcel}><DocumentTable24Regular /> Excel workbook</button><button className="button secondary" onClick={downloadPng}><Image24Regular /> Floor plan image</button><button className="button primary" onClick={printPdf} disabled={!anySection}><Print24Regular /> Print / Save as PDF</button></>}>
    <div className="export-presets" role="group" aria-label="Export presets">{EXPORT_PRESETS.map((preset) => <button key={preset.id} type="button" className={activePreset === preset.id ? 'active' : ''} aria-pressed={activePreset === preset.id} onClick={() => set(preset.options)}><strong>{preset.label}</strong><small>{preset.hint}</small></button>)}</div>
    <div className="export-layout">
      <div className="export-options">
        <div className="move-section-label">Include in PDF</div>
        {check(options.sections.floor, (value) => setSection('floor', value), 'Floor plan', 'Stage, rows, table numbers and seat occupancy (landscape page)')}
        {check(options.sections.tables, (value) => setSection('tables', value), 'Seating by table', 'Every table with its seated guests, plus unseated guests')}
        {check(options.sections.guests, (value) => setSection('guests', value), 'Guest list A–Z', 'Alphabetical list with each guest’s table number')}
        {check(options.cover, (value) => set({ cover: value }), 'Cover page', 'Green awards cover with room totals and contents')}
        <div className="move-section-label">Options</div>
        <div className="export-selects">
          <label className="modal-field"><span>Area</span><select value={options.zone} onChange={(event) => set({ zone: event.target.value })}><option value="">Entire room</option>{zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          <label className="modal-field"><span>Paper size</span><select value={options.paper} onChange={(event) => set({ paper: event.target.value })}><option value="A4">A4</option><option value="A3">A3 (large floor plans)</option><option value="Letter">Letter</option></select></label>
        </div>
        {check(options.showLabels, (value) => set({ showLabels: value }), 'Show table names', 'Admin-only names such as sponsors. Turn off for guest-facing prints.')}
        {check(options.includeCompany, (value) => set({ includeCompany: value }), 'Show company', null)}
        {check(options.includeEmail, (value) => set({ includeEmail: value }), 'Include email addresses', 'Personal data. Leave off for printed lists.')}
      </div>
      <div className="export-preview" aria-label="Floor plan preview"><div dangerouslySetInnerHTML={{ __html: preview.svg }} /></div>
    </div>
    <p className="export-csv-note">Importing into another system? <button type="button" onClick={downloadCsv}>Download a plain CSV</button> with the same columns and no styling.</p>
    {status && <div className="success-note export-status" role="status"><Checkmark24Regular />{status}</div>}
  </Modal>;
}

const ZOOM_MIN = 25;
const ZOOM_MAX = 110;
const ZOOM_KEY = 'seating-floor-zoom';
const clampZoom = (value) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value)));
const readSavedZoom = () => { try { const saved = Number(window.localStorage.getItem(ZOOM_KEY)); return saved ? clampZoom(saved) : 86; } catch { return 86; } };

function SeatingView({ guests, setGuests, tables, setTables, fileRef, details, onConfigure }) {
  const floorScrollRef = useRef(null);
  const [viewMode, setViewMode] = useState('floor');
  const [selectedTableId, setSelectedTableId] = useState(() => (typeof window !== 'undefined' && window.innerWidth <= 980 ? null : 1));
  const [query, setQuery] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [zone, setZone] = useState('');
  const [clearOpen, setClearOpen] = useState(false);
  const [zoom, setZoomState] = useState(readSavedZoom);
  const fitPending = useRef(false);
  const setZoom = (value) => setZoomState((current) => {
    const next = clampZoom(typeof value === 'function' ? value(current) : value);
    try { window.localStorage.setItem(ZOOM_KEY, String(next)); } catch {}
    return next;
  });
  // Zooms so every visible table and the stage fit inside the floor panel.
  const fitRoom = () => {
    const floor = floorScrollRef.current;
    const units = floor ? [...floor.querySelectorAll('.table-unit')] : [];
    if (!units.length) return;
    const scale = zoom / 100;
    const boxes = units.map((unit) => unit.getBoundingClientRect());
    const stageTop = floor.querySelector('.stage-marker')?.getBoundingClientRect().top ?? Math.min(...boxes.map((box) => box.top));
    const contentWidth = (Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.left))) / scale + 48;
    const contentHeight = (Math.max(...boxes.map((box) => box.bottom)) - stageTop) / scale + 24;
    const style = window.getComputedStyle(floor);
    const width = floor.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = floor.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const next = Math.floor(Math.min(width / contentWidth, height / contentHeight) * 100);
    if (next < ZOOM_MIN && selectedTableId !== null && !fitPending.current) {
      // The table panel narrows the floor too much; close it and fit again once the layout settles.
      fitPending.current = true;
      setSelectedTableId(null);
      return;
    }
    const closedPanel = fitPending.current;
    fitPending.current = false;
    setZoom(next);
    floor.scrollTop = 0;
    if (closedPanel) setNotice(`Closed the table panel so all ${units.length} tables fit. Select a table to reopen it.`);
  };
  const [notice, setNotice] = useState('');
  const [compactLayout, setCompactLayout] = useState(false);
  const [addGuestOpen, setAddGuestOpen] = useState(false);
  const [moving, setMoving] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [autoAssignOpen, setAutoAssignOpen] = useState(false);
  const selectedTable = tables.find((table) => table.id === selectedTableId);
  const assignedCount = guests.filter((guest) => guest.tableId).length;
  const totalSeats = tables.reduce((sum, table) => sum + table.capacity, 0);
  const completion = guests.length ? Math.round(assignedCount / guests.length * 100) : 0;
  const zones = [...new Set([...(details.zones || []), ...tables.map((table) => table.zone)].filter(Boolean))];
  useEffect(() => { if (zone && !zones.includes(zone)) setZone(''); }, [zone, zones.join('|')]);

  // Seats unseated guests or moves seated ones; a group is placed together or not at all.
  const placeGuests = (guestIds, tableId) => {
    const table = tables.find((item) => item.id === tableId);
    if (!table) return;
    const placing = guests.filter((guest) => guestIds.includes(guest.id) && guest.tableId !== tableId);
    if (!placing.length) return;
    const openSeats = table.capacity - guests.filter((guest) => guest.tableId === tableId).length;
    if (placing.length > openSeats) { setNotice(openSeats > 0 ? `${tableAdminTitle(table)} has only ${seatsWord(openSeats)} open for ${guestsWord(placing.length)}.` : `${tableAdminTitle(table)} is already at capacity.`); return; }
    const ids = new Set(placing.map((guest) => guest.id));
    setGuests((current) => current.map((guest) => ids.has(guest.id) ? { ...guest, tableId } : guest));
    const moved = placing.some((guest) => guest.tableId);
    const who = placing.length === 1 ? placing[0].name : guestsWord(placing.length);
    setNotice(`${who} ${moved ? 'moved' : 'added'} to ${tableAdminTitle(table)}.`);
  };
  const swapGuests = (firstId, secondId) => {
    const first = guests.find((guest) => guest.id === firstId);
    const second = guests.find((guest) => guest.id === secondId);
    if (!first?.tableId || !second?.tableId || first.tableId === second.tableId) return;
    setGuests((current) => current.map((guest) => guest.id === first.id ? { ...guest, tableId: second.tableId } : guest.id === second.id ? { ...guest, tableId: first.tableId } : guest));
    const tableName = (tableId) => { const table = tables.find((item) => item.id === tableId); return table ? tableAdminTitle(table) : 'their table'; };
    setNotice(`Swapped ${first.name} to ${tableName(second.tableId)} and ${second.name} to ${tableName(first.tableId)}.`);
  };
  // Dropping a seated guest onto a full table opens the move dialog so a swap can be chosen.
  const dropGuest = (guestId, tableId) => {
    const guest = guests.find((item) => item.id === guestId);
    const table = tables.find((item) => item.id === tableId);
    if (!guest || !table || guest.tableId === tableId) return;
    const full = guests.filter((item) => item.tableId === tableId).length >= table.capacity;
    if (full && guest.tableId) { setMoving({ tableId: guest.tableId, guestId, targetId: tableId }); return; }
    placeGuests([guestId], tableId);
  };
  const movingTable = moving && tables.find((table) => table.id === moving.tableId);
  const changeGuestTable = (guestId, tableId) => {
    if (tableId == null) {
      const guest = guests.find((item) => item.id === guestId);
      setGuests((current) => current.map((item) => item.id === guestId ? { ...item, tableId: null } : item));
      setNotice(`${guest?.name || 'Guest'} is now unseated.`);
      return;
    }
    placeGuests([guestId], tableId);
  };
  const applyAutoAssign = result => {
    onConfigure({ guests: result.guests, details: { ...details, seatingRules: result.rules } });
    setAutoAssignOpen(false);
    setNotice(result.summary.unseated ? `Smart seating assigned ${result.summary.newlyAssigned} guests; ${result.summary.unseated} remain unseated because the room is full.` : `Smart seating assigned ${result.summary.newlyAssigned} guests across ${result.summary.usedTables} tables. Existing assignments were kept.`);
  };
  const configuredRows = partitionTables(tables, normalizeTableRows(details.tableRows, tables.length, details.tablesPerRow || 5));
  const visibleRows = configuredRows.map((row, index) => ({ row: index + 1, tables: zone ? row.filter((table) => table.zone === zone) : row })).filter((item) => item.tables.length);
  useEffect(() => {
    if (viewMode !== 'floor') return undefined;
    let frame;
    const centerFloor = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const floor = floorScrollRef.current;
        const canvas = floor?.querySelector('.floor-canvas');
        if (!floor || !canvas) return;
        const floorBox = floor.getBoundingClientRect();
        const canvasBox = canvas.getBoundingClientRect();
        const canvasCenter = canvasBox.left + canvasBox.width / 2;
        const viewportCenter = floorBox.left + floor.clientWidth / 2;
        floor.scrollLeft = Math.max(0, floor.scrollLeft + canvasCenter - viewportCenter);
      });
    };
    centerFloor();
    const floor = floorScrollRef.current;
    const resizeObserver = floor && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(centerFloor) : null;
    if (floor && resizeObserver) resizeObserver.observe(floor);
    return () => {
      resizeObserver?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [viewMode, zone, zoom, compactLayout, tables.length, details.tableRows?.join('|'), Boolean(selectedTable)]);
  useEffect(() => { if (fitPending.current && !selectedTable) fitRoom(); }, [selectedTable]);
  const applyArrangement = ({ tables: ordered, tableRows, renumbered, added = 0 }) => {
    onConfigure({ tables: ordered, details: { ...details, tableRows, tablesPerRow: Math.max(1, ...tableRows) } });
    setArrangeOpen(false);
    setZone('');
    setNotice(`Tables rearranged: ${ordered.length} tables across ${tableRows.length} ${tableRows.length === 1 ? 'row' : 'rows'}${added ? `, ${added} new ${added === 1 ? 'table' : 'tables'} added` : ''}${renumbered ? ', renumbered in room order' : ''}.`);
  };
  const applyLayout = (result) => { onConfigure(result); setCompactLayout(false); setZone(''); setLayoutOpen(false); setNotice(`Layout updated: ${result.tables.length} tables across ${result.details.tableRows.length} rows.`); };
  const openTableOnFloor = (tableId) => { setSelectedTableId(tableId); setViewMode('floor'); };
  return (
    <div className="seating-view">
      <div className="seating-actions"><strong>Manage your event seating</strong><SeatingViewSwitch mode={viewMode} onChange={setViewMode} /><div><button className="button secondary" onClick={() => setExportOpen(true)}><ArrowDownload24Regular /> Export</button><button className="button secondary" onClick={() => setArrangeOpen(true)}><TableMoveAbove24Regular /> Arrange tables</button><button className="button secondary" onClick={() => setLayoutOpen(true)}><Settings24Regular /> Tables & zones</button><button className="button secondary danger-action" disabled={!assignedCount} onClick={() => setClearOpen(true)}>Clear all seating</button></div></div>
      <div className="summary-strip">
        <div><span>Guests assigned</span><strong>{assignedCount}<small> / {guests.length}</small></strong></div>
        <div><span>Tables configured</span><strong>{tables.length}<small> total</small></strong></div>
        <div><span>Seat availability</span><strong>{totalSeats - assignedCount}<small> open</small></strong></div>
        <div className="summary-progress"><span>Plan completion</span><strong>{completion}%</strong><i><b style={{ width: `${completion}%` }} /></i></div>
      </div>
      {notice && <div className="toast" role="status"><Checkmark24Regular /><span>{notice}</span><button onClick={() => setNotice('')}><Dismiss20Regular /></button></div>}
      {viewMode === 'floor' && <div className={`planner-shell ${selectedTable ? '' : 'no-inspector'}`}>
        <GuestPool
          guests={guests} tables={tables} query={query} setQuery={setQuery}
          companyFilter={companyFilter} setCompanyFilter={setCompanyFilter}
          onImportClick={() => fileRef.current?.click()} onAutoAssign={() => setAutoAssignOpen(true)}
        />
        <main className="floor-panel">
          <div className="floor-toolbar">
            <label className="zone-filter">Show area <select aria-label="Show seating area" value={zone} onChange={e => setZone(e.target.value)}><option value="">Entire room ({tables.length} tables)</option>{zones.map(z => <option key={z} value={z}>{z} ({tables.filter(t => t.zone === z).length})</option>)}</select></label>
            <div className="view-tools">
              <div className="zoom-controls">
                <button type="button" className="zoom-step" aria-label="Zoom out" disabled={zoom <= ZOOM_MIN} onClick={() => setZoom((current) => current - 10)}><ZoomOut20Regular /></button>
                <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label="Floor plan zoom" />
                <button type="button" className="zoom-step" aria-label="Zoom in" disabled={zoom >= ZOOM_MAX} onClick={() => setZoom((current) => current + 10)}><ZoomIn20Regular /></button>
                <output aria-live="polite">{zoom}%</output>
              </div>
              <button type="button" onClick={fitRoom}><ZoomFit20Regular /> Fit room</button>
              <button onClick={() => setArrangeOpen(true)}><TableMoveAbove24Regular /> Arrange</button>
              <button onClick={() => setLayoutOpen(true)}><Settings24Regular /> Tables & zones</button>
              <button onClick={() => setCompactLayout(value => !value)}><Grid24Regular /> {compactLayout ? 'Roomy spacing' : 'Compact spacing'}</button>
            </div>
          </div>
          <div className="floor-scroll" ref={floorScrollRef}>
            <div className={`floor-canvas ${zoom < 55 ? 'overview-zoom' : ''}`} style={{ '--zoom': zoom / 100, '--label-boost': Math.min(3.6, Math.max(1, 0.9 / (zoom / 100))) }}>
              <div className="stage-marker"><span>MAIN STAGE</span></div>
              <div className={`floor-rows ${compactLayout ? 'compact-layout' : ''}`}>
                {visibleRows.map((item) => <section className="floor-row-group" key={item.row}><div className="floor-row-label"><span>Row {item.row}</span><small>{item.tables.length} {item.tables.length === 1 ? 'table' : 'tables'}{zone ? ` in ${zone}` : ''}</small></div><div className="floor-row" style={{ '--columns': item.tables.length }}>{item.tables.map((table) => <TableVisual key={table.id} table={table} guests={guests} selected={selectedTableId === table.id} onSelect={setSelectedTableId} onDropGuest={dropGuest} />)}</div></section>)}
              </div>
            </div>
          </div>
          <div className="floor-legend"><span><i className="legend-seat assigned" /> Assigned</span><span><i className="legend-seat" /> Open seat</span><span>Drag a guest onto any table</span></div>
        </main>
        {selectedTable && <Inspector
          table={selectedTable} guests={guests} zones={zones.length ? zones : ['Main floor']}
          onCapacity={(tableId, capacity) => setTables((current) => current.map((table) => table.id === tableId ? { ...table, capacity, capacityOverride: capacity !== Number(details.defaultSeats) } : table))}
          onName={(tableId, name) => setTables((current) => current.map((table) => table.id === tableId ? { ...table, number: tableNumber(table), name: name.slice(0, 80) } : table))}
          onNumber={(tableId, value) => {
            const number = Number(value);
            if (!Number.isInteger(number) || number < 1 || number > 999) { setNotice('Table numbers must be whole numbers from 1 to 999.'); return false; }
            const clash = tables.find((table) => table.id !== tableId && tableNumber(table) === number);
            if (clash) { setNotice(`Table ${number} is already used by ${tableAdminTitle(clash)}. Choose another number.`); return false; }
            const current = tables.find((table) => table.id === tableId);
            if (tableNumber(current) === number) return true;
            setTables((list) => list.map((table) => table.id === tableId ? { ...table, number, name: tableLabel(table) } : table));
            setNotice(`Table ${tableNumber(current)} is now Table ${number}. Guests will see the new number.`);
            return true;
          }}
          onZone={(tableId, nextZone) => setTables((current) => current.map((table) => table.id === tableId ? { ...table, zone: nextZone } : table))}
          onUnassign={(guestId) => setGuests((current) => current.map((guest) => guest.id === guestId ? { ...guest, tableId: null } : guest))}
          onClose={() => setSelectedTableId(null)}
          onAddGuest={() => setAddGuestOpen(true)}
          onMoveGuest={(guestId) => setMoving({ tableId: selectedTable.id, guestId })}
        />}
        {addGuestOpen && selectedTable && <AddGuestsModal table={selectedTable} guests={guests} onClose={() => setAddGuestOpen(false)} onAdd={placeGuests} />}        {layoutOpen && <LayoutModal tables={tables} guests={guests} details={details} onClose={() => setLayoutOpen(false)} onApply={applyLayout} />}
        {autoAssignOpen && <AutoAssignModal guests={guests} tables={tables} details={details} onClose={() => setAutoAssignOpen(false)} onApply={applyAutoAssign} />}
        {clearOpen && <Modal title="Clear all seating?" subtitle={`Remove table assignments for all ${assignedCount} seated guests in this event.`} onClose={() => setClearOpen(false)} actions={<><button className="button secondary" onClick={() => setClearOpen(false)}>Cancel</button><button className="button primary" onClick={() => { setGuests(current => current.map(g => ({ ...g, tableId: null }))); setClearOpen(false); setNotice('All table assignments cleared. Guests are ready to seat again.'); }}>Clear all seating</button></>}><p>Guest records, booking details, VIP flags, check-in history, tables and zones will be kept. This clears assignments across the entire room, including areas hidden by the filter.</p></Modal>}
      </div>}
      {viewMode === 'tables' && <TableRosterView tables={tables} guests={guests} zones={zones} onOpenTable={openTableOnFloor} onPlaceGuests={placeGuests} onDropGuest={dropGuest} onMoveGuest={(tableId, guestId) => setMoving({ tableId, guestId })} onUnassignGuest={(guestId) => changeGuestTable(guestId, null)} />}
      {arrangeOpen && <ArrangeTablesModal tables={tables} guests={guests} details={details} onClose={() => setArrangeOpen(false)} onApply={applyArrangement} />}
      {exportOpen && <ExportModal tables={tables} guests={guests} details={details} zones={zones} onClose={() => setExportOpen(false)} />}
      {movingTable && <MoveGuestsModal key={`${moving.guestId}-${moving.targetId || ''}`} sourceTable={movingTable} initialGuestId={moving.guestId} initialTargetId={moving.targetId || null} tables={tables} guests={guests} onClose={() => setMoving(null)} onMove={placeGuests} onSwap={swapGuests} />}
      {viewMode === 'guests' && <GuestSeatingRegister tables={tables} guests={guests} zones={zones} onChangeTable={changeGuestTable} />}
      {viewMode !== 'floor' && <>
        {layoutOpen && <LayoutModal tables={tables} guests={guests} details={details} onClose={() => setLayoutOpen(false)} onApply={applyLayout} />}
        {clearOpen && <Modal title="Clear all seating?" subtitle={`Remove table assignments for all ${assignedCount} seated guests in this event.`} onClose={() => setClearOpen(false)} actions={<><button className="button secondary" onClick={() => setClearOpen(false)}>Cancel</button><button className="button primary" onClick={() => { setGuests(current => current.map(g => ({ ...g, tableId: null }))); setClearOpen(false); setNotice('All table assignments cleared. Guests are ready to seat again.'); }}>Clear all seating</button></>}><p>Guest records, booking details, VIP flags, check-in history, tables and zones will be kept. This clears assignments across the entire room, including areas hidden by the filter.</p></Modal>}
      </>}
    </div>
  );
}

function GuestsView({ workspaceId, guests, setGuests, tables, fileRef, onSync, syncState, canSync }) {
  const [query, setQuery] = useState('');
  const [membershipFilter, setMembershipFilter] = useState('');
  const membershipNames = [...new Set(guests.flatMap(g => (g.bookingMembership?.levels || []).filter(l => l.active).map(l => l.name)))].sort();
  const [scope, setScope] = useState('All guests');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState('25');
  const [selectedGuest, setSelectedGuest] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [manualGuestOpen, setManualGuestOpen] = useState(false);
  const [manualGuest, setManualGuest] = useState(newManualGuest);
  const [manualGuestState, setManualGuestState] = useState({ status: 'idle', message: '' });
  const [deletingGuest, setDeletingGuest] = useState(null);
  const [deleteState, setDeleteState] = useState({ status: 'idle', message: '' });
  const openDelete = (guest) => { setDeletingGuest(guest); setDeleteState({ status: 'idle', message: '' }); };
  const deleteManualGuest = async () => {
    const guest = deletingGuest;
    setDeleteState({ status: 'deleting', message: '' });
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/guests/${encodeURIComponent(guest.id)}`, { method: 'DELETE', headers: { 'X-Seating-Request': '1' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 404) throw new Error(data.error || 'The guest could not be deleted. Please try again.');
      setGuests((current) => current.filter((item) => item.id !== guest.id));
      setSelectedIds((current) => { const next = new Set(current); next.delete(guest.id); return next; });
      setSelectedGuest((current) => current?.id === guest.id ? null : current);
      setDeletingGuest(null);
    } catch (error) {
      setDeleteState({ status: 'error', message: error.message });
    }
  };
  const rows = guests.filter((guest) => {
    const matchesQuery = `${guest.name} ${guest.company} ${guest.title} ${guest.email} ${membershipLabel(guest)}`.toLowerCase().includes(query.toLowerCase());
    const matchesScope = scope === 'All guests' || (scope === 'Unseated' && !guest.tableId) || (scope === 'VIP' && guest.vip);
    const matchesMembership = !membershipFilter || (guest.bookingMembership?.levels || []).some(level => level.active && level.name === membershipFilter);
    return matchesQuery && matchesScope && matchesMembership;
  });
  const effectivePageSize = pageSize === 'all' ? Math.max(rows.length, 1) : Number(pageSize);
  const pageCount = Math.max(1, Math.ceil(rows.length / effectivePageSize));
  const pageRows = rows.slice((page - 1) * effectivePageSize, page * effectivePageSize);
  useEffect(() => { setPage(1); setSelectedIds(new Set()); }, [query, scope, pageSize, membershipFilter]);
  useEffect(() => { setPage((current) => Math.min(current, pageCount)); }, [pageCount]);
  const toggleSelected = (guestId) => setSelectedIds((current) => { const next = new Set(current); if (next.has(guestId)) next.delete(guestId); else next.add(guestId); return next; });
  const applyVip = (vip) => {
    setGuests((current) => current.map((guest) => selectedIds.has(guest.id) ? { ...guest, vip } : guest));
    setSelectedIds(new Set());
  };
  const addManualGuest = async () => {
    const name = manualGuest.name.trim();
    const email = manualGuest.email.trim().toLowerCase();
    if (!name || !EMAIL_PATTERN.test(email)) {
      setManualGuestState({ status: 'error', message: 'Enter the guest’s full name and a valid email address.' });
      return;
    }
    setManualGuestState({ status: 'saving', message: '' });
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/guests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Seating-Request': '1' },
        body: JSON.stringify({ ...manualGuest, name, email, tableId: manualGuest.tableId ? Number(manualGuest.tableId) : null })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The guest could not be added.');
      setGuests((current) => [data.guest, ...current.filter((guest) => guest.id !== data.guest.id)]);
      setQuery('');
      setScope('All guests');
      setMembershipFilter('');
      setPage(1);
      setManualGuest(newManualGuest());
      setManualGuestState({ status: 'idle', message: '' });
      setManualGuestOpen(false);
    } catch (error) {
      setManualGuestState({ status: 'error', message: error.message });
    }
  };
  const exportCsv = () => {
    const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const content = [
      ['Name', 'Email', 'Company', 'Job title', 'VIP', 'Table number', 'Table name (admin)', 'Booking account membership (current)'],
      ...rows.map((guest) => { const table = tables.find((item) => item.id === guest.tableId); return [guest.name, guest.email, guest.company, guest.title, guest.vip ? 'Yes' : 'No', table ? tableNumber(table) : 'Unseated', table ? tableLabel(table) : '', membershipLabel(guest)]; })
    ].map((row) => row.map(escape).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'seating-guests.csv'; link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <main className="directory-view">
      <div className="directory-intro">
        <div><h2>Everyone in one place</h2><p>Review company, seniority and seating before invitations go out.</p></div>
        <div className="directory-actions"><button className="button secondary" onClick={onSync} disabled={!canSync || syncState === 'syncing'}><Sparkle24Regular /> {syncState === 'syncing' ? 'Checking MEC…' : 'Sync confirmed bookings'}</button><button className="button secondary" onClick={() => fileRef.current?.click()}><ArrowUpload24Regular /> Import CSV</button><button className="button primary" onClick={() => { setManualGuest(newManualGuest()); setManualGuestState({ status: 'idle', message: '' }); setManualGuestOpen(true); }}><PersonAdd24Regular /> Add guest</button></div>
      </div>
      <div className="directory-tools">
        <div className="search-box large"><Search24Regular /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${guests.length} guests`} /></div>
        <div className="segmented">{['All guests', 'Unseated', 'VIP'].map((item) => <button key={item} className={scope === item ? 'active' : ''} onClick={() => setScope(item)}>{item}</button>)}</div>
        <label className="membership-filter">Booking membership<select aria-label="Filter booking membership" value={membershipFilter} onChange={e => setMembershipFilter(e.target.value)}><option value="">All membership types</option>{membershipNames.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        {selectedIds.size > 0 ? <div className="guest-bulk-actions"><strong>{selectedIds.size} selected</strong><button className="button secondary" onClick={() => applyVip(true)}><Star24Filled /> Mark VIP</button><button className="button secondary" onClick={() => applyVip(false)}><Star24Regular /> Remove VIP</button></div> : <button className="button secondary" onClick={exportCsv}><ArrowDownload24Regular /> Export</button>}
      </div>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead><tr><th className="select-cell"><input type="checkbox" aria-label="Select all guests shown" checked={pageRows.length > 0 && pageRows.every((guest) => selectedIds.has(guest.id))} onChange={(event) => setSelectedIds((current) => { const next = new Set(current); pageRows.forEach((guest) => event.target.checked ? next.add(guest.id) : next.delete(guest.id)); return next; })} /></th><th>Guest</th><th>Company</th><th>Job title</th><th>Booking membership<small>Current account status</small></th><th>Table</th><th>Ticket</th><th></th></tr></thead>
          <tbody>{pageRows.map((guest) => {
            const table = tables.find((item) => item.id === guest.tableId);
            return <tr key={guest.id}>
              <td className="select-cell"><input type="checkbox" aria-label={`Select ${guest.name}`} checked={selectedIds.has(guest.id)} onChange={() => toggleSelected(guest.id)} /></td>
              <td><div className="guest-cell"><div className={`avatar small ${guest.vip ? 'vip-avatar' : ''}`}>{initials(guest.name)}</div><span><strong>{guest.name}</strong><small>{guest.email}</small></span></div></td>
              <td>{guest.company}</td><td>{guest.title}</td>
              <td><span className={`membership-badge ${guest.bookingMembership?.status === 'active' ? 'active' : ''}`}>{membershipLabel(guest)}</span></td>
              <td>{table ? <span className="table-badge">{tableAdminTitle(table)}</span> : <span className="warning-text">Unseated</span>}</td>
              <td><span className={`ticket-state ${guest.bookingId ? '' : 'muted'}`}><QrCode24Regular /> {guest.bookingId ? 'MEC booking linked' : guest.source === 'manual' ? 'Manual guest' : 'Needs booking ID'}</span></td><td><div className="guest-row-actions"><IconButton label={guest.vip ? `Remove VIP from ${guest.name}` : `Mark ${guest.name} as VIP`} className={guest.vip ? 'vip-toggle active' : 'vip-toggle'} onClick={() => setGuests((current) => current.map((item) => item.id === guest.id ? { ...item, vip: !item.vip } : item))}>{guest.vip ? <Star24Filled /> : <Star24Regular />}</IconButton><IconButton label={`Edit ${guest.name}`} onClick={() => setSelectedGuest({ ...guest })}><MoreHorizontal24Regular /></IconButton>{guest.source === 'manual' && <IconButton label={`Delete ${guest.name}`} className="guest-delete" onClick={() => openDelete(guest)}><Delete24Regular /></IconButton>}</div></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <div className="table-footer"><span>Showing {rows.length ? (page - 1) * effectivePageSize + 1 : 0}-{Math.min(page * effectivePageSize, rows.length)} of {rows.length} guests</span><div className="pagination-tools"><label>Rows <select aria-label="Guests per page" value={pageSize} onChange={(event) => setPageSize(event.target.value)}><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="all">All</option></select></label><button disabled={page === 1 || pageSize === 'all'} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="Previous guest page"><ChevronLeft20Regular /></button><strong>{pageSize === 'all' ? 'All' : `${page} / ${pageCount}`}</strong><button disabled={page === pageCount || pageSize === 'all'} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} aria-label="Next guest page"><ChevronRight20Regular /></button></div></div>
      {manualGuestOpen && <Modal title="Add guest" subtitle="Create an event-only guest record. Name and email are required." onClose={() => { if (manualGuestState.status !== 'saving') setManualGuestOpen(false); }} actions={<><button className="button secondary" onClick={() => setManualGuestOpen(false)} disabled={manualGuestState.status === 'saving'}>Cancel</button><button className="button primary" onClick={addManualGuest} disabled={manualGuestState.status === 'saving' || !manualGuest.name.trim() || !EMAIL_PATTERN.test(manualGuest.email.trim())}><PersonAdd24Regular />{manualGuestState.status === 'saving' ? 'Adding guest…' : 'Add guest'}</button></>}>
        <div className="settings-grid">
          <label className="modal-field full"><span>Full name <em>Required</em></span><input value={manualGuest.name} maxLength={160} onChange={(event) => { setManualGuest((guest) => ({ ...guest, name: event.target.value })); setManualGuestState({ status: 'idle', message: '' }); }} placeholder="Guest’s full name" required /></label>
          <label className="modal-field full"><span>Email <em>Required</em></span><input type="email" inputMode="email" autoComplete="email" value={manualGuest.email} maxLength={254} onChange={(event) => { setManualGuest((guest) => ({ ...guest, email: event.target.value })); setManualGuestState({ status: 'idle', message: '' }); }} placeholder="guest@company.com" required /></label>
          <label className="modal-field"><span>Company <em>Optional</em></span><input value={manualGuest.company} maxLength={180} onChange={(event) => setManualGuest((guest) => ({ ...guest, company: event.target.value }))} placeholder="Company name" /></label>
          <label className="modal-field"><span>Job title <em>Optional</em></span><input value={manualGuest.title} maxLength={180} onChange={(event) => setManualGuest((guest) => ({ ...guest, title: event.target.value }))} placeholder="Job title" /></label>
          <label className="modal-field"><span>Ticket label <em>Optional</em></span><input value={manualGuest.ticketName} maxLength={160} onChange={(event) => setManualGuest((guest) => ({ ...guest, ticketName: event.target.value }))} placeholder="Gala guest" /></label>
          <label className="modal-field"><span>Table <em>Optional</em></span><select value={manualGuest.tableId} onChange={(event) => setManualGuest((guest) => ({ ...guest, tableId: event.target.value }))}><option value="">Leave unseated</option>{tables.filter((table) => guests.filter((guest) => guest.tableId === table.id).length < table.capacity).map((table) => <option key={table.id} value={table.id}>{tableAdminTitle(table)} · {table.capacity - guests.filter((guest) => guest.tableId === table.id).length} open</option>)}</select></label>
          <label className="toggle-line full"><input type="checkbox" checked={manualGuest.vip} onChange={(event) => setManualGuest((guest) => ({ ...guest, vip: event.target.checked }))} /><i /><span><strong>VIP guest</strong><small>Highlights the guest in seating and check-in.</small></span></label>
        </div>
        {manualGuestState.message && <div className="checkin-error form-error" role="alert"><Alert24Regular />{manualGuestState.message}</div>}
        <div className="security-note">Manual guests can be seated and checked in immediately. They will not have an MEC ticket or QR code unless a confirmed MEC booking is later matched by email.</div>
      </Modal>}
      {selectedGuest && <Modal title="Edit guest" subtitle={selectedGuest.bookingId ? `MEC booking ${selectedGuest.bookingId}` : selectedGuest.source === 'manual' ? 'Manually added guest' : 'Imported guest record'} onClose={() => setSelectedGuest(null)} actions={<>{selectedGuest.source === 'manual' && <button className="button secondary danger-action modal-delete" onClick={() => { openDelete(guests.find((item) => item.id === selectedGuest.id) || selectedGuest); setSelectedGuest(null); }}><Delete24Regular /> Delete guest</button>}<button className="button secondary" onClick={() => setSelectedGuest(null)}>Cancel</button><button className="button primary" disabled={!selectedGuest.name.trim() || !EMAIL_PATTERN.test(selectedGuest.email.trim())} onClick={() => { setGuests((current) => current.map((guest) => guest.id === selectedGuest.id ? { ...selectedGuest, name: selectedGuest.name.trim(), email: selectedGuest.email.trim().toLowerCase() } : guest)); setSelectedGuest(null); }}>Save guest</button></>}>
        <div className="settings-grid">
          <label className="modal-field full"><span>Full name <em>Required</em></span><input value={selectedGuest.name} onChange={(event) => setSelectedGuest((guest) => ({ ...guest, name: event.target.value.slice(0, 160) }))} /></label>
          <label className="modal-field full"><span>Email <em>Required</em></span><input type="email" value={selectedGuest.email} onChange={(event) => setSelectedGuest((guest) => ({ ...guest, email: event.target.value.slice(0, 254) }))} /></label>
          <label className="modal-field"><span>Company</span><input value={selectedGuest.company} onChange={(event) => setSelectedGuest((guest) => ({ ...guest, company: event.target.value.slice(0, 180) }))} /></label>
          <label className="modal-field"><span>Job title</span><input value={selectedGuest.title} onChange={(event) => setSelectedGuest((guest) => ({ ...guest, title: event.target.value.slice(0, 180) }))} /></label>
          <label className="modal-field"><span>Table</span><select value={selectedGuest.tableId || ''} onChange={(event) => setSelectedGuest((guest) => ({ ...guest, tableId: event.target.value ? Number(event.target.value) : null }))}><option value="">Unseated</option>{tables.filter((table) => table.id === selectedGuest.tableId || guests.filter((guest) => guest.tableId === table.id).length < table.capacity).map((table) => <option key={table.id} value={table.id}>{tableAdminTitle(table)}</option>)}</select></label>
          <label className="modal-field"><span>Guest type</span><select value={selectedGuest.vip ? 'vip' : 'standard'} onChange={(event) => setSelectedGuest((guest) => ({ ...guest, vip: event.target.value === 'vip' }))}><option value="standard">Standard guest</option><option value="vip">VIP guest</option></select></label>
          <div className="security-note full">Ticket status: {selectedGuest.bookingId ? 'MEC booking linked' : 'No MEC booking ID. CSV-only guests cannot receive an MEC ticket yet.'}</div>
          <div className="security-note full"><strong>Purchaser account membership: {membershipLabel(selectedGuest)}</strong><p>Read from the WooCommerce order’s purchaser account—not the attendee’s email or MEC attendee account. This is the account’s current membership. Use Sync confirmed bookings to refresh it.</p><p>Registration: {selectedGuest.paymentStatus || 'Not verified through an order'}</p>{selectedGuest.bookingMembership?.checkedAt && <small>Last checked: {new Date(selectedGuest.bookingMembership.checkedAt).toLocaleString()}</small>}</div>
        </div>
      </Modal>}
      {deletingGuest && <Modal title={`Delete ${deletingGuest.name}?`} subtitle="Manually added guest" onClose={() => deleteState.status !== 'deleting' && setDeletingGuest(null)} actions={<><button className="button secondary" disabled={deleteState.status === 'deleting'} onClick={() => setDeletingGuest(null)}>Cancel</button><button className="button primary danger-confirm" disabled={deleteState.status === 'deleting'} onClick={deleteManualGuest}><Delete24Regular /> {deleteState.status === 'deleting' ? 'Deleting…' : 'Delete guest'}</button></>}>
        <p className="delete-summary">This permanently removes {deletingGuest.name}{deletingGuest.email ? ` (${deletingGuest.email})` : ''} from this event{deletingGuest.tableId ? `, including their seat at ${tables.find((table) => table.id === deletingGuest.tableId)?.name || 'their table'}` : ''}. It cannot be undone.</p>
        {deletingGuest.checkedIn && <div className="checkin-error test-email-note" role="status"><Alert24Regular />This guest has already checked in. Their arrival record will be deleted too.</div>}
        {deleteState.message && <div className="checkin-error test-email-note" role="alert"><Alert24Regular />{deleteState.message}</div>}
      </Modal>}
    </main>
  );
}

function CheckInView({ workspaceId, eventDetails, onGoGuests }) {
  const [guests, setGuests] = useState([]);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('Awaiting');
  const [loading, setLoading] = useState(true);
  const [busyGuestId, setBusyGuestId] = useState('');
  const [error, setError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const videoRef = useRef(null);
  const scannerControlsRef = useRef(null);

  const loadCheckIns = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/check-in`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('The check-in list could not be refreshed.');
      const data = await response.json();
      setGuests(data.guests || []);
      setRefreshedAt(data.refreshedAt || new Date().toISOString());
      setError('');
    } catch (loadError) { setError(loadError.message); }
    finally { if (!quiet) setLoading(false); }
  };

  useEffect(() => {
    loadCheckIns();
    const timer = setInterval(() => loadCheckIns(true), 15000);
    return () => clearInterval(timer);
  }, [workspaceId]);

  const findScannedGuest = async (rawValue) => {
    const value = String(rawValue || '').trim();
    let matches = findGuestsFromScan(guests, value);
    setScope('All');
    setScannerOpen(false);
    const reference = matches.length ? '' : invoiceReferenceFromScan(value);
    if (reference) {
      setScanMessage('Checking the ticket');
      try {
        const response = await fetch(`/api/check-in/resolve-ticket?key=${encodeURIComponent(reference)}`, { headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.invoiceKey) matches = findGuestsFromScan(guests, data.invoiceKey);
      } catch {}
    }
    if (matches.length) {
      const sharedInvoice = matches.length > 1 && (matches[0].transactionId || matches[0].invoiceKey);
      setQuery(sharedInvoice || matches[0].name);
      setScanMessage(matches.length > 1
        ? `${matches.length} guests found on this booking. Confirm each name and table before check-in.`
        : `${matches[0].name} found. Confirm the table and tap Check in.`);
      setError('');
    } else {
      setQuery(value);
      setScanMessage('No guest matched that QR code. Try the manual search or confirm the ticket belongs to this event.');
    }
  };

  useEffect(() => {
    if (!scannerOpen) return undefined;
    let active = true;
    setScanMessage('Point the rear camera at the guest ticket QR code.');
    import('@zxing/browser').then(async ({ BrowserQRCodeReader }) => {
      if (!active || !videoRef.current) return;
      const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 250, delayBetweenScanSuccess: 750 });
      const controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, videoRef.current, (result, _error, callbackControls) => {
        if (!result || !active) return;
        callbackControls.stop();
        findScannedGuest(result.getText());
      });
      if (active) scannerControlsRef.current = controls;
      else controls.stop();
    }).catch(() => {
      if (active) setScanMessage('Camera access is unavailable. Allow camera permission in the browser, or use manual search.');
    });
    return () => { active = false; scannerControlsRef.current?.stop(); scannerControlsRef.current = null; };
  }, [scannerOpen]);

  const updateCheckIn = async (guest, checkedIn) => {
    setBusyGuestId(guest.id); setError('');
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/check-in/${encodeURIComponent(guest.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Seating-Request': '1' },
        body: JSON.stringify({ checkedIn })
      });
      if (!response.ok) throw new Error('Check-in could not be saved. Please try again.');
      const data = await response.json();
      setGuests((current) => current.map((item) => item.id === guest.id ? data.guest : item));
      setRefreshedAt(new Date().toISOString());
    } catch (saveError) { setError(saveError.message); }
    finally { setBusyGuestId(''); }
  };

  const checkedInCount = guests.filter((guest) => guest.checkedIn).length;
  const unseatedCount = guests.filter((guest) => !guest.tableId).length;
  const needle = query.trim().toLowerCase();
  const visibleGuests = guests.filter((guest) => {
    const matchesQuery = !needle || `${guest.name} ${guest.email} ${guest.company} ${guest.title} ${guest.bookingId} ${guest.invoiceKey} ${guest.transactionId} ${guest.tableName}`.toLowerCase().includes(needle);
    const matchesScope = scope === 'All' || (scope === 'Awaiting' && !guest.checkedIn) || (scope === 'Checked in' && guest.checkedIn) || (scope === 'Unseated' && !guest.tableId);
    return matchesQuery && matchesScope;
  }).sort((first, second) => Number(first.checkedIn) - Number(second.checkedIn) || Number(second.vip) - Number(first.vip) || first.name.localeCompare(second.name));

  return <main className="checkin-view">
    <section className="checkin-hero">
      <div><span className="checkin-kicker">LIVE ARRIVALS</span><h2>{eventDetails.name}</h2><p>{eventDetails.dateLabel}{eventDetails.venue ? ` · ${eventDetails.venue}` : ''}</p></div>
      <div className="checkin-stats" aria-label="Check-in summary">
        <div><strong>{guests.length}</strong><span>Expected</span></div>
        <div className="arrived"><strong>{checkedInCount}</strong><span>Arrived</span></div>
        <div><strong>{Math.max(0, guests.length - checkedInCount)}</strong><span>Remaining</span></div>
        <div className={unseatedCount ? 'attention' : ''}><strong>{unseatedCount}</strong><span>Need tables</span></div>
      </div>
    </section>
    <section className="checkin-console">
      <div className="checkin-controls">
        <div className="checkin-search"><Search24Regular /><input value={query} onChange={(event) => { setQuery(event.target.value); setScanMessage(''); }} placeholder="Search name, email, company, booking or table" aria-label="Search check-in guests" />{query && <IconButton label="Clear search" onClick={() => { setQuery(''); setScanMessage(''); }}><Dismiss20Regular /></IconButton>}</div>
        <div className="segmented checkin-scopes">{['Awaiting', 'All', 'Checked in', 'Unseated'].map((item) => <button key={item} className={scope === item ? 'active' : ''} onClick={() => setScope(item)}>{item}</button>)}</div>
        <button className="button primary scan-button" onClick={() => setScannerOpen(true)}><ScanCamera24Regular /> Scan QR</button>
        <button className="button secondary refresh-button" onClick={() => loadCheckIns()} disabled={loading}><ArrowSync24Regular /> Refresh</button>
      </div>
      <div className="checkin-status-line"><span>{visibleGuests.length} guests shown</span><span>{refreshedAt ? `Updated ${new Date(refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Connecting to guest list'}</span></div>
      {error && <div className="checkin-error" role="alert"><Alert24Regular />{error}</div>}
      {scanMessage && !scannerOpen && <div className="scan-result" role="status"><ScanCamera24Regular />{scanMessage}</div>}
      {loading ? <div className="checkin-loading"><i /><i /><i /></div> : guests.length === 0 ? <div className="checkin-empty"><People24Regular /><h3>No guests are ready for check-in</h3><p>Sync confirmed paid bookings in Guest directory before the doors open.</p><button className="button primary" onClick={onGoGuests}>Open Guest directory</button></div> :
        <div className="checkin-list">{visibleGuests.map((guest) => <article key={guest.id} className={`checkin-row ${guest.checkedIn ? 'is-checked-in' : ''}`}>
          <div className={`avatar checkin-avatar ${guest.vip ? 'vip-avatar' : ''}`}>{initials(guest.name)}</div>
          <div className="checkin-identity"><span>{guest.vip ? 'VIP' : guest.ticketName || 'Guest'}</span><strong>{guest.name}</strong><small>{guest.company}{guest.title ? ` · ${guest.title}` : ''}</small><em>{guest.email || `Booking ${guest.bookingId}`}</em></div>
          <div className={`checkin-table ${guest.tableId ? '' : 'missing'}`}><span>{guest.tableId ? 'TABLE' : 'SEATING'}</span><strong>{guest.tableName || 'Not assigned'}</strong><small>{guest.zone || 'Send to seating desk'}</small></div>
          <div className="checkin-state">{guest.checkedIn ? <><CheckmarkCircle24Regular /><strong>Checked in</strong><small>{guest.checkedInAt ? new Date(guest.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</small></> : <><span className="arrival-dot" /><strong>Awaiting arrival</strong><small>{guest.bookingId ? `Booking ${guest.bookingId}` : 'Manual record'}</small></>}</div>
          <button className={`button ${guest.checkedIn ? 'secondary' : 'primary'} checkin-action`} onClick={() => updateCheckIn(guest, !guest.checkedIn)} disabled={busyGuestId === guest.id}>{busyGuestId === guest.id ? 'Saving…' : guest.checkedIn ? 'Undo' : 'Check in'}</button>
        </article>)}</div>}
      {!loading && guests.length > 0 && visibleGuests.length === 0 && <div className="checkin-empty compact"><Search24Regular /><h3>No matching guests</h3><p>Try another spelling or switch the status filter.</p></div>}
    </section>
    {scannerOpen && <Modal title="Scan guest QR" subtitle="Camera processing stays in this browser. No video is uploaded." onClose={() => setScannerOpen(false)} actions={<button className="button secondary" onClick={() => setScannerOpen(false)}>Stop camera</button>}>
      <div className="scanner-frame"><video ref={videoRef} muted playsInline /><div className="scanner-target"><i /><i /><i /><i /></div></div>
      <div className="scanner-guidance"><ScanCamera24Regular /><span>{scanMessage}</span></div>
    </Modal>}
  </main>;
}

function MessagesView({ workspaceId, guests, tables, setView, eventDetails, campaign, onCampaignChange, onEventIdChange }) {
  const assigned = guests.filter((guest) => guest.tableId);
  const ready = assigned.filter((guest) => guest.email);
  // Preview and test emails use a seated guest with a check-in QR whenever one exists.
  const previewGuest = assigned.find((guest) => guest.qrToken || guest.invoiceKey || guest.transactionId) || assigned[0] || null;
  const previewTable = previewGuest ? tables.find((table) => table.id === previewGuest.tableId) : null;
  const [sent, setSent] = useState(false);
  const [previewMode, setPreviewMode] = useState('desktop');
  const [integrationOpen, setIntegrationOpen] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [testEmailOpen, setTestEmailOpen] = useState(false);
  const [testRecipient, setTestRecipient] = useState('');
  const [testState, setTestState] = useState({ status: 'idle', message: '' });
  const htmlEditorRef = useRef(null);
  const [mailState, setMailState] = useState({ status: 'checking', configured: false, provider: 'SMTP', fromAddress: '', error: '' });
  const [mecState, setMecState] = useState({ status: 'checking', events: [], ticketCount: 0, error: '' });
  const [mecEventId, setMecEventId] = useState(eventDetails.mecEventId || '');
  const [campaignDraft, setCampaignDraft] = useState({ subject: campaign.subject || `Your table for ${eventDetails.name}`, replyTo: campaign.replyTo || '', htmlBody: campaign.htmlBody || templateForEvent(eventDetails), attachCalendar: campaign.attachCalendar !== false, includeMecQr: Boolean(campaign.includeMecQr), preparedAt: campaign.preparedAt || '' });
  const updateCampaignDraft = (changes) => { setCampaignDraft((draft) => ({ ...draft, ...changes })); setSent(false); };
  const insertEmailVariable = (variable) => {
    const editor = htmlEditorRef.current;
    const start = editor?.selectionStart ?? campaignDraft.htmlBody.length;
    const end = editor?.selectionEnd ?? start;
    const nextBody = `${campaignDraft.htmlBody.slice(0, start)}${variable}${campaignDraft.htmlBody.slice(end)}`;
    updateCampaignDraft({ htmlBody: nextBody });
    requestAnimationFrame(() => { editor?.focus(); editor?.setSelectionRange(start + variable.length, start + variable.length); });
  };
  const [previewQr, setPreviewQr] = useState('');
  useEffect(() => {
    const ticketKey = previewGuest?.qrToken || previewGuest?.invoiceKey || previewGuest?.transactionId || '';
    const ticket = ticketKey && TICKET_BASE_URL ? `${TICKET_BASE_URL}${ticketKey}` : '';
    if (!ticket) { setPreviewQr(''); return undefined; }
    let active = true;
    QRCode.toDataURL(ticket, { width: 360, margin: 2 }).then((url) => { if (active) setPreviewQr(url); }).catch(() => { if (active) setPreviewQr(''); });
    return () => { active = false; };
  }, [previewGuest?.qrToken, previewGuest?.invoiceKey, previewGuest?.transactionId]);
  const previewHtml = renderEmailTemplate(campaignDraft.htmlBody, previewGuest, previewTable, eventDetails, previewQr);
  const checkMail = async () => {
    setMailState((current) => ({ ...current, status: 'checking', error: '' }));
    try {
      const response = await fetch('/api/email/status', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Mail status could not be checked.');
      setMailState({ status: data.configured ? 'ready' : 'missing', configured: Boolean(data.configured), provider: data.provider || 'SMTP', fromAddress: data.fromAddress || '', error: '' });
    } catch (error) { setMailState({ status: 'error', configured: false, provider: 'SMTP', fromAddress: '', error: error.message }); }
  };
  const sendTestEmail = async () => {
    setTestState({ status: 'sending', message: '' });
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/campaign/test-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Seating-Request': '1' },
        body: JSON.stringify({ to: testRecipient, subject: campaignDraft.subject, replyTo: campaignDraft.replyTo, htmlBody: campaignDraft.htmlBody, attachCalendar: campaignDraft.attachCalendar, previewGuestId: previewGuest?.id || '' })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The test email could not be sent.');
      onCampaignChange({ ...campaignDraft });
      setTestState({ status: 'sent', message: `Test delivered to ${data.to} using ${data.previewName || 'sample guest'} details.` });
    } catch (error) { setTestState({ status: 'error', message: error.message }); }
  };
  const checkMec = async () => {
    setMecState((current) => ({ ...current, status: 'checking', error: '' }));
    try {
      if (!mecEventId) throw new Error('Add an MEC event ID in Event settings');
      const [eventResponse, ticketsResponse] = await Promise.all([
        fetch(`/api/mec/events/${mecEventId}`),
        fetch(`/api/mec/events/${mecEventId}/tickets`)
      ]);
      if (!eventResponse.ok || !ticketsResponse.ok) throw new Error(`Connection returned ${eventResponse.status}/${ticketsResponse.status}`);
      const [eventData, ticketsData] = await Promise.all([eventResponse.json(), ticketsResponse.json()]);
      const events = [{ id: String(eventData.ID), title: eventData.data?.title || `Event ${eventData.ID}` }];
      setMecState({ status: 'connected', events, ticketCount: Object.keys(ticketsData.tickets || {}).length, error: '' });
    } catch (error) {
      setMecState({ status: 'error', events: [], ticketCount: 0, error: error.message });
    }
  };
  useEffect(() => { setMecEventId(eventDetails.mecEventId || ''); }, [eventDetails.mecEventId]);
  useEffect(() => { setCampaignDraft({ subject: campaign.subject || `Your table for ${eventDetails.name}`, replyTo: campaign.replyTo || '', htmlBody: campaign.htmlBody || templateForEvent(eventDetails), attachCalendar: campaign.attachCalendar !== false, includeMecQr: Boolean(campaign.includeMecQr), preparedAt: campaign.preparedAt || '' }); setSent(Boolean(campaign.preparedAt)); }, [eventDetails.mecEventId, campaign.preparedAt]);
  useEffect(() => { checkMec(); }, [mecEventId]);
  useEffect(() => { checkMail(); }, []);
  return (
    <main className="messages-view">
      <section className="campaign-column">
        <div className="campaign-heading"><div><h2>Seating announcement</h2><p>Prepare each seated guest's table and event details for a future email campaign.</p></div><span className="draft-badge">Draft</span></div>
        <div className="readiness-list">
          <div><span className="readiness-icon ready"><Checkmark24Regular /></span><span><strong>{ready.length} guests ready</strong><small>Assigned to a table with an email address</small></span></div>
          <div><span className="readiness-icon warning"><Alert24Regular /></span><span><strong>{guests.length - ready.length} guests excluded</strong><small>They need both a table and an email address</small></span><button onClick={() => setView('guests')}>Review</button></div>
          <div><span className={`readiness-icon ${mailState.status === 'ready' ? 'ready' : 'warning'}`}><Mail24Regular /></span><span><strong>{mailState.status === 'ready' ? 'Email provider ready' : mailState.status === 'checking' ? 'Checking email provider' : 'Email provider not configured'}</strong><small>{mailState.status === 'ready' ? `${mailState.provider}, sending as ${mailState.fromAddress}` : mailState.error || 'Add the sender mailbox securely on the server'}</small></span><button onClick={checkMail}>Refresh</button></div>
          <div><span className={`readiness-icon ${mecState.status === 'connected' ? 'ready' : 'warning'}`}><QrCode24Regular /></span><span><strong>{mecState.status === 'connected' ? 'MEC API connected' : mecState.status === 'checking' ? 'Checking MEC connection' : 'MEC connection needs attention'}</strong><small>{mecState.status === 'connected' ? `Event ${mecEventId}, ${mecState.ticketCount} ticket type found` : mecState.error || 'Connecting through the secure server proxy'}</small></span><button onClick={() => setIntegrationOpen(true)}>Details</button></div>
        </div>
        <div className="send-settings">
          <label><span>Email subject</span><input maxLength={200} value={campaignDraft.subject} onChange={(event) => updateCampaignDraft({ subject: event.target.value })} /></label>
          <label><span>Reply-to address</span><input type="email" maxLength={254} value={campaignDraft.replyTo} onChange={(event) => updateCampaignDraft({ replyTo: event.target.value })} /></label>
          <div className="html-editor-block">
            <div className="html-editor-heading"><span>Email body (HTML)</span><button type="button" onClick={() => updateCampaignDraft({ htmlBody: templateForEvent(eventDetails) })}>Restore template</button></div>
            <div className="template-variables" aria-label="Insert email variables">{EMAIL_VARIABLES.map((variable) => <button type="button" key={variable} onClick={() => insertEmailVariable(variable)}>{variable}</button>)}</div>
            <textarea ref={htmlEditorRef} className="html-editor" spellCheck="false" maxLength={300000} value={campaignDraft.htmlBody} onChange={(event) => updateCampaignDraft({ htmlBody: event.target.value })} aria-label="Email body HTML" />
            <small>Use inline styles for best email compatibility. Scripts, forms, embedded frames and unsafe URLs are removed before delivery.</small>
          </div>
          <label className="toggle-line"><input type="checkbox" checked={campaignDraft.attachCalendar} onChange={(event) => updateCampaignDraft({ attachCalendar: event.target.checked })} /><i /><span><strong>Attach calendar invitation</strong><small>Includes venue and arrival time</small></span></label>
        </div>
        <div className="send-bar"><div><span>Recipients</span><strong>{ready.length}</strong></div><div className="send-actions"><button className="button secondary" onClick={() => { setTestRecipient((current) => current || campaignDraft.replyTo); setTestState({ status: 'idle', message: '' }); setTestEmailOpen(true); }}><Mail24Regular /> Send test email</button><button className="button primary" onClick={() => { onCampaignChange({ ...campaignDraft, preparedAt: new Date().toISOString() }); setSent(true); }} disabled={!campaignDraft.subject.trim() || !EMAIL_PATTERN.test(campaignDraft.replyTo.trim()) || !campaignDraft.htmlBody.trim()}><Send24Regular /> {sent ? 'Draft saved' : 'Save draft'}</button></div></div>
        {sent && <div className="success-note"><Checkmark24Regular /> Subject, HTML body and delivery settings saved for this event.</div>}
      </section>
      <aside className="email-preview-panel">
        <div className="preview-toolbar"><strong>Email preview</strong><div><button className={previewMode === 'desktop' ? 'active' : ''} onClick={() => setPreviewMode('desktop')}>Desktop</button><button className={previewMode === 'mobile' ? 'active' : ''} onClick={() => setPreviewMode('mobile')}>Mobile</button></div></div>
        <div className={`email-window ${previewMode === 'mobile' ? 'mobile-preview' : ''}`}>
          <div className="email-meta"><span>Preview: {previewGuest?.name || 'Sample Guest'}</span><span>Subject: {campaignDraft.subject || 'Untitled email'}</span></div>
          <iframe className="html-preview-frame" title="Rendered email body preview" sandbox="" srcDoc={previewHtml} />
        </div>
      </aside>
      {integrationOpen && <Modal title="MEC integration" subtitle="The API key stays on the server and is never exposed in this browser." onClose={() => setIntegrationOpen(false)} actions={<><button className="button secondary" onClick={checkMec}>Test connection</button><button className="button primary" onClick={() => { onEventIdChange(mecEventId); setIntegrationOpen(false); }}>Save mapping</button></>}>
        <div className="integration-status"><span className={mecState.status}></span><div><strong>{mecState.status === 'connected' ? 'Connected securely' : mecState.status === 'checking' ? 'Checking connection' : 'Connection failed'}</strong><small>{mecState.status === 'connected' ? 'MEC REST API' : mecState.error}</small></div></div>
        <label className="modal-field"><span>MEC event</span><select value={mecEventId} onChange={(event) => setMecEventId(event.target.value)} disabled={!mecState.events.length}><option value="">Select an event</option>{mecState.events.map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}</select><small>The selected event is saved for this workspace.</small></label>
        <div className="security-note">Ticket-type data can be read through this connection. Guest-specific QR codes require the MEC booking or invoice identifier for each attendee.</div>
      </Modal>}
      {testEmailOpen && <Modal title="Send test email" subtitle="Send the current preview to one address. No guest campaign will be started." onClose={() => setTestEmailOpen(false)} actions={<><button className="button secondary" onClick={() => setTestEmailOpen(false)}>{testState.status === 'sent' ? 'Done' : 'Cancel'}</button>{testState.status !== 'sent' && <button className="button primary" onClick={sendTestEmail} disabled={!mailState.configured || testState.status === 'sending' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testRecipient)}><Mail24Regular />{testState.status === 'sending' ? 'Sending…' : 'Send test'}</button>}</>}>
        <div className="integration-status"><span className={mailState.status === 'ready' ? 'connected' : 'error'}></span><div><strong>{mailState.configured ? 'Mail delivery connected' : 'Mail delivery is not configured'}</strong><small>{mailState.configured ? `${mailState.provider} · ${mailState.fromAddress}` : 'A protected mail provider must be configured on the server.'}</small></div></div>
        <label className="modal-field"><span>Test recipient</span><input type="email" inputMode="email" autoComplete="email" value={testRecipient} onChange={(event) => { setTestRecipient(event.target.value.slice(0, 254)); setTestState({ status: 'idle', message: '' }); }} placeholder="you@company.com" /><small>The subject receives a [TEST] prefix and the email uses the guest shown in the preview, or safe sample details if nobody is seated.</small></label>
        {testState.message && <div className={testState.status === 'sent' ? 'success-note test-email-note' : 'checkin-error test-email-note'} role="status" aria-live="polite">{testState.status === 'sent' ? <Checkmark24Regular /> : <Alert24Regular />}{testState.message}</div>}
        {!mailState.configured && <div className="security-note">Ask the administrator to connect an approved mail provider and verified {ORG_NAME} sender address. Credentials are never entered in this browser.</div>}
      </Modal>}
      {ticketOpen && previewGuest && <Modal title="Ticket preview" subtitle={previewGuest.name} onClose={() => setTicketOpen(false)} actions={<button className="button primary" onClick={() => setTicketOpen(false)}>Done</button>}>
        <div className="ticket-modal"><div className="qr-pending"><QrCode24Regular /><span>LIVE QR<br />PENDING</span></div><div><span>{eventDetails.name}</span><strong>{previewTable ? tableTitle(previewTable) : ""}</strong><small>{eventDetails.venue}, {eventDetails.dateLabel}</small></div></div>
      </Modal>}
    </main>
  );
}

function DashboardApp() {
  const [authStatus, setAuthStatus] = useState('checking');
  const [authUser, setAuthUser] = useState({ username: '', displayName: '', role: 'admin' });
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [view, setView] = useState('seating');
  const defaultWorkspace = {
    id: 'default-event',
    details: { name: 'New event', dateLabel: '', venue: '', defaultSeats: 10, tablesPerRow: 5, mecEventId: '', selfCheckInEnabled: false, selfCheckInVerification: false },
    guests: [], tables: makeTables(), campaign: { subject: '', replyTo: '', htmlBody: DEFAULT_EMAIL_HTML, attachCalendar: true, includeMecQr: false, preparedAt: '' }, published: false, updatedAt: new Date().toISOString()
  };
  const [workspaces, setWorkspaces] = useState([defaultWorkspace]);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState(defaultWorkspace.id);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [eventManagerOpen, setEventManagerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [profile, setProfile] = useState({ name: 'Event Admin', role: 'Administrator' });
  const [syncState, setSyncState] = useState('idle');
  const [dataReady, setDataReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveStatus, setSaveStatus] = useState('saved');
  const [saveRetry, setSaveRetry] = useState(0);
  const saveQueue = useRef(Promise.resolve());
  const lastSaved = useRef('');
  const serverRevision = useRef(0);
  const pendingBody = useRef('');
  const conflicted = useRef(false);
  const [importMessage, setImportMessage] = useState('');
  const fileRef = useRef(null);
  const workspace = workspaces.find((item) => item.id === currentWorkspaceId) || workspaces[0];
  const guests = workspace.guests;
  const tables = workspace.tables;
  const updateWorkspace = (changes) => setWorkspaces((current) => current.map((item) => {
    if (item.id !== workspace.id) return item;
    const patch = typeof changes === 'function' ? changes(item) : changes;
    return { ...item, ...patch, published: Object.hasOwn(patch, 'published') ? patch.published : false, updatedAt: new Date().toISOString() };
  }));
  const setGuests = (next) => updateWorkspace(item => ({ guests: typeof next === 'function' ? next(item.guests) : next }));
  const setTables = (next) => updateWorkspace(item => ({ tables: typeof next === 'function' ? next(item.tables) : next }));

  useEffect(() => {
    fetch('/api/auth/session', { headers: { Accept: 'application/json' } })
      .then((response) => response.ok ? response.json() : { authenticated: false })
      .then((data) => {
        if (data.authenticated) {
          setAuthUser({ username: data.username, displayName: data.displayName, role: data.role });
          if (data.role === 'checkin') { setProfile({ name: data.displayName || data.username, role: 'Check-in staff' }); setView('checkin'); }
        }
        setAuthStatus(data.authenticated ? 'authenticated' : 'anonymous');
      })
      .catch(() => setAuthStatus('anonymous'));
  }, []);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    setDataReady(false);
    setLoadError('');
    const endpoint = authUser.role === 'admin' ? '/api/workspaces' : '/api/check-in/events';
    fetch(endpoint, { headers: { Accept: 'application/json' } })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('No persistence API')))
      .then((data) => {
        if (authUser.role === 'admin' && Array.isArray(data.workspaces) && data.workspaces.length) {
          applyServerData(data);
          setDataReady(true);
          return;
        }
        if (authUser.role === 'checkin' && Array.isArray(data.events) && data.events.length) {
          const eventWorkspaces = data.events.map((event) => ({ id: event.id, details: event.details, guests: [], tables: [], campaign: {}, published: false }));
          setWorkspaces(eventWorkspaces);
          setCurrentWorkspaceId(data.currentWorkspaceId && eventWorkspaces.some((item) => item.id === data.currentWorkspaceId) ? data.currentWorkspaceId : eventWorkspaces[0].id);
          setView('checkin');
        }
        setDataReady(true);
      })
      .catch(() => setLoadError('Your event data could not be loaded. Editing is paused to protect your saved seating plan.'));
  }, [authStatus, authUser.role]);

  // Mirrors exactly what the autosave sends, so freshly loaded data is never re-saved.
  const applyServerData = (data) => {
    const loaded = data.workspaces.map((item) => ({ ...item, tables: normalizeTableNumbers(item.tables || []) }));
    const loadedId = data.currentWorkspaceId && loaded.some((item) => item.id === data.currentWorkspaceId) ? data.currentWorkspaceId : loaded[0].id;
    const loadedProfile = data.profile || { name: 'Event Admin', role: 'Administrator' };
    serverRevision.current = Number(data.revision) || 0;
    lastSaved.current = JSON.stringify({ workspaces: loaded, currentWorkspaceId: loadedId, profile: loadedProfile });
    pendingBody.current = lastSaved.current;
    setWorkspaces(loaded);
    setCurrentWorkspaceId(loadedId);
    setProfile(loadedProfile);
  };

  // Picks up other admins' saves while this tab has nothing unsaved, so edits start from the latest plan.
  useEffect(() => {
    if (!dataReady || authStatus !== 'authenticated' || authUser.role !== 'admin') return;
    let busy = false;
    const refresh = async () => {
      if (busy || conflicted.current || document.hidden || pendingBody.current !== lastSaved.current) return;
      busy = true;
      try {
        const { revision } = await fetch('/api/workspaces/revision', { headers: { Accept: 'application/json' } }).then((response) => response.ok ? response.json() : {});
        if (!Number.isInteger(revision) || revision <= serverRevision.current || pendingBody.current !== lastSaved.current) return;
        const data = await fetch('/api/workspaces', { headers: { Accept: 'application/json' } }).then((response) => response.ok ? response.json() : null);
        if (data && Array.isArray(data.workspaces) && data.workspaces.length && pendingBody.current === lastSaved.current) applyServerData(data);
      } catch {} finally { busy = false; }
    };
    const timer = setInterval(refresh, 8000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [dataReady, authStatus, authUser.role]);

  useEffect(() => {
    if (!dataReady || authStatus !== 'authenticated' || authUser.role !== 'admin') return;
    const body = JSON.stringify({ workspaces, currentWorkspaceId, profile });
    pendingBody.current = body;
    if (body === lastSaved.current || conflicted.current) return;
    let active = true;
    setSaveStatus('saving');
    const timer = setTimeout(() => {
      saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
      const response = await fetch('/api/workspaces', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Seating-Request': '1', 'X-Base-Revision': String(serverRevision.current) },
        body
      });
      if (response.status === 409) { conflicted.current = true; setSaveStatus('conflict'); return; }
      if (!response.ok) throw new Error('Save failed');
      const result = await response.json().catch(() => ({}));
      if (Number.isInteger(result.revision)) serverRevision.current = result.revision;
      lastSaved.current = body;
      if (active) setSaveStatus('saved');
      }).catch(() => { if (active && !conflicted.current) setSaveStatus('error'); });
    }, 500);
    return () => { active = false; clearTimeout(timer); };
  }, [workspaces, currentWorkspaceId, profile, dataReady, authStatus, authUser.role, saveRetry]);

  useEffect(() => {
    if (saveStatus === 'saved' || saveStatus === 'conflict') return;
    const warn = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveStatus]);

  useEffect(() => {
    const eventId = workspace.details.mecEventId;
    if (!dataReady || authStatus !== 'authenticated' || authUser.role !== 'admin' || !eventId) return;
    fetch(`/api/mec/events/${eventId}/details`, { headers: { Accept: 'application/json' } })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('MEC sync failed')))
      .then((details) => setWorkspaces((current) => current.map((item) => item.id === workspace.id ? { ...item, details: { ...mergeMecEventDetails(item.details, details), mecEventId: eventId }, published: false, updatedAt: new Date().toISOString() } : item)))
      .catch(() => {});
  }, [authStatus, authUser.role, currentWorkspaceId, workspace.details.mecEventId, dataReady]);

  const handleLogin = async (username, password) => {
    setAuthBusy(true); setAuthError('');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seating-Request': '1' }, body: JSON.stringify({ username, password }) });
      if (!response.ok) throw new Error(response.status === 429 ? 'Too many attempts. Please wait and try again.' : 'Incorrect username or password.');
      const data = await response.json();
      setAuthUser({ username: data.username, displayName: data.displayName, role: data.role });
      if (data.role === 'checkin') { setProfile({ name: data.displayName || data.username, role: 'Check-in staff' }); setView('checkin'); }
      setAuthStatus('authenticated');
    } catch (error) { setAuthError(error.message); }
    finally { setAuthBusy(false); }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Seating-Request': '1' } }).catch(() => {});
    setAuthStatus('anonymous'); setDataReady(false); setAuthError(''); setAuthUser({ username: '', displayName: '', role: 'admin' });
  };

  const syncConfirmedBookings = async () => {
    setSyncState('syncing');
    try {
      const response = await fetch(`/api/mec/events/${workspace.details.mecEventId}/confirmed-bookings`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('MEC booking sync could not be completed.');
      const result = await response.json();
      if (!Array.isArray(result.guests) || !result.guests.length) throw new Error('MEC returned no confirmed attendees, so the guest list was left unchanged. Check the event bookings and try again.');
      const { added, updated, removed, keptCheckedIn } = mergeConfirmedGuests(guests, result.guests);
      setGuests(current => mergeConfirmedGuests(current, result.guests).guests);
      const listNames = (list) => `${list.slice(0, 5).map((guest) => guest.name).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}`;
      const removedText = removed.length ? ` Removed ${removed.length} ${removed.length === 1 ? 'guest' : 'guests'} whose booking is no longer confirmed: ${listNames(removed)}.` : ' No guests were removed.';
      const keptText = keptCheckedIn.length ? ` Kept ${keptCheckedIn.length} already checked-in ${keptCheckedIn.length === 1 ? 'guest' : 'guests'} whose booking is no longer confirmed: ${listNames(keptCheckedIn)}.` : '';
      setImportMessage(`MEC sync complete: ${added} new, ${updated} updated.${removedText}${keptText} ${result.paidAttendees} paid and ${result.complimentaryAttendees} complimentary confirmed guests verified against their orders. ${result.excludedAttendees} ineligible attendee records were not imported.`);
      setSyncState('done');
    } catch (error) { setImportMessage(error.message); setSyncState('error'); }
  };

  const handleImport = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setImportMessage('Import blocked: CSV files must be smaller than 2 MB.'); event.target.value = ''; return; }
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) { setImportMessage('Import blocked: the CSV must contain a header row and at least one guest.'); event.target.value = ''; return; }
    const headers = rows[0].map((header) => header.trim().toLowerCase());
    const valueAt = (values, names) => values[headers.findIndex((header) => names.includes(header))]?.trim() || '';
    const imported = rows.slice(1, 5001).map((values, index) => {
      const name = valueAt(values, ['name', 'full name', 'attendee']);
      if (!name) return null;
      return {
        id: `I-${Date.now()}-${index}`,
        name,
        company: valueAt(values, ['company', 'organization', 'organisation']) || 'Company not provided',
        title: valueAt(values, ['title', 'job title', 'position']) || 'Title not provided',
        email: valueAt(values, ['email', 'email address']),
        source: 'import',
        vip: /^(yes|true|vip|1)$/i.test(valueAt(values, ['vip', 'guest type'])),
        tableId: null
      };
    }).filter(Boolean);
    if (imported.length) {
      setGuests((current) => [...imported, ...current]);
      setImportMessage(`${imported.length} guests imported from ${file.name}.`);
    }
    event.target.value = '';
  };

  if (authStatus === 'checking') return <div className="login-loading"><BrandLogo className="loading-logo" /><span>Opening your secure workspace…</span></div>;
  if (authStatus !== 'authenticated') return <LoginScreen onLogin={handleLogin} error={authError} busy={authBusy} />;
  if (!dataReady) return <div className="login-loading"><BrandLogo className="loading-logo" /><p role={loadError ? 'alert' : 'status'}>{loadError || 'Loading your event…'}</p>{loadError && <button className="button primary" onClick={() => window.location.reload()}>Retry loading</button>}</div>;

  const assignedCount = guests.filter((guest) => guest.tableId).length;
  const planHealth = guests.length ? Math.round(assignedCount / guests.length * 100) : 0;

  return (
    <div className="app-shell">
      <Sidebar view={view} setView={setView} onSettings={() => setSettingsOpen(true)} onTeam={() => setTeamOpen(true)} onLogout={handleLogout} onProfile={() => setProfileOpen(true)} profile={profile} planHealth={planHealth} guestCount={guests.length} userRole={authUser.role} />
      <div className="app-content">
        <Header view={view} onImport={handleImport} fileRef={fileRef} eventDetails={workspace.details} published={workspace.published} workspaces={workspaces} currentWorkspaceId={currentWorkspaceId} onWorkspace={(id) => { setCurrentWorkspaceId(id); setImportMessage(''); }} onManageEvents={() => setEventManagerOpen(true)} onPublish={() => { updateWorkspace({ published: true, publishedAt: new Date().toISOString() }); setImportMessage('Plan published and saved.'); }} />
        {importMessage && <div className="import-banner"><Checkmark24Regular />{importMessage}<button onClick={() => setImportMessage('')}><Dismiss20Regular /></button></div>}
        {authUser.role === 'admin' && <div className={`save-status ${saveStatus}`} role="status">{saveStatus === 'saved' ? 'All changes saved' : saveStatus === 'saving' ? 'Saving changes…' : saveStatus === 'conflict' ? 'Someone else saved newer changes to this plan, so your last edit here was not saved. Reload to continue from the latest version.' : 'Changes not saved. Keep this page open.'}{saveStatus === 'conflict' && <button className="button primary" onClick={() => window.location.reload()}>Reload latest plan</button>}{saveStatus === 'error' && <button className="button secondary" onClick={() => setSaveRetry(n => n + 1)}>Retry save</button>}</div>}
        {view === 'seating' && <SeatingView key={workspace.id} guests={guests} setGuests={setGuests} tables={tables} setTables={setTables} fileRef={fileRef} details={workspace.details} onConfigure={updateWorkspace} />}
        {view === 'guests' && <GuestsView key={workspace.id} workspaceId={workspace.id} guests={guests} setGuests={setGuests} tables={tables} fileRef={fileRef} onSync={syncConfirmedBookings} syncState={syncState} canSync={Boolean(workspace.details.mecEventId)} />}
        {view === 'checkin' && <CheckInView workspaceId={workspace.id} eventDetails={workspace.details} onGoGuests={() => setView('guests')} />}
        {view === 'messages' && <MessagesView workspaceId={workspace.id} guests={guests} tables={tables} setView={setView} eventDetails={workspace.details} campaign={workspace.campaign || {}} onCampaignChange={(campaign) => updateWorkspace({ campaign })} onEventIdChange={(mecEventId) => updateWorkspace({ details: { ...workspace.details, mecEventId } })} />}
      </div>
      {settingsOpen && <EventSettingsModal key={workspace.id} workspace={workspace} onClose={() => setSettingsOpen(false)} onSave={(result) => { updateWorkspace(result); setSettingsOpen(false); setImportMessage('Event settings and table capacities updated.'); }} />}
      {eventManagerOpen && <EventManagerModal readOnly={authUser.role !== 'admin'} workspaces={workspaces} currentWorkspaceId={currentWorkspaceId} onClose={() => setEventManagerOpen(false)} onSwitch={(id) => { setCurrentWorkspaceId(id); setEventManagerOpen(false); setImportMessage('Event workspace opened.'); }} onEdit={(id) => { setCurrentWorkspaceId(id); setEventManagerOpen(false); setSettingsOpen(true); }} onCreate={() => {
        const next = makeEventWorkspace();
        setWorkspaces((current) => [...current, next]); setCurrentWorkspaceId(next.id); setEventManagerOpen(false); setSettingsOpen(true); setView('seating'); setImportMessage('New event created. Complete its event and table settings.');
      }} onDuplicate={(id) => {
        const source = workspaces.find((item) => item.id === id) || workspace;
        const next = makeEventWorkspace(source);
        setWorkspaces((current) => [...current, next]); setCurrentWorkspaceId(next.id); setEventManagerOpen(false); setSettingsOpen(true); setView('seating'); setImportMessage('Event setup duplicated without guests or seating assignments.');
      }} onDelete={(id) => {
        const remaining = workspaces.filter((item) => item.id !== id);
        if (!remaining.length) return;
        setWorkspaces(remaining); if (currentWorkspaceId === id) setCurrentWorkspaceId(remaining[0].id); setEventManagerOpen(false); setView('seating'); setImportMessage('Event workspace deleted.');
      }} />}
      {profileOpen && <ProfileModal profile={profile} onClose={() => setProfileOpen(false)} onSave={(nextProfile) => { setProfile(nextProfile); setProfileOpen(false); setImportMessage('Administrator profile updated.'); }} />}
      {teamOpen && <TeamAccessModal onClose={() => setTeamOpen(false)} />}
    </div>
  );
}
