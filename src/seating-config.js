import { normalizeTableRows, validateTableRows } from './table-layout.js';
import { duplicateTableNumber, nextTableNumber } from '../shared/table-labels.js';

export function applySeatingConfig(tables, guests, oldDetails, changes, scope = 'standard') {
  const count = Number(changes.tableCount ?? tables.length);
  const seats = Number(changes.defaultSeats ?? oldDetails.defaultSeats ?? 10);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Choose between 1 and 100 whole tables.');
  if (!Number.isInteger(seats) || seats < 4 || seats > 20) throw new Error('Choose between 4 and 20 seats.');
  const fallbackColumns = Number(changes.tablesPerRow ?? oldDetails.tablesPerRow ?? 5);
  if (!Number.isInteger(fallbackColumns) || fallbackColumns < 1 || fallbackColumns > 20) throw new Error('Choose between 1 and 20 tables per row.');
  const tableRows = changes.tableRows == null
    ? normalizeTableRows(oldDetails.tableRows, count, fallbackColumns)
    : validateTableRows(changes.tableRows, count);
  const columns = changes.tableRows == null ? fallbackColumns : Math.max(...tableRows);
  const zones = [...new Set((changes.zones || [...(oldDetails.zones || []), ...tables.map(t => t.zone)]).map(z => z.trim()).filter(Boolean))];
  if (!zones.length) throw new Error('Add at least one zone.');
  if (zones.length > 30 || zones.some(z => z.length > 60)) throw new Error('Use up to 30 zones, with names up to 60 characters.');
  const removed = new Set(tables.slice(count).map(t => t.id));
  if (guests.some(g => removed.has(g.tableId))) throw new Error('Unseat guests from the tables being removed first.');
  const next = tables.slice(0, count).map(t => {
    const custom = t.capacityOverride ?? (t.capacity !== Number(oldDetails.defaultSeats || 10));
    const update = scope === 'all' || (scope === 'standard' && !custom);
    const capacity = update ? seats : t.capacity;
    if (guests.filter(g => g.tableId === t.id).length > capacity) throw new Error(`${t.name} has more than ${capacity} guests. Unseat guests or keep its custom capacity.`);
    const zone = changes.tableZones?.[t.id] ?? t.zone;
    if (!zones.includes(zone)) throw new Error(`Choose a zone for ${t.name}.`);
    return { ...t, capacity, capacityOverride: update ? false : custom, zone };
  });
  let id = Math.max(0, ...tables.map(t => t.id));
  while (next.length < count) { id += 1; next.push({ id, number: nextTableNumber([...tables, ...next]), name: '', capacity: seats, capacityOverride: false, zone: zones[0] }); }
  const duplicate = duplicateTableNumber(next);
  if (duplicate != null) throw new Error(`Two tables use number ${duplicate}. Give each table a unique number.`);
  return { tables: next, details: { ...oldDetails, ...changes, tableCount: undefined, tableZones: undefined, defaultSeats: seats, tablesPerRow: columns, tableRows, zones } };
}

const isMecGuest = (guest) => guest.source === 'mec' || (!guest.source && Boolean(guest.bookingId));

// Merges the confirmed MEC feed into the guest list. MEC guests missing from the feed
// (booking deleted, drafted, cancelled or unpaid) are removed unless already checked in.
export function mergeConfirmedGuests(current, incoming) {
  const next = current.map(g => ({ ...g }));
  const matched = new Set();
  let added = 0, updated = 0;
  for (const guest of incoming) {
    const index = next.findIndex(item => (item.bookingId && item.bookingId === guest.bookingId && item.attendeeKey === guest.attendeeKey) || (!item.bookingId && item.email && item.email.toLowerCase() === guest.email?.toLowerCase()));
    if (index >= 0) {
      const existing = next[index];
      next[index] = { ...existing, ...guest, id: existing.id, tableId: existing.tableId, vip: existing.vip, checkedIn: existing.checkedIn, checkedInAt: existing.checkedInAt, checkedInBy: existing.checkedInBy, checkInHistory: existing.checkInHistory };
      matched.add(existing.id);
      updated += 1;
    } else { next.push(guest); matched.add(guest.id); added += 1; }
  }
  const stale = incoming.length ? next.filter(guest => isMecGuest(guest) && !matched.has(guest.id)) : [];
  const keptCheckedIn = stale.filter(guest => guest.checkedIn);
  const removed = stale.filter(guest => !guest.checkedIn);
  const removedIds = new Set(removed.map(guest => guest.id));
  return { guests: next.filter(guest => !removedIds.has(guest.id)), added, updated, removed, keptCheckedIn };
}

export function membershipLabel(guest) {
  const membership = guest.bookingMembership;
  if (!guest.bookingId) return 'No linked booking';
  if (membership?.source !== 'woocommerce-purchaser') return 'Needs purchaser sync';
  if (!membership || membership.status === 'unknown') return 'Not synced yet';
  if (membership.status === 'active') return membership.levels.filter(level => level.active).map(level => level.name).join(', ') || 'Active member';
  if (membership.status === 'inactive') return `${membership.levels.map(level => level.name).join(', ')} (inactive)`;
  return { none: 'No membership', 'no-account': 'No booking account', unavailable: 'Unavailable' }[membership.status] || 'Unknown';
}
