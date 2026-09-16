import test from 'node:test';
import assert from 'node:assert/strict';
import { applySeatingConfig, mergeConfirmedGuests, membershipLabel } from '../src/seating-config.js';
import { buildBalancedRows, buildUniformRows, fitTableRows, normalizeTableRows, partitionTables, validateTableRows } from '../src/table-layout.js';
const tables = [{ id: 1, name: 'One', capacity: 10, zone: 'Stage' }, { id: 2, name: 'Two', capacity: 12, zone: 'Main' }];
const details = { defaultSeats: 10, tablesPerRow: 5 };
test('Default size updates standard tables, protects custom tables, and persists the override', () => {
  const result = applySeatingConfig(tables, [], details, { defaultSeats: 8 });
  assert.deepEqual(result.tables.map(t => [t.capacity, t.capacityOverride]), [[8, false], [12, true]]);
  const again = applySeatingConfig(result.tables, [], result.details, { defaultSeats: 12 });
  assert.equal(again.tables[1].capacityOverride, true);
});
test('All-table and new-only scopes behave distinctly', () => {
  assert.deepEqual(applySeatingConfig(tables, [], details, { defaultSeats: 8 }, 'all').tables.map(t => t.capacity), [8, 8]);
  const result = applySeatingConfig(tables, [], details, { defaultSeats: 8, tableCount: 3 }, 'new');
  assert.deepEqual(result.tables.map(t => t.capacity), [10, 12, 8]);
  assert.equal(result.tables[2].capacityOverride, false);
});
test('Occupied seats and tables cannot be removed accidentally', () => {
  const guests = Array.from({ length: 9 }, (_, i) => ({ id: String(i), tableId: 1 }));
  assert.throws(() => applySeatingConfig(tables, guests, details, { defaultSeats: 8 }, 'all'), /more than 8 guests/);
  assert.throws(() => applySeatingConfig(tables, [{ tableId: 2 }], details, { tableCount: 1 }), /Unseat guests/);
  assert.equal(applySeatingConfig(tables, [], details, { tableCount: 1 }).tables.length, 1);
});
test('Zones and row settings are applied, and invalid input is rejected', () => {
  const result = applySeatingConfig(tables, [], details, { zones: ['VIP', 'Main', 'Balcony'], tableZones: { 1: 'VIP' }, tablesPerRow: 3 });
  assert.equal(result.tables[0].zone, 'VIP');
  assert.equal(result.details.tablesPerRow, 3);
  assert.deepEqual(result.details.tableRows, [2]);
  assert.deepEqual(result.details.zones, ['VIP', 'Main', 'Balcony']);
  for (const changes of [{ tableCount: 1.5 }, { defaultSeats: 3 }, { tablesPerRow: 0 }, { tableRows: [1] }, { tableRows: [0, 2] }, { tableRows: [21] }, { zones: [] }, { zones: ['Missing'] }]) assert.throws(() => applySeatingConfig(tables, [], details, changes));
});
test('Custom row layouts persist and divide tables in stage-to-back order', () => {
  const roomTables = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, name: `Table ${index + 1}`, capacity: 10, zone: 'Main' }));
  const rows = [10, 11, 12, 7];
  const result = applySeatingConfig(roomTables, [], { ...details, zones: ['Main'] }, { tableRows: rows });
  assert.deepEqual(result.details.tableRows, rows);
  assert.equal(result.details.tablesPerRow, 12);
  assert.deepEqual(partitionTables(result.tables, rows).map((row) => row.length), rows);
  assert.deepEqual(partitionTables(result.tables, rows).map((row) => row[0].id), [1, 11, 22, 34]);
});
test('Row helpers migrate uniform layouts and preserve totals when table count changes', () => {
  assert.deepEqual(buildUniformRows(40, 10), [10, 10, 10, 10]);
  assert.deepEqual(buildBalancedRows(40, 4), [10, 10, 10, 10]);
  assert.deepEqual(buildBalancedRows(5, 4), [2, 1, 1, 1]);
  assert.deepEqual(normalizeTableRows(undefined, 23, 10), [10, 10, 3]);
  assert.deepEqual(fitTableRows([10, 11, 12, 7], 41, 10), [10, 11, 12, 8]);
  assert.deepEqual(fitTableRows([10, 11, 12, 7], 35, 10), [10, 11, 12, 2]);
  assert.deepEqual(validateTableRows([10, 11, 12, 7], 40), [10, 11, 12, 7]);
  assert.throws(() => validateTableRows([10, 11, 12, 8], 40), /contain 41 tables/);
});
test('MEC sync keeps manual state and distinguishes bookings sharing an email', () => {
  const existing = { id: 'one', bookingId: '1', attendeeKey: '0', email: 'shared@example.test', vip: true, checkedIn: true, tableId: 2, checkInHistory: [{ at: 'test' }] };
  const result = mergeConfirmedGuests([existing], [{ ...existing, id: 'new-id', vip: false, checkedIn: false, tableId: null }, { ...existing, id: 'two', bookingId: '2' }]);
  assert.equal(result.guests.length, 2);
  assert.equal(result.guests[0].id, 'one');
  assert.equal(result.guests[0].vip, true);
  assert.equal(result.guests[0].checkedIn, true);
  assert.equal(result.guests[0].tableId, 2);
  assert.deepEqual([result.added, result.updated], [1, 1]);
  const manual = mergeConfirmedGuests([{ ...existing, bookingId: '', source: 'manual' }], [{ ...existing, id: 'mec', vip: false }]);
  assert.equal(manual.guests.length, 1);
  assert.equal(manual.guests[0].id, 'one');
});
test('Membership states are explicit, not guessed from companies', () => {
  assert.equal(membershipLabel({ bookingId: '1' }), 'Needs purchaser sync');
  assert.equal(membershipLabel({ company: 'Strategic Member' }), 'No linked booking');
  assert.equal(membershipLabel({ bookingId: '1', bookingMembership: { source: 'woocommerce-purchaser', status: 'active', levels: [{ name: 'Strategic', active: true }, { name: 'Old', active: false }] } }), 'Strategic');
});
test('Inserting a new table at the end of row 1 keeps row 2 tables and seated guests in place', () => {
  const room = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, name: `Table ${String(index + 1).padStart(2, '0')}`, capacity: 10, capacityOverride: false, zone: 'Main' }));
  const seated = [{ id: 'g1', tableId: 4 }, { id: 'g2', tableId: 1 }];
  const inserted = [...room.slice(0, 3), { id: 7, name: 'Table 07', capacity: 10, capacityOverride: false, zone: 'Main' }, ...room.slice(3)];
  const result = applySeatingConfig(inserted, seated, { defaultSeats: 10, tablesPerRow: 3, tableRows: [3, 3], zones: ['Main'] }, { tableCount: 7, tableRows: [4, 3], defaultSeats: 10, zones: ['Main'], tableZones: {} });
  const rows = partitionTables(result.tables, result.details.tableRows);
  assert.deepEqual(rows.map((row) => row.map((table) => table.name)), [['Table 01', 'Table 02', 'Table 03', 'Table 07'], ['Table 04', 'Table 05', 'Table 06']]);
  assert.deepEqual(result.details.tableRows, [4, 3]);
  assert.equal(result.tables.find((table) => table.id === 7).capacity, 10);
});
test('MEC sync removes guests whose booking left the confirmed feed, keeping manual, imported and checked-in guests', () => {
  const current = [
    { id: 'kept', bookingId: '10', attendeeKey: '0', name: 'Still Booked', source: 'mec', tableId: 1 },
    { id: 'drafted', bookingId: '11', attendeeKey: '0', name: 'Drafted Booking', source: 'mec', tableId: 2 },
    { id: 'second-seat', bookingId: '10', attendeeKey: '1', name: 'Removed Attendee', source: 'mec', tableId: 1 },
    { id: 'arrived', bookingId: '12', attendeeKey: '0', name: 'Already Arrived', source: 'mec', checkedIn: true },
    { id: 'legacy', bookingId: '13', attendeeKey: '0', name: 'Legacy Record' },
    { id: 'manual', bookingId: '', attendeeKey: '', name: 'Walk In', email: 'walk@example.test', source: 'manual' },
    { id: 'csv', bookingId: '99', attendeeKey: '0', name: 'Spreadsheet Guest', source: 'import' }
  ];
  const incoming = [{ id: 'MEC-10-0', bookingId: '10', attendeeKey: '0', name: 'Still Booked', source: 'mec' }, { id: 'MEC-20-0', bookingId: '20', attendeeKey: '0', name: 'New Booking', source: 'mec' }];
  const result = mergeConfirmedGuests(current, incoming);
  assert.deepEqual(result.guests.map((guest) => guest.id), ['kept', 'arrived', 'manual', 'csv', 'MEC-20-0']);
  assert.deepEqual(result.removed.map((guest) => guest.id), ['drafted', 'second-seat', 'legacy']);
  assert.deepEqual(result.keptCheckedIn.map((guest) => guest.id), ['arrived']);
  assert.deepEqual([result.added, result.updated], [1, 1]);
  assert.equal(result.guests.find((guest) => guest.id === 'kept').tableId, 1);
  const empty = mergeConfirmedGuests(current, []);
  assert.equal(empty.guests.length, current.length, 'an empty feed never removes guests');
  assert.deepEqual(empty.removed, []);
});
test('MEC sync refreshes attendee contact details while keeping seating and check-in state', () => {
  const existing = { id: 'MEC-8648-0', bookingId: '8648', attendeeKey: '0', name: 'Old Name', email: 'old@example.test', company: 'Old Co', title: 'Old Title', vip: true, tableId: 3, checkedIn: true, checkedInAt: 't', checkedInBy: 'staff', checkInHistory: [], invoiceKey: 'hash', source: 'mec' };
  const incoming = { id: 'MEC-8648-0', bookingId: '8648', attendeeKey: '0', name: 'New Name', email: 'new@example.test', company: 'New Co', title: 'New Title', vip: false, tableId: null, transactionId: 'stTESTKEY01', source: 'mec' };
  const result = mergeConfirmedGuests([existing], [incoming]);
  assert.equal(result.guests.length, 1);
  assert.deepEqual([result.guests[0].name, result.guests[0].email, result.guests[0].company, result.guests[0].title], ['New Name', 'new@example.test', 'New Co', 'New Title']);
  assert.deepEqual([result.guests[0].tableId, result.guests[0].vip, result.guests[0].checkedIn, result.guests[0].invoiceKey, result.guests[0].transactionId], [3, true, true, 'hash', 'stTESTKEY01']);
});
test('arranging tables moves them within and between rows, respects the 20-table limit and drops empty rows', async () => {
  const { moveTableInRows, flattenArrangedRows } = await import('../src/table-layout.js');
  const rows = [['t1', 't2', 't3'], ['t4', 't5'], []];
  assert.deepEqual(moveTableInRows(rows, { row: 0, index: 0 }, { row: 0, index: 3 }).rows[0], ['t2', 't3', 't1'], 'to the end of the same row');
  assert.deepEqual(moveTableInRows(rows, { row: 0, index: 2 }, { row: 0, index: 0 }).rows[0], ['t3', 't1', 't2'], 'to the front of the same row');
  assert.deepEqual(moveTableInRows(rows, { row: 0, index: 0 }, { row: 0, index: 2 }).rows[0], ['t2', 't1', 't3'], 'before a later table');
  assert.equal(moveTableInRows(rows, { row: 0, index: 1 }, { row: 0, index: 2 }).moved, false, 'dropping onto its own next slot changes nothing');
  const between = moveTableInRows(rows, { row: 0, index: 1 }, { row: 1, index: 1 });
  assert.deepEqual(between.rows, [['t1', 't3'], ['t4', 't2', 't5'], []]);
  assert.deepEqual(rows, [['t1', 't2', 't3'], ['t4', 't5'], []], 'input is not mutated');
  assert.deepEqual(moveTableInRows(rows, { row: 1, index: 0 }, { row: 2, index: 0 }).rows[2], ['t4'], 'into an empty row');
  const full = [Array.from({ length: 20 }, (_, i) => `a${i}`), ['b0']];
  assert.equal(moveTableInRows(full, { row: 1, index: 0 }, { row: 0, index: 5 }).reason, 'full');
  assert.equal(moveTableInRows(full, { row: 0, index: 0 }, { row: 0, index: 20 }).moved, true, 'reordering inside a full row is allowed');
  assert.deepEqual(flattenArrangedRows([['t1'], [], ['t2', 't3']]), { tables: ['t1', 't2', 't3'], tableRows: [1, 2] });
});
