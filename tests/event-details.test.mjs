import test from 'node:test';
import assert from 'node:assert/strict';
import { markManualEventFields, mergeMecEventDetails } from '../src/event-details.js';

test('manual venue changes remain authoritative over later MEC refreshes', () => {
  const existing = { mecEventId: '99001', name: 'Awards', venue: 'Harbour City', dateLabel: '12 Mar 2027' };
  const edited = markManualEventFields(existing, { ...existing, venue: 'Madinat Jumeirah Conference Centre' });
  const refreshed = mergeMecEventDetails(edited, { name: 'Awards', venue: 'Harbour City', dateLabel: '12 Mar 2027', lastSyncedAt: 'now' });
  assert.equal(refreshed.venue, 'Madinat Jumeirah Conference Centre');
  assert.equal(refreshed.lastSyncedAt, 'now');
  assert.deepEqual(refreshed.manualEventFields, ['venue']);
});

test('MEC continues to fill fields that were not manually changed', () => {
  const existing = { mecEventId: '99001', name: '', venue: 'Custom venue', manualEventFields: ['venue'] };
  const refreshed = mergeMecEventDetails(existing, { name: 'Annual Awards', venue: 'Harbour City', startTime: '7:00PM' });
  assert.equal(refreshed.name, 'Annual Awards');
  assert.equal(refreshed.venue, 'Custom venue');
  assert.equal(refreshed.startTime, '7:00PM');
});

test('changing the MEC event starts a fresh override set', () => {
  const previous = { mecEventId: '1', name: 'Old event', venue: 'Old custom venue', manualEventFields: ['venue'] };
  const next = markManualEventFields(previous, { ...previous, mecEventId: '2' });
  assert.deepEqual(next.manualEventFields, []);
});
