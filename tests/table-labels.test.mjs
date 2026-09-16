import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateTableNumber, nextTableNumber, normalizeTableNumbers, parseLegacyTableName, renumberTablesInOrder, tableAdminTitle, tableLabel, tableNumber, tableTitle } from '../shared/table-labels.js';

test('splits the legacy combined names used in production', () => {
  assert.deepEqual(parseLegacyTableName('01 - ATLAS/ORBIT'), { number: 1, label: 'ATLAS/ORBIT' });
  assert.deepEqual(parseLegacyTableName('13 - ACME/GLOBEX'), { number: 13, label: 'ACME/GLOBEX' });
  assert.deepEqual(parseLegacyTableName('28 - AG Facilities'), { number: 28, label: 'AG Facilities' });
  assert.deepEqual(parseLegacyTableName('11'), { number: 11, label: '' });
  assert.deepEqual(parseLegacyTableName('Table 07'), { number: 7, label: '' });
  assert.deepEqual(parseLegacyTableName('Table 5 – Sponsors'), { number: 5, label: 'Sponsors' });
  assert.deepEqual(parseLegacyTableName('VIP Stage'), { number: null, label: 'VIP Stage' });
  assert.deepEqual(parseLegacyTableName('2026 Winners'), { number: null, label: '2026 Winners' });
});

test('guests see only the number while admins also see the label', () => {
  const legacy = { id: 3, name: '03 - NORTHWIND' };
  assert.equal(tableNumber(legacy), 3);
  assert.equal(tableTitle(legacy), 'Table 3');
  assert.equal(tableLabel(legacy), 'NORTHWIND');
  assert.equal(tableAdminTitle(legacy), 'Table 3 · NORTHWIND');
  const modern = { id: 9, number: 12, name: 'Bluewave' };
  assert.equal(tableTitle(modern), 'Table 12');
  assert.equal(tableAdminTitle(modern), 'Table 12 · Bluewave');
  assert.equal(tableAdminTitle({ id: 4, number: 4, name: '' }), 'Table 4');
  assert.equal(tableAdminTitle({ id: 8, name: 'VIP Stage' }), 'Table 8 · VIP Stage');
});

test('normalising keeps order and ids, and resolves duplicate or missing numbers', () => {
  const result = normalizeTableNumbers([
    { id: 1, name: '01 - ATLAS/ORBIT' }, { id: 2, name: '11' }, { id: 3, name: 'Table 41' },
    { id: 4, name: '11 - Duplicate' }, { id: 5, name: 'VIP Stage' }, { id: 6, number: 7, name: 'Kept' }
  ]);
  assert.deepEqual(result.map((table) => [table.id, table.number, table.name]), [[1, 1, 'ATLAS/ORBIT'], [2, 11, ''], [3, 41, ''], [4, 42, 'Duplicate'], [5, 5, 'VIP Stage'], [6, 7, 'Kept']]);
  assert.equal(duplicateTableNumber(result), null);
  assert.equal(normalizeTableNumbers(result).map((table) => table.number).join(), result.map((table) => table.number).join(), 'idempotent');
});

test('next number, duplicate detection and renumbering in room order', () => {
  const tables = [{ id: 1, number: 1, name: 'A' }, { id: 47, number: 47, name: '' }, { id: 2, number: 2, name: 'B' }];
  assert.equal(nextTableNumber(tables), 48);
  assert.equal(duplicateTableNumber([...tables, { id: 9, number: 2 }]), 2);
  assert.deepEqual(renumberTablesInOrder(tables).map((table) => [table.id, table.number, table.name]), [[1, 1, 'A'], [47, 2, ''], [2, 3, 'B']]);
});
