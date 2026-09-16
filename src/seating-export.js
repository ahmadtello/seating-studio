import { normalizeTableRows, partitionTables } from './table-layout.js';
import { membershipLabel } from './seating-config.js';
import { tableLabel, tableNumber, tableTitle } from '../shared/table-labels.js';

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const BOOKING_TYPES = { 'Paid & confirmed': 'Paid', 'Complimentary & confirmed': 'Complimentary', 'Manually added': 'Manually added' };
const truncate = (value, length) => { const text = String(value ?? ''); return text.length > length ? `${text.slice(0, length - 1)}…` : text; };

// Event colour palette, matching the guest self check-in.
const BRAND = { green: '#153d2c', greenDeep: '#0f2c20', greenSeat: '#1e5a3d', gold: '#c9a352', goldDark: '#8a6a2c', goldLight: '#e3c98f', cream: '#fffdf8', line: '#dcd3bb', ink: '#17251d', muted: '#6b776f' };
const ORG_NAME = import.meta.env?.VITE_ORGANIZATION_NAME || 'Seating Studio';

// Tables grouped into physical rows (stage first), each guest with a seat number, optionally limited to one area.
export function buildRoomModel({ tables, guests, details = {}, zone = '' }) {
  const rowSizes = normalizeTableRows(details.tableRows, tables.length, details.tablesPerRow || 5);
  const rows = partitionTables(tables, rowSizes).map((rowTables, index) => ({
    row: index + 1,
    tables: rowTables.filter((table) => !zone || table.zone === zone).map((table) => {
      const seated = guests.filter((guest) => guest.tableId === table.id);
      return { table, row: index + 1, number: tableNumber(table), title: tableTitle(table), label: tableLabel(table), seated };
    })
  })).filter((row) => row.tables.length);
  const byTable = new Map(rows.flatMap((row) => row.tables).map((item) => [item.table.id, item]));
  const unseated = zone ? [] : guests.filter((guest) => !guest.tableId || !tables.some((table) => table.id === guest.tableId));
  const seatedCount = rows.reduce((sum, row) => sum + row.tables.reduce((inner, item) => inner + item.seated.length, 0), 0);
  const capacity = rows.reduce((sum, row) => sum + row.tables.reduce((inner, item) => inner + item.table.capacity, 0), 0);
  const vipCount = rows.reduce((sum, row) => sum + row.tables.reduce((inner, item) => inner + item.seated.filter((guest) => guest.vip).length, 0), 0);
  return { rows, byTable, unseated, tableCount: byTable.size, seatedCount, capacity, vipCount };
}

const csvCell = (value) => {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};

