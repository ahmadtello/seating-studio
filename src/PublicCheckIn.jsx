import React, { useEffect, useState } from 'react';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORG_NAME = import.meta.env.VITE_ORGANIZATION_NAME || 'Seating Studio';
const initials = (name = '') => name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('');

function usePageTitle(title) {
  useEffect(() => { document.title = title; }, [title]);
}

function Icon({ name, filled = false }) {
  const paths = {
    alert: <><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4.5M12 17h.01"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    checkCircle: <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16.5 9"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    location: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
    people: <><circle cx="9" cy="8" r="3"/><path d="M3.5 19c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M16 7.5a2.5 2.5 0 0 1 0 5M16.5 14c2.5.2 3.8 1.8 4 4.5"/></>,
    personCheck: <><circle cx="9" cy="7.5" r="3"/><path d="M3.5 18c.4-3.8 2.2-5.7 5.5-5.7 1.1 0 2 .2 2.8.6M14.5 17l2 2 4-5"/></>,
    star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>,
    table: <><circle cx="12" cy="12" r="5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></>
  };
  return <svg className="public-icon" viewBox="0 0 24 24" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function BrandLogo({ tone = 'green' }) {
  return <img className="brand-logo" src={tone === 'white' ? '/brand/logo-white.svg' : '/brand/logo.svg'} alt={ORG_NAME} width="64" height="64" fetchPriority="high" />;
}

function AwardsBanner() {
  return <div className="awards-identity-banner"><img src="/brand/logo-white.svg" alt={ORG_NAME} width="72" height="72" fetchPriority="high" /></div>;
}

function AwardsFooterArtwork() {
  return <div className="awards-footer-artwork" aria-hidden="true" />;
}

function PublicPageFrame({ children }) {
  return <main className="self-checkin-page public-page"><header className="self-checkin-brand"><BrandLogo tone="white" /><span>Event guest services</span></header>{children}<footer>{ORG_NAME} · Event Operations</footer></main>;
}

function NotFoundPage() {
  usePageTitle(`Page Not Found · ${ORG_NAME}`);
  return <PublicPageFrame><section className="self-checkin-card not-found-card">
    <span className="not-found-code">404</span><h1>This page missed its table.</h1><p>The link may be incomplete, expired, or intended for a different event.</p>
    <div className="public-page-actions"><a className="button primary" href="/">Portal login</a><a className="button secondary" href="/self-check-in">Guest check-in</a></div>
  </section></PublicPageFrame>;
}

function SelfCheckInLanding() {
  usePageTitle(`Guest Check-In · ${ORG_NAME}`);
  const [events, setEvents] = useState([]);
  const [currentEvent, setCurrentEvent] = useState(null);
  const [status, setStatus] = useState('loading');
  useEffect(() => {
    fetch('/api/public/self-check-in', { headers: { Accept: 'application/json' } })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Guest check-in could not be loaded.')))
      .then((data) => { setEvents(data.events || []); setCurrentEvent(data.currentEvent || null); setStatus('ready'); })
      .catch(() => setStatus('error'));
  }, []);
  if (status === 'ready' && currentEvent?.id) return <SelfCheckInPage workspaceId={currentEvent.id} />;
  return <PublicPageFrame><section className="self-checkin-card checkin-landing-card">
    <div className="self-event-heading"><h1>Find your event</h1><p>Select your event to continue with your registration email.</p></div>
    {status === 'loading' && <div className="self-checkin-loading compact"><i /><p>Finding active events…</p></div>}
    {status === 'ready' && events.length > 0 && <div className="public-event-list">{events.map((event) => <a key={event.id} href={`/self-check-in/${event.id}`}><Icon name="calendar" /><span><strong>{event.name}</strong><small>{[event.dateLabel, event.startTime, event.venue].filter(Boolean).join(' · ')}</small></span><Icon name="chevron" /></a>)}</div>}
    {status === 'ready' && events.length === 0 && <div className="self-checkin-state compact"><Icon name="calendar" /><h2>No guest check-in is open</h2><p>Please use the event-specific link from the organiser or visit the welcome desk.</p></div>}
    {status === 'error' && <div className="self-checkin-state compact"><Icon name="alert" /><h2>Check-in is temporarily unavailable</h2><p>Please try again or visit the welcome desk.</p></div>}
    <a className="self-text-button public-login-link" href="/">Event team portal login</a>
  </section></PublicPageFrame>;
}

function SelfCheckInPage({ workspaceId }) {
  const [event, setEvent] = useState(null);
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [guests, setGuests] = useState([]);
  const [selectedGuestId, setSelectedGuestId] = useState('');
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  usePageTitle(event?.name ? `Guest Check-In · ${event.name}` : `Guest Check-In · ${ORG_NAME}`);
  useEffect(() => {
    fetch(`/api/public/self-check-in/${encodeURIComponent(workspaceId)}`, { headers: { Accept: 'application/json' } })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Self check-in is unavailable.'); return data; })
      .then((data) => { setEvent(data.event); setVerificationRequired(Boolean(data.verificationRequired)); setStatus('email'); })
      .catch((loadError) => { setError(loadError.message); setStatus('unavailable'); });
  }, [workspaceId]);
  const acceptAccess = (data) => {
    setEvent(data.event); setAccessToken(data.accessToken); setGuests(data.guests || []);
    const arrived = (data.guests || []).find((guest) => guest.checkedIn);
    setSelectedGuestId(arrived?.id || ((data.guests || []).length === 1 ? data.guests[0].id : ''));
    setStatus('ready'); setError('');
  };
  const recordArrival = async (guest, token) => {
    const response = await fetch(`/api/public/self-check-in/${encodeURIComponent(workspaceId)}/guests/${encodeURIComponent(guest.id)}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'X-Seating-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ checkedIn: true }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Your arrival could not be saved.');
    return data.guest;
  };
  const openAccess = async (data) => {
    const matches = data.guests || [];
    if (matches.length !== 1 || matches[0].checkedIn) { acceptAccess(data); return; }
    acceptAccess(data);
    setStatus('checking-in');
    try {
      const checkedGuest = await recordArrival(matches[0], data.accessToken);
      acceptAccess({ ...data, guests: [checkedGuest] });
    } catch (arrivalError) {
      setStatus('ready');
      setError(arrivalError.message);
    }
  };
  const begin = async (eventObject) => {
    eventObject.preventDefault(); setStatus('busy'); setError('');
    try {
      const response = await fetch(`/api/public/self-check-in/${encodeURIComponent(workspaceId)}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seating-Request': '1' }, body: JSON.stringify({ email: email.trim().toLowerCase() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'We could not find your registration.');
      if (data.verified) await openAccess(data); else { setChallengeId(data.challengeId); setStatus('code'); }
    } catch (submitError) { setError(submitError.message); setStatus('email'); }
  };
  const verify = async (eventObject) => {
    eventObject.preventDefault(); setStatus('verifying'); setError('');
    try {
      const response = await fetch(`/api/public/self-check-in/${encodeURIComponent(workspaceId)}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seating-Request': '1' }, body: JSON.stringify({ challengeId, code }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'That code could not be verified.');
      await openAccess(data);
    } catch (verifyError) { setError(verifyError.message); setStatus('code'); }
  };
  const checkIn = async (guest) => {
    if (guest.checkedIn) { setSelectedGuestId(guest.id); return; }
    setStatus('checking-in'); setError('');
    try {
      const checkedGuest = await recordArrival(guest, accessToken);
      setGuests((current) => current.map((item) => item.id === checkedGuest.id ? checkedGuest : item));
      setSelectedGuestId(checkedGuest.id); setStatus('ready');
    } catch (checkInError) { setError(checkInError.message); setStatus('ready'); }
  };
  const selectedGuest = guests.find((guest) => guest.id === selectedGuestId);
  const assignedTableLabel = selectedGuest?.tableName?.replace(/^table\s+/i, '') || '';
  const checkedInTime = selectedGuest?.checkedInAt && !Number.isNaN(Date.parse(selectedGuest.checkedInAt)) ? new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(selectedGuest.checkedInAt)) : '';
  const entryActive = Boolean(event && ['email', 'busy'].includes(status));
  const resultActive = Boolean(event && status === 'ready' && selectedGuest?.checkedIn);
  const brandedActive = entryActive || resultActive;
  const reset = () => { setEmail(''); setCode(''); setChallengeId(''); setAccessToken(''); setGuests([]); setSelectedGuestId(''); setError(''); setStatus('email'); };
  return <main className={`self-checkin-page awards-checkin-page ${entryActive ? 'self-entry-page' : ''} ${resultActive ? 'self-result-page' : ''}`}>
    {!brandedActive && <header className="self-checkin-brand"><BrandLogo tone="white" /><span>Guest arrival</span></header>}
    <section className={`self-checkin-card ${entryActive ? 'self-entry-card' : ''} ${status === 'ready' && selectedGuest?.checkedIn ? 'welcome-card' : ''}`}>
      {status === 'loading' && <div className="self-checkin-loading"><i /><p>Opening self check-in…</p></div>}
      {status === 'unavailable' && <div className="self-checkin-state"><Icon name="alert" /><h1>This check-in link is not active</h1><p>{error}</p><small>Please choose an active event or visit the welcome desk.</small><div className="public-page-actions"><a className="button primary" href="/self-check-in">Find guest check-in</a><a className="button secondary" href="/">Portal login</a></div></div>}
      {entryActive && <div className="self-entry-layout">
        <AwardsBanner />
        <div className="self-entry-content">
        <section className="entry-event-panel" aria-label="Event information">
          <div className="entry-event-copy"><h1>Welcome</h1><p>We look forward to welcoming you for an exceptional evening celebrating excellence in facilities management.</p></div>
          <dl className="entry-event-facts"><div><Icon name="calendar" /><dt>Date</dt><dd>{event.dateLabel || 'Event day'}</dd></div><div><Icon name="clock" /><dt>Event time</dt><dd>{event.startTime ? `${event.startTime}${event.endTime ? ` – ${event.endTime}` : ''}` : 'See invitation'}</dd></div><div><Icon name="location" /><dt>Venue</dt><dd>{event.venue || 'See invitation'}</dd></div></dl>
        </section>
        <section className="entry-form-panel">
          <div className="entry-form-heading"><h2>Self Check-In</h2><p>Please enter the email address you used for your registration to check in and view your assigned table.</p></div>
          <form className="self-checkin-form entry-checkin-form" onSubmit={begin}>
            <label><span>Email Address</span><div><Icon name="mail" /><input type="email" inputMode="email" enterKeyHint="go" autoCapitalize="none" autoCorrect="off" spellCheck="false" autoComplete="email" autoFocus required value={email} onChange={(inputEvent) => setEmail(inputEvent.target.value)} placeholder="Email Address" /></div></label>
            {error && <p className="self-checkin-error" role="alert"><Icon name="alert" />{error}</p>}
            <button className="button primary" disabled={status === 'busy' || status === 'checking-in' || !EMAIL_PATTERN.test(email.trim())}>{['busy', 'checking-in'].includes(status) ? 'CHECKING YOU IN…' : 'CHECK-IN & FIND MY TABLE'}</button>
          </form>
        </section>
        </div>
        <AwardsFooterArtwork />
      </div>}
      {event && ['code', 'verifying'].includes(status) && <><div className="self-event-heading compact"><h1>Check your email</h1><p>Enter the 6-digit code sent to {email}.</p></div><form className="self-checkin-form" onSubmit={verify}><label><span>Verification code</span><div className="code-input"><input inputMode="numeric" enterKeyHint="done" autoComplete="one-time-code" autoFocus required maxLength="6" pattern="[0-9]{6}" value={code} onChange={(inputEvent) => setCode(inputEvent.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" /></div></label>{error && <p className="self-checkin-error" role="alert"><Icon name="alert" />{error}</p>}<button className="button primary" disabled={status === 'verifying' || code.length !== 6}>{status === 'verifying' ? 'Verifying…' : 'Verify and continue'}</button><button type="button" className="self-text-button" onClick={reset}>Use a different email</button></form></>}
      {event && status === 'ready' && selectedGuest?.checkedIn && <div className={`self-welcome executive-welcome ${selectedGuest.vip ? 'is-vip' : ''}`} aria-live="polite">
        <AwardsBanner />
        <div className="executive-welcome-content">
        <div className="welcome-status-row"><span className="welcome-check"><Icon name="checkCircle" /></span><span className="arrival-status"><strong>You’re Checked In!</strong><small>{checkedInTime ? `Checked in at ${checkedInTime}` : 'Your arrival is confirmed'}</small></span>{selectedGuest.vip && <span className="executive-vip"><Icon name="star" filled /> VIP guest</span>}</div>
        <div className="welcome-intro"><h1>Welcome to {event.name || 'the event'}</h1><div className="executive-identity"><strong>{selectedGuest.name}</strong>{selectedGuest.title && <span>{selectedGuest.title}</span>}{selectedGuest.company && <small>{selectedGuest.company}</small>}</div></div>
        <section className={`self-table-card executive-table-card ${selectedGuest.tableId ? '' : 'unassigned'}`} aria-label="Seating assignment"><div className="table-assignment"><span>{selectedGuest.tableId ? 'Your Assigned Table Number' : 'Your seating'}</span><strong>{selectedGuest.tableId ? assignedTableLabel : 'Welcome desk'}</strong>{!selectedGuest.tableId && <small>Our guest services team will assist you</small>}</div>{!selectedGuest.tableId && <div className="table-guidance"><Icon name="table" /><span><small>Next step</small><strong>Please see our team</strong></span></div>}</section>
        <section className="welcome-itinerary" aria-label="Event details"><h2>Your evening</h2><div className="itinerary-list"><div><Icon name="calendar" /><span><small>Date</small><strong>{event.dateLabel || 'Event day'}</strong></span></div><div><Icon name="clock" /><span><small>Event time</small><strong>{event.startTime ? `${event.startTime}${event.endTime ? ` – ${event.endTime}` : ''}` : 'As shown on your invitation'}</strong></span></div><div><Icon name="location" /><span><small>Venue</small><strong>{event.venue || 'See your invitation'}</strong></span></div><div><Icon name="people" /><span><small>Admission</small><strong>{selectedGuest.ticketName || 'Event guest'}</strong></span></div></div></section>
        <p className="welcome-desk-note"><Icon name="check" /> Thank you for joining us, and we wish you a wonderful evening!</p>
        {guests.length > 1 && <button type="button" className="button secondary wide welcome-another" onClick={() => setSelectedGuestId('')}>Check in another guest on this email</button>}
        </div>
        <AwardsFooterArtwork />
      </div>}
      {event && ['ready', 'checking-in'].includes(status) && (!selectedGuest || !selectedGuest.checkedIn) && <div className="self-match-list"><div className="self-event-heading compact"><h1>{guests.length > 1 ? 'Who is checking in?' : `Hello, ${guests[0]?.name?.split(' ')[0] || 'guest'}`}</h1><p>{guests.length > 1 ? `${guests.length} guests use this email address.` : 'Confirm your arrival to see your welcome details and table.'}</p></div><div>{guests.map((guest) => <article key={guest.id}><div className={`avatar ${guest.vip ? 'vip-avatar' : ''}`}>{initials(guest.name)}</div><span><strong>{guest.name}</strong><small>{guest.company}{guest.title ? ` · ${guest.title}` : ''}</small></span><button className={`button ${guest.checkedIn ? 'secondary' : 'primary'}`} disabled={status === 'checking-in'} onClick={() => checkIn(guest)}>{guest.checkedIn ? 'View details' : status === 'checking-in' ? 'Checking in…' : 'Check in'}</button></article>)}</div>{error && <p className="self-checkin-error" role="alert"><Icon name="alert" />{error}</p>}<button type="button" className="self-text-button" onClick={reset}>Use a different email</button></div>}
    </section>
    {!brandedActive && <footer>{ORG_NAME} · Secure event check-in</footer>}
  </main>;
}

export default function PublicCheckIn() {
  const match = window.location.pathname.match(/^\/self-check-in\/([a-zA-Z0-9-]+)\/?$/);
  if (match) return <SelfCheckInPage workspaceId={match[1]} />;
  if (/^\/self-check-in\/?$/.test(window.location.pathname)) return <SelfCheckInLanding />;
  return <NotFoundPage />;
}
