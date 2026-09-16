import test from 'node:test';
import assert from 'node:assert/strict';
import { smartAutoAssign, titleSeniority } from '../src/smart-seating.js';

const tables = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, name: `Table ${index + 1}`, capacity: 4, zone: index < 2 ? 'VIP' : 'Main' }));
const member = name => ({ source: 'woocommerce-purchaser', status: 'active', levels: [{ name, active: true }] });
const guest = (id, company, extras = {}) => ({ id, name: `Guest ${id}`, company, title: 'Manager', tableId: null, vip: false, bookingMembership: member('Corporate Member'), ...extras });

test('Balanced seating creates company pairs without letting one company dominate', () => {
  const guests = [1,2,3,4,5,6].map(id => guest(`a${id}`, 'Alpha')).concat([1,2,3,4].map(id => guest(`b${id}`, 'Beta')));
  const result = smartAutoAssign(guests, tables, { vipZone: 'VIP' }, { style: 'balanced', tableUsage: 'efficient', priorityMemberships: [] });
  const companyCounts = tables.flatMap(table => ['Alpha','Beta'].map(company => result.guests.filter(g => g.tableId === table.id && g.company === company).length));
  assert.ok(Math.max(...companyCounts) <= 3);
  assert.ok(result.summary.guestsWithColleague >= 8);
  assert.equal(result.summary.unseated, 0);
});

test('Networking and company-together modes produce meaningfully different layouts', () => {
  const guests = [1,2,3,4].map(id => guest(`a${id}`, 'Alpha')).concat([1,2,3,4].map(id => guest(`b${id}`, 'Beta')));
  const networking = smartAutoAssign(guests, tables, {}, { style: 'networking', tableUsage: 'efficient', priorityMemberships: [] });
  const together = smartAutoAssign(guests, tables, {}, { style: 'company', tableUsage: 'efficient', priorityMemberships: [] });
  const maxCompanyAtTable = result => Math.max(...tables.flatMap(t => ['Alpha','Beta'].map(c => result.guests.filter(g => g.tableId === t.id && g.company === c).length)));
  assert.ok(maxCompanyAtTable(networking) <= 2);
  assert.ok(maxCompanyAtTable(together) >= 3);
});

test('VIP and selected purchaser memberships receive the configured priority area', () => {
  const guests = [
    guest('strategic', 'Alpha', { bookingMembership: member('Premium Corporate Member') }),
    guest('vip', 'Beta', { vip: true }),
    guest('regular', 'Gamma')
  ];
  const result = smartAutoAssign(guests, tables, { vipZone: 'VIP' }, { priorityMemberships: ['Premium Corporate Member'] });
  assert.equal(result.summary.priorityTotal, 2);
  assert.equal(result.summary.priorityInZone, 2);
  assert.ok(result.guests.filter(g => ['strategic','vip'].includes(g.id)).every(g => tables.find(t => t.id === g.tableId).zone === 'VIP'));
});

test('Manual assignments remain unchanged and occupied capacity is respected', () => {
  const guests = [guest('fixed', 'Alpha', { tableId: 6 }), ...Array.from({length: 8}, (_,i) => guest(`g${i}`, `Company ${i}`))];
  const result = smartAutoAssign(guests, tables, {}, {});
  assert.equal(result.guests.find(g => g.id === 'fixed').tableId, 6);
  assert.equal(result.summary.existingAssignmentsKept, 1);
  assert.ok(tables.every(t => result.guests.filter(g => g.tableId === t.id).length <= t.capacity));
});

test('Efficient mode uses fewer tables than spread mode and output is deterministic', () => {
  const guests = Array.from({length: 12}, (_,i) => guest(`g${i}`, `Company ${i % 6}`));
  const efficient = smartAutoAssign(guests, tables, {}, { tableUsage: 'efficient', priorityMemberships: [] });
  const spread = smartAutoAssign(guests, tables, {}, { tableUsage: 'spread', priorityMemberships: [] });
  assert.ok(efficient.summary.usedTables < spread.summary.usedTables);
  assert.deepEqual(smartAutoAssign(guests, tables, {}, { tableUsage: 'efficient', priorityMemberships: [] }).guests, efficient.guests);
  assert.ok(guests.every(g => g.tableId === null), 'Input objects must not be mutated');
});

test('Leadership titles are classified without treating every manager as C-suite', () => {
  assert.equal(titleSeniority('Chief Executive Officer'), 4);
  assert.equal(titleSeniority('Executive Director'), 3);
  assert.equal(titleSeniority('Regional Director'), 2);
  assert.equal(titleSeniority('Facilities Manager'), 1);
  assert.equal(titleSeniority('Coordinator'), 0);
});