export function buildSeatingCsv({ tables, guests, details = {}, zone = '', includeLabels = true, includeEmail = true }) {
  const model = buildRoomModel({ tables, guests, details, zone });
  const header = ['Table number', ...(includeLabels ? ['Table name (admin)'] : []), 'Area', 'Row', 'Seat', 'Guest name', 'Company', 'Job title', ...(includeEmail ? ['Email'] : []), 'VIP', 'Membership', 'Booking type', 'Checked in'];
  const line = (guest, item, seat) => [
    item ? item.number : 'Unseated', ...(includeLabels ? [item ? item.label : ''] : []), item ? item.table.zone : '', item ? item.row : '', seat || '',
    guest.name, guest.company, guest.title, ...(includeEmail ? [guest.email] : []), guest.vip ? 'Yes' : 'No', membershipLabel(guest),
    BOOKING_TYPES[guest.paymentStatus] || guest.paymentStatus || '', guest.checkedIn ? 'Yes' : 'No'
  ];
  const body = [
    ...model.rows.flatMap((row) => row.tables.flatMap((item) => item.seated.map((guest, index) => line(guest, item, index + 1)))),
    ...model.unseated.map((guest) => line(guest, null, 0))
  ];
  return `﻿${[header, ...body].map((cells) => cells.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// Vector floor plan in event colours: stage at the top, rows in order, one table per circle with seat dots.
export function buildFloorPlanSvg({ tables, guests, details = {}, zone = '', showLabels = true }) {
  const model = buildRoomModel({ tables, guests, details, zone });
  const cell = 158, rowHeight = showLabels ? 188 : 172, marginX = 104, top = 132, radius = 44, seatRadius = 7, seatRing = 62;
  const widest = Math.max(1, ...model.rows.map((row) => row.tables.length));
  const width = marginX * 2 + widest * cell;
  const height = top + model.rows.length * rowHeight + 78;
  const parts = [];
  parts.push(`<defs><linearGradient id="seating-gold" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${BRAND.goldDark}"/><stop offset=".45" stop-color="#ead49d"/><stop offset=".72" stop-color="${BRAND.gold}"/><stop offset="1" stop-color="#f1e2b6"/></linearGradient></defs>`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
  const stageWidth = Math.min(width - marginX * 2, 640);
  const stageX = (width - stageWidth) / 2;
  parts.push(`<rect x="${stageX}" y="28" width="${stageWidth}" height="52" rx="26" fill="${BRAND.green}"/>`);
  parts.push(`<rect x="${stageX + 26}" y="75" width="${stageWidth - 52}" height="3" rx="1.5" fill="url(#seating-gold)"/>`);
  parts.push(`<text x="${width / 2}" y="60" text-anchor="middle" font-size="16" font-weight="800" letter-spacing="6" fill="${BRAND.goldLight}">MAIN STAGE</text>`);
  model.rows.forEach((row, rowIndex) => {
    const y = top + rowIndex * rowHeight + radius + 24;
    const rowWidth = row.tables.length * cell;
    const startX = (width - rowWidth) / 2 + cell / 2;
    parts.push(`<text x="${Math.max(14, startX - cell / 2 - 20)}" y="${y + 5}" text-anchor="end" font-size="13" font-weight="800" letter-spacing="2" fill="${BRAND.goldDark}">ROW ${row.row}</text>`);
    row.tables.forEach((item, index) => {
      const x = startX + index * cell;
      const occupied = item.seated.length;
      const full = occupied >= item.table.capacity;
      parts.push(`<g><title>${escapeHtml(`${item.title}${showLabels && item.label ? ` · ${item.label}` : ''} · ${occupied}/${item.table.capacity}`)}</title>`);
      for (let seat = 0; seat < item.table.capacity; seat += 1) {
        const angle = (seat / item.table.capacity) * Math.PI * 2 - Math.PI / 2;
        const guest = item.seated[seat];
        const fill = guest ? (guest.vip ? BRAND.gold : BRAND.greenSeat) : '#ffffff';
        const stroke = guest ? (guest.vip ? BRAND.goldDark : BRAND.greenSeat) : '#cdbf99';
        parts.push(`<circle cx="${(x + Math.cos(angle) * seatRing).toFixed(1)}" cy="${(y + Math.sin(angle) * seatRing).toFixed(1)}" r="${seatRadius}" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>`);
      }
      parts.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="${full ? '#eef4ef' : BRAND.cream}" stroke="${full ? BRAND.green : BRAND.gold}" stroke-width="${full ? 2.6 : 1.8}"/>`);
      parts.push(`<text x="${x}" y="${y + 9}" text-anchor="middle" font-size="28" font-weight="800" fill="${BRAND.green}">${escapeHtml(item.number)}</text>`);
      parts.push(`<text x="${x}" y="${y + 27}" text-anchor="middle" font-size="11" font-weight="700" fill="${BRAND.goldDark}">${occupied}/${item.table.capacity}</text>`);
      if (showLabels && item.label) parts.push(`<text x="${x}" y="${y + seatRing + 27}" text-anchor="middle" font-size="12" font-weight="700" fill="${BRAND.goldDark}">${escapeHtml(truncate(item.label, 20))}</text>`);
      parts.push('</g>');
    });
  });
  const legendY = height - 32;
  parts.push(`<rect x="${marginX}" y="${legendY - 26}" width="${width - marginX * 2}" height="1" fill="url(#seating-gold)"/>`);
  parts.push(`<circle cx="${marginX + 8}" cy="${legendY}" r="7" fill="${BRAND.greenSeat}"/><text x="${marginX + 22}" y="${legendY + 5}" font-size="13" fill="${BRAND.muted}">Seated guest</text>`);
  parts.push(`<circle cx="${marginX + 140}" cy="${legendY}" r="7" fill="${BRAND.gold}" stroke="${BRAND.goldDark}" stroke-width="1.4"/><text x="${marginX + 154}" y="${legendY + 5}" font-size="13" fill="${BRAND.muted}">VIP</text>`);
  parts.push(`<circle cx="${marginX + 212}" cy="${legendY}" r="7" fill="#ffffff" stroke="#cdbf99" stroke-width="1.4"/><text x="${marginX + 226}" y="${legendY + 5}" font-size="13" fill="${BRAND.muted}">Open seat</text>`);
  parts.push(`<circle cx="${marginX + 330}" cy="${legendY}" r="9" fill="#eef4ef" stroke="${BRAND.green}" stroke-width="2.6"/><text x="${marginX + 346}" y="${legendY + 5}" font-size="13" fill="${BRAND.muted}">Full table</text>`);
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Manrope, 'Segoe UI', Arial, sans-serif">${parts.join('')}</svg>`, width, height, model };
}

const PRINT_CSS = (paper) => `
  @font-face { font-family: 'Manrope'; font-weight: 400 800; src: url('/fonts/manrope-latin.woff2') format('woff2'); }
  @page { size: ${paper} portrait; margin: 11mm; }
  @page floor { size: ${paper} landscape; margin: 9mm; }
  @page cover { size: ${paper} portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; }
  body { font-family: Manrope, 'Segoe UI', Arial, sans-serif; color: ${BRAND.ink}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  section { break-after: page; }
  section:last-of-type { break-after: auto; }
  section.floor { page: floor; }
  .gold-rule { height: 3px; border-radius: 2px; background: linear-gradient(90deg, ${BRAND.goldDark}, #ead49d 45%, ${BRAND.gold} 72%, #f1e2b6); }

  /* Cover page, echoing the green event panel of the guest check-in */
  section.cover { page: cover; position: relative; min-height: 100vh; padding: 26mm 22mm 20mm; background: ${BRAND.green}; color: #fff; display: flex; flex-direction: column; overflow: hidden; }
  section.cover::before { content: ''; position: absolute; width: 150mm; height: 150mm; right: -78mm; bottom: -64mm; border: 1px solid rgba(225, 191, 129, .28); border-radius: 50%; box-shadow: 0 0 0 20mm rgba(255,255,255,.025), 0 0 0 40mm rgba(255,255,255,.018); }
  section.cover > * { position: relative; }
  .cover-mark { width: 62mm; height: auto; }
  .cover-eyebrow { margin-top: 12mm; color: ${BRAND.goldLight}; font-size: 11pt; font-weight: 700; letter-spacing: .22em; text-transform: uppercase; }
  .cover h1 { margin: 5mm 0 0; font-size: 40pt; line-height: 1; font-weight: 700; letter-spacing: -.03em; }
  .cover-sub { margin: 6mm 0 0; color: #c6d8cd; font-size: 12pt; line-height: 1.6; max-width: 130mm; }
  .cover .gold-rule { margin: 12mm 0 10mm; width: 70mm; }
  .cover-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7mm 10mm; max-width: 140mm; margin: 0; }
  .cover-facts dt { color: #a9c0b2; font-size: 8.5pt; letter-spacing: .1em; text-transform: uppercase; }
  .cover-facts dd { margin: 1.5mm 0 0; font-size: 20pt; font-weight: 800; color: #fff; }
  .cover-contents { margin-top: auto; padding-top: 8mm; border-top: 1px solid rgba(255,255,255,.18); display: flex; flex-wrap: wrap; gap: 3mm 8mm; color: #dce9e1; font-size: 10pt; }
  .cover-contents b { color: ${BRAND.goldLight}; font-weight: 800; margin-right: 1.5mm; }
  .cover-foot { margin-top: 6mm; color: #93aa9c; font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; }

  /* Section banner */
  .band { display: flex; justify-content: space-between; align-items: center; gap: 8mm; padding: 4mm 6mm; border-radius: 3.5mm 3.5mm 0 0; background: ${BRAND.green}; color: #fff; }
  .band-brand { display: flex; align-items: center; gap: 4mm; min-width: 0; }
  .band-mark { height: 11mm; width: auto; flex: none; }
  .band-mark.logo { height: 13mm; }
  .band-copy { padding-left: 4mm; border-left: 1px solid rgba(227, 201, 143, .35); }
  .cover-mark.logo { width: 30mm; }
  .band-eyebrow { display: block; color: ${BRAND.goldLight}; font-size: 7.5pt; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; }
  .band h1 { margin: .8mm 0 0; font-size: 17pt; line-height: 1.05; font-weight: 700; letter-spacing: -.02em; }
  .band-meta { text-align: right; font-size: 8pt; line-height: 1.55; color: #c6d8cd; white-space: nowrap; }
  .band-meta strong { color: #fff; }
  .band + .gold-rule { border-radius: 0 0 2px 2px; margin-bottom: 5mm; }
  .stats { display: flex; flex-wrap: wrap; gap: 2.5mm; margin: 0 0 5mm; }
  .stats span { padding: 1.4mm 3.2mm; border: 1px solid ${BRAND.line}; border-radius: 99px; background: ${BRAND.cream}; font-size: 8pt; color: #4f5c54; }
  .stats b { color: ${BRAND.green}; font-weight: 800; }

  section.floor .plan { padding: 3mm; border: 1px solid ${BRAND.line}; border-radius: 3mm; background: #fff; }
  section.floor svg { width: 100%; height: auto; max-height: 150mm; display: block; }

  h2 { font-size: 12pt; margin: 6mm 0 3mm; color: ${BRAND.green}; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; }
  .card { border: 1px solid ${BRAND.line}; border-radius: 2.8mm; overflow: hidden; background: ${BRAND.cream}; break-inside: avoid; }
  .card header { display: flex; justify-content: space-between; align-items: center; gap: 2mm; padding: 2mm 3mm; background: ${BRAND.green}; color: #fff; border-bottom: 2px solid ${BRAND.gold}; }
  .card strong.number { font-size: 12.5pt; font-weight: 800; letter-spacing: -.01em; }
  .card .label { display: block; color: ${BRAND.goldLight}; font-size: 7pt; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
  .card .meta { color: #b9cdc1; font-size: 7.5pt; white-space: nowrap; text-align: right; }
  .card ol { margin: 0; padding: 2mm 3mm 2.4mm 7mm; font-size: 8.6pt; line-height: 1.5; }
  .card li::marker { color: ${BRAND.goldDark}; font-weight: 800; }
  .card li small { color: ${BRAND.muted}; }
  .card .empty { color: #8f998f; font-size: 8pt; margin: 0; padding: 2.4mm 3mm; font-style: italic; }
  .vip { display: inline-block; margin-left: 1.2mm; padding: 0 1.4mm; border-radius: 1mm; background: linear-gradient(90deg, #e9d39a, ${BRAND.gold}); color: ${BRAND.greenDeep}; font-size: 6.5pt; font-weight: 800; letter-spacing: .04em; vertical-align: 1px; }
  .arrived { color: ${BRAND.greenSeat}; font-size: 8pt; font-weight: 800; }

  .az { columns: 2; column-gap: 8mm; font-size: 9pt; }
  .az h3 { margin: 3.5mm 0 1.2mm; padding-bottom: .8mm; border-bottom: 1px solid #e2d3a8; font-size: 11pt; font-weight: 800; color: ${BRAND.goldDark}; letter-spacing: .06em; break-after: avoid; }
  .az .entry { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 3mm; padding: 1.2mm 1mm; border-bottom: 1px solid #efe9da; break-inside: avoid; }
  .az .entry small { display: block; color: ${BRAND.muted}; font-size: 7.5pt; }
  .pill { display: inline-block; min-width: 17mm; padding: .6mm 2.6mm; border-radius: 99px; background: ${BRAND.green}; color: #fff; font-size: 8.5pt; font-weight: 800; text-align: center; white-space: nowrap; }
  .pill.none { background: #efe9da; color: #8a7a55; }
  .doc-foot { margin-top: 6mm; display: flex; justify-content: space-between; color: #8a958e; font-size: 7pt; letter-spacing: .06em; text-transform: uppercase; }
`;

export function buildPrintDocument({ tables, guests, details = {}, zone = '', paper = 'A4', sections = { floor: true, tables: true, guests: true }, showLabels = true, includeCompany = true, includeEmail = false, cover = false }) {
  const event = details.name || 'Event';
  const { svg, model } = buildFloorPlanSvg({ tables, guests, details, zone, showLabels });
  const generated = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const area = zone ? `Area: ${zone}` : 'Entire room';
  const eventLine = [details.dateLabel, details.startTime].filter(Boolean).join(' · ');
  const markSrc = '/brand/logo-white.svg';
  const mark = `<img class="band-mark logo" src="${markSrc}" alt="">`;
  const kicker = event;
  const stats = `<div class="stats"><span>${escapeHtml(area)}</span><span><b>${model.tableCount}</b> tables</span><span><b>${model.seatedCount}</b> of ${model.capacity} seats filled</span>${model.vipCount ? `<span><b>${model.vipCount}</b> VIP</span>` : ''}${model.unseated.length ? `<span><b>${model.unseated.length}</b> unseated</span>` : ''}</div>`;
  const band = (title) => `<header class="band"><div class="band-brand">${mark}<div class="band-copy"><span class="band-eyebrow">${escapeHtml(kicker)}</span><h1>${escapeHtml(title)}</h1></div></div><div class="band-meta">${eventLine ? `<strong>${escapeHtml(eventLine)}</strong><br>` : ''}${details.venue ? `${escapeHtml(details.venue)}<br>` : ''}Generated ${escapeHtml(generated)}</div></header><div class="gold-rule"></div>`;
  const foot = `<div class="doc-foot"><span>${escapeHtml(ORG_NAME)}</span><span>For event staff · ${escapeHtml(generated)}</span></div>`;
  const guestLine = (guest) => `${escapeHtml(guest.name)}${guest.vip ? '<span class="vip">VIP</span>' : ''}${guest.checkedIn ? ' <span class="arrived">✓</span>' : ''}${includeCompany && guest.company ? ` <small>· ${escapeHtml(guest.company)}</small>` : ''}${includeEmail && guest.email ? ` <small>· ${escapeHtml(guest.email)}</small>` : ''}`;
  const contents = [sections.floor && 'Floor plan', sections.tables && 'Seating by table', sections.guests && 'Guest list A–Z'].filter(Boolean);
  const parts = [];
  if (cover && contents.length) {
    parts.push(`<section class="cover"><img class="cover-mark logo" src="${markSrc}" alt=""><div class="cover-eyebrow">${escapeHtml(event)}</div><h1>Seating plan</h1><p class="cover-sub">${escapeHtml([eventLine, details.venue].filter(Boolean).join(' · ') || 'Event seating overview')}</p><div class="gold-rule"></div><dl class="cover-facts"><div><dt>Tables</dt><dd>${model.tableCount}</dd></div><div><dt>Guests seated</dt><dd>${model.seatedCount}</dd></div><div><dt>Seats</dt><dd>${model.capacity}</dd></div><div><dt>${zone ? 'Area' : 'Unseated'}</dt><dd>${zone ? escapeHtml(zone) : model.unseated.length}</dd></div></dl><div class="cover-contents">${contents.map((item, index) => `<span><b>${String(index + 1).padStart(2, '0')}</b>${escapeHtml(item)}</span>`).join('')}</div><div class="cover-foot">Prepared ${escapeHtml(generated)} · Confidential, for event staff</div></section>`);
  }
  if (sections.floor) parts.push(`<section class="floor">${band('Floor plan')}${stats}<div class="plan">${svg}</div></section>`);
  if (sections.tables) {
    const cards = model.rows.flatMap((row) => row.tables).map((item) => `<article class="card"><header><div><strong class="number">${escapeHtml(item.title)}</strong>${showLabels && item.label ? `<span class="label">${escapeHtml(item.label)}</span>` : ''}</div><span class="meta">Row ${item.row} · ${escapeHtml(item.table.zone)}<br>${item.seated.length}/${item.table.capacity} seated</span></header>${item.seated.length ? `<ol>${item.seated.map((guest) => `<li>${guestLine(guest)}</li>`).join('')}</ol>` : '<p class="empty">No guests seated</p>'}</article>`).join('');
    const unseated = model.unseated.length ? `<h2>Unseated guests (${model.unseated.length})</h2><div class="cards"><article class="card"><ol>${model.unseated.map((guest) => `<li>${guestLine(guest)}</li>`).join('')}</ol></article></div>` : '';
    parts.push(`<section>${band('Seating by table')}${stats}<div class="cards">${cards}</div>${unseated}${foot}</section>`);
  }
  if (sections.guests) {
    const listed = [...model.rows.flatMap((row) => row.tables.flatMap((item) => item.seated.map((guest) => ({ guest, item })))), ...model.unseated.map((guest) => ({ guest, item: null }))]
      .sort((a, b) => a.guest.name.localeCompare(b.guest.name, 'en', { sensitivity: 'base' }));
    let letter = '';
    const entries = listed.map(({ guest, item }) => {
      const initial = (guest.name.trim()[0] || '#').toUpperCase();
      const heading = initial !== letter ? `<h3>${escapeHtml(initial)}</h3>` : '';
      letter = initial;
      const detail = [includeCompany ? guest.company : '', includeEmail ? guest.email : ''].filter(Boolean).join(' · ');
      return `${heading}<div class="entry"><span>${escapeHtml(guest.name)}${guest.vip ? '<span class="vip">VIP</span>' : ''}${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span>${item ? `<b class="pill">${escapeHtml(item.title)}</b>` : '<b class="pill none">Unseated</b>'}</div>`;
    }).join('');
    parts.push(`<section>${band('Guest list A–Z')}${stats}<div class="az">${entries}</div>${foot}</section>`);
  }
  const title = `${event} - ${contents.join(', ').replace('Guest list A–Z', 'Guest list')}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_CSS(paper)}</style></head><body>${parts.join('')}</body></html>`;
}
