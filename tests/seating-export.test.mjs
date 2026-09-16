import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFloorPlanSvg, buildPrintDocument, buildRoomModel, buildSeatingCsv } from '../src/seating-export.js';

const tables = [
  { id: 1, number: 1, name: 'ATLAS/ORBIT', capacity: 4, zone: 'Stage' },
  { id: 2, number: 2, name: '', capacity: 4, zone: 'Stage' },
  { id: 47, number: 47, name: 'Late <Sponsor>', capacity: 4, zone: 'Main' },
  { id: 3, number: 3, name: 'NORTHWIND', capacity: 4, zone: 'Main' }
];
const details = { name: 'Awards & Gala', dateLabel: '12 March 2027', venue: 'Grand Harbour Hotel', tableRows: [3, 1] };
const guests = [
  { id: 'a', name: 'Zara Ahmed', company: 'Acme', title: 'CEO', email: 'zara@example.test', tableId: 1, vip: true, paymentStatus: 'Paid & confirmed', checkedIn: true },
  { id: 'b', name: 'Omar "The" Khan', company: '=HYPERLINK("x")', title: 'CFO', email: 'omar@example.test', tableId: 1, paymentStatus: 'Complimentary & confirmed' },
  { id: 'c', name: 'Ana <script>', company: 'Beta', title: '', email: '', tableId: 47 },
  { id: 'd', name: 'Walk In', company: 'Gamma', title: '', email: 'walk@example.test', tableId: null, paymentStatus: 'Manually added' }
];

test('room model follows rows in room order and filters by area', () => {
  const model = buildRoomModel({ tables, guests, details });
  assert.deepEqual(model.rows.map((row) => row.tables.map((item) => item.number)), [[1, 2, 47], [3]]);
  assert.equal(model.seatedCount, 3);
  assert.equal(model.capacity, 16);
  assert.deepEqual(model.unseated.map((guest) => guest.id), ['d']);
  const main = buildRoomModel({ tables, guests, details, zone: 'Main' });
  assert.deepEqual(main.rows.map((row) => row.tables.map((item) => item.number)), [[47], [3]]);
  assert.equal(main.unseated.length, 0, 'area exports leave out unseated guests');
});

test('CSV lists seats in room order, neutralises formulas and can omit admin names and emails', () => {
  const csv = buildSeatingCsv({ tables, guests, details });
  assert.ok(csv.startsWith('﻿"Table number","Table name (admin)","Area","Row","Seat","Guest name"'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 5);
  assert.ok(lines[1].startsWith('"1","ATLAS/ORBIT","Stage","1","1","Zara Ahmed"'));
  assert.ok(lines[2].includes('"Omar ""The"" Khan"'));
  assert.ok(lines[2].includes(`"'=HYPERLINK(""x"")"`), 'formula-like cells are prefixed');
  assert.ok(lines[3].startsWith('"47","Late <Sponsor>","Main","1","1","Ana <script>"'));
  assert.ok(lines[4].startsWith('"Unseated","","","","","Walk In"'));
  const guestFacing = buildSeatingCsv({ tables, guests, details, includeLabels: false, includeEmail: false });
  assert.ok(!guestFacing.includes('ATLAS/ORBIT') && !guestFacing.includes('Table name') && !guestFacing.includes('@example.test'));
});

test('floor plan SVG shows every table number, escapes labels and hides them on request', () => {
  const { svg } = buildFloorPlanSvg({ tables, guests, details });
  for (const number of [1, 2, 3, 47]) assert.ok(svg.includes(`>${number}</text>`), `table ${number} drawn`);
  assert.ok(svg.includes('ROW 1') && svg.includes('ROW 2') && svg.includes('MAIN STAGE'));
  assert.ok(svg.includes('Late &lt;Sponsor&gt;') && !svg.includes('<Sponsor>'));
  assert.ok(svg.includes('>2/4</text>'), 'occupancy for table 1');
  const hidden = buildFloorPlanSvg({ tables, guests, details, showLabels: false }).svg;
  assert.ok(!hidden.includes('ATLAS/ORBIT') && !hidden.includes('NORTHWIND'));
});

test('print document includes the chosen sections, escapes guest data and respects privacy options', () => {
  const html = buildPrintDocument({ tables, guests, details, paper: 'A3', sections: { floor: true, tables: true, guests: true } });
  assert.ok(html.includes('<title>Awards &amp; Gala - Floor plan, Seating by table, Guest list</title>'));
  assert.ok(html.includes('size: A3 landscape'));
  assert.ok(html.includes('Ana &lt;script&gt;') && !html.includes('<script>'));
  assert.ok(html.includes('Unseated guests (1)'));
  assert.ok(!html.includes('zara@example.test'), 'emails are excluded by default');
  const azOrder = ['Ana &lt;script&gt;', 'Omar &quot;The&quot; Khan', 'Walk In', 'Zara Ahmed'].map((name) => html.lastIndexOf(name));
  assert.deepEqual([...azOrder].sort((a, b) => a - b), azOrder, 'guest list is alphabetical');
  const doorList = buildPrintDocument({ tables, guests, details, sections: { floor: false, tables: false, guests: true }, showLabels: false, includeCompany: false });
  assert.ok(!doorList.includes('Floor plan') && !doorList.includes('ATLAS/ORBIT') && !doorList.includes('Acme'));
  assert.ok(doorList.includes('<b class="pill">Table 1</b>'));
  assert.ok(doorList.includes('<b class="pill none">Unseated</b>'));
  assert.ok(!doorList.includes('class="cover"'), 'no cover unless requested');
});

test('branded pack adds a cover with key figures and uses the neutral mark and palette', () => {
  const html = buildPrintDocument({ tables, guests, details, sections: { floor: true, tables: true, guests: false }, cover: true });
  assert.ok(html.includes('<section class="cover">'));
  assert.ok(html.includes('src="/brand/logo-white.svg"'), 'the neutral logo mark is used');
  assert.ok(html.includes('<span class="band-eyebrow">Awards &amp; Gala</span>'), 'the banner names the event');
  const otherEvent = buildPrintDocument({ tables, guests, details: { ...details, name: 'Annual Forum' }, sections: { floor: true, tables: false, guests: false }, cover: true });
  assert.ok(otherEvent.includes('src="/brand/logo-white.svg"'));
  assert.ok(otherEvent.includes('<span class="band-eyebrow">Annual Forum</span>'));
  assert.ok(html.includes('<dt>Tables</dt><dd>4</dd>') && html.includes('<dt>Guests seated</dt><dd>3</dd>'));
  assert.ok(html.includes('<b>01</b>Floor plan') && html.includes('<b>02</b>Seating by table') && !html.includes('Guest list A–Z</span>'));
  assert.ok(html.includes('#153d2c') && html.includes("url('/fonts/manrope-latin.woff2')"));
  const { svg } = buildFloorPlanSvg({ tables, guests, details });
  assert.ok(svg.includes('fill="#153d2c"') && svg.includes('url(#seating-gold)'), 'floor plan uses the event green and gold');
});
