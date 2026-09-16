export const EDITABLE_MEC_FIELDS = ['name', 'dateLabel', 'venue', 'startTime', 'endTime'];

export function markManualEventFields(previous, next) {
  const eventChanged = String(previous.mecEventId || '') !== String(next.mecEventId || '');
  const manual = new Set(eventChanged ? [] : (previous.manualEventFields || []));
  for (const field of EDITABLE_MEC_FIELDS) {
    if (String(previous[field] || '') !== String(next[field] || '')) manual.add(field);
  }
  return { ...next, manualEventFields: [...manual] };
}

export function mergeMecEventDetails(current, incoming) {
  const manual = new Set(current.manualEventFields || []);
  const next = { ...current };
  for (const [field, value] of Object.entries(incoming || {})) {
    if (!manual.has(field)) next[field] = value;
  }
  return next;
}
