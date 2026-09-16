import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJSModule from 'exceljs';
import { buildSeatingWorkbookBuffer } from '../src/seating-workbook.js';

const ExcelJS = ExcelJSModule.Workbook ? ExcelJSModule : ExcelJSModule.default;
const tables = [
  { id: 1, number: 1, name: 'ATLAS/ORBIT', capacity: 2, zone: 'Stage' },
  { id: 2, number: 2, name: '', capacity: 4, zone: 'Stage' },
  { id: 3, number: 3, name: 'NORTHWIND', capacity: 4, zone: 'Main' }
];
const details = { name: 'Annual Awards Night', dateLabel: '12 March 2027', startTime: '7:00 PM', venue: 'Grand Harbour Hotel', tableRows: [2, 1] };
const guests = [
  { id: 'a', name: 'Zara Ahmed', company: 'Acme', title: 'CEO', email: 'zara@example.test', tableId: 1, vip: true, checkedIn: true, paymentStatus: 'Paid & confirmed' },
  { id: 'b', name: 'Omar Khan', company: '=HYPERLINK("x")', title: 'CFO', email: 'omar@example.test', tableId: 1 },
  { id: 'c', name: 'Ana Silva', company: 'Beta', tableId: 3 },
  { id: 'd', name: 'Walk In', company: 'Gamma', tableId: null, paymentStatus: 'Manually added' }
];
// A minimal 1x1 transparent PNG, used only to exercise the logo-embedding code path.
const logoBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function load(options) {
  const buffer = await buildSeatingWorkbookBuffer({ tables, guests, details, logoBase64, ...options });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

test('workbook has branded Seating, Tables and Guests A–Z sheets with frozen, filterable headers', async () => {
  const workbook = await load({});
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Seating', 'Tables', 'Guests A–Z']);
  const seating = workbook.getWorksheet('Seating');
  assert.equal(seating.getCell('C1').value, 'Seating plan');
  assert.equal(seating.getCell('C2').value, '12 March 2027 · 7:00 PM  ·  Grand Harbour Hotel', 'the emblem already names the event');
  const plain = new ExcelJS.Workbook();
  await plain.xlsx.load(await buildSeatingWorkbookBuffer({ tables, guests, details }));
  assert.match(plain.getWorksheet('Seating').getCell('A2').value, /^Annual Awards Night +· +12 March 2027/, 'without the emblem the event name is written out');
  assert.equal(seating.getCell('A1').fill.fgColor.argb, 'FF153D2C', 'green banner');
  assert.equal(seating.getCell('A4').fill.fgColor.argb, 'FFC9A352', 'gold rule');
  assert.match(seating.getCell('A5').value, /3 tables {2}· {2}3 of 10 seats filled {2}· {2}1 VIP {2}· {2}1 unseated/);
  assert.equal(seating.getImages().length, 1, 'emblem placed in the banner');
  assert.equal(seating.views[0].state, 'frozen');
  assert.equal(seating.views[0].ySplit, 7);
  assert.equal(seating.views[0].showGridLines, false);
  assert.ok(seating.autoFilter, 'header row is filterable');
  const header = seating.getRow(7).values.slice(1);
  assert.deepEqual(header, ['Table', 'Table name (admin)', 'Area', 'Row', 'Seat', 'Guest name', 'Company', 'Job title', 'VIP', 'Membership', 'Booking type', 'Checked in']);
  assert.equal(seating.getCell('A7').fill.fgColor.argb, 'FF153D2C');
  assert.equal(seating.pageSetup.orientation, 'landscape');
  assert.equal(seating.pageSetup.printTitlesRow, '7:7');
});

test('seating rows follow room order with VIP, arrival and unseated styling and literal text', async () => {
  const seating = (await load({})).getWorksheet('Seating');
  const rows = [8, 9, 10, 11].map((n) => seating.getRow(n).values.slice(1));
  assert.deepEqual(rows.map((row) => [row[0], row[1], row[4], row[5]]), [[1, 'ATLAS/ORBIT', 1, 'Zara Ahmed'], [1, 'ATLAS/ORBIT', 2, 'Omar Khan'], [3, 'NORTHWIND', 1, 'Ana Silva'], ['Unseated', '', '', 'Walk In']]);
  assert.equal(seating.getCell('G9').value, '=HYPERLINK("x")', 'formula-like company stays plain text');
  assert.equal(seating.getCell('G9').type, ExcelJS.ValueType.String);
  assert.equal(seating.getCell('I8').fill.fgColor.argb, 'FFF3E6C4', 'VIP highlighted gold');
  assert.equal(seating.getCell('L8').value, '✓ Yes');
  assert.equal(seating.getCell('A11').fill.fgColor.argb, 'FFFFF4E0', 'unseated guest tinted');
});

test('tables sheet calculates open seats, fill rate and totals with live formulas', async () => {
  const sheet = (await load({})).getWorksheet('Tables');
  assert.deepEqual(sheet.getRow(7).values.slice(1), ['Table', 'Table name (admin)', 'Area', 'Row', 'Seats', 'Seated', 'Open seats', 'VIP', 'Fill', 'Status']);
  assert.equal(sheet.getCell('G8').value.formula, 'E8-F8');
  assert.deepEqual(sheet.getCell('G9').value, { formula: 'E9-F9', result: 4 });
  assert.equal(sheet.getCell('J8').value, 'Full');
  assert.equal(sheet.getCell('A8').fill.fgColor.argb, 'FFE8F2EC', 'full table tinted');
  assert.equal(sheet.getCell('I8').numFmt, '0%');
  assert.deepEqual(sheet.getCell('E11').value, { formula: 'SUM(E8:E10)', result: 10 });
  assert.deepEqual(sheet.getCell('F11').value, { formula: 'SUM(F8:F10)', result: 3 });
  assert.equal(sheet.getCell('A11').value, 'Total');
});

test('guest list is alphabetical and privacy options drop admin names and emails', async () => {
  const workbook = await load({ includeLabels: false, includeEmail: false });
  const az = workbook.getWorksheet('Guests A–Z');
  assert.deepEqual([8, 9, 10, 11].map((n) => [az.getCell(`A${n}`).value, az.getCell(`C${n}`).value]), [['Ana Silva', 'Table 3'], ['Omar Khan', 'Table 1'], ['Walk In', 'Unseated'], ['Zara Ahmed', 'Table 1']]);
  assert.equal(az.getCell('C8').fill.fgColor.argb, 'FF153D2C');
  const seatingHeader = workbook.getWorksheet('Seating').getRow(7).values.slice(1);
  assert.ok(!seatingHeader.includes('Table name (admin)') && !seatingHeader.includes('Email'));
  const everything = JSON.stringify(workbook.worksheets.map((sheet) => sheet.getSheetValues()));
  assert.ok(!everything.includes('ATLAS/ORBIT') && !everything.includes('@example.test'));
  const withEmail = await load({ includeEmail: true });
  assert.ok(withEmail.getWorksheet('Seating').getRow(7).values.includes('Email'));
});
