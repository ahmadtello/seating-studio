// Table identity rules shared by the dashboard and the API.
// number: the public table number guests see (emails, self check-in, check-in desk).
// name:   an optional internal label (for example a sponsor) shown only in the admin dashboard.

const LEGACY_NAME = /^\s*(?:table\s*)?0*(\d{1,3})(?:\s*[-–—:·|]\s*|\s+|$)(.*)$/i;
const MAX_NUMBER = 999;

const validNumber = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= MAX_NUMBER ? number : null;
};

// Splits an old combined name such as "01 - ATLAS/ORBIT", "Table 07" or "11" into number and label.
export function parseLegacyTableName(name) {
  const text = String(name ?? '').trim();
  const match = text.match(LEGACY_NAME);
  if (!match) return { number: null, label: text };
  return { number: validNumber(match[1]), label: match[2].trim() };
}

export function tableNumber(table) {
  if (!table) return null;
  return validNumber(table.number) ?? parseLegacyTableName(table.name).number ?? validNumber(table.id);
}

// Admin-only label; tables still in the legacy format have their number stripped off.
export function tableLabel(table) {
  if (!table) return '';
  if (validNumber(table.number) != null) return String(table.name ?? '').trim();
  return parseLegacyTableName(table.name).label;
}

// What guests and check-in staff see.
export function tableTitle(table) {
  const number = tableNumber(table);
  return number == null ? 'Table' : `Table ${number}`;
}

// What admins see.
export function tableAdminTitle(table) {
  const label = tableLabel(table);
  return label ? `${tableTitle(table)} · ${label}` : tableTitle(table);
}

export function nextTableNumber(tables) {
  return Math.min(MAX_NUMBER, Math.max(0, ...(tables || []).map((table) => tableNumber(table) || 0)) + 1);
}

// Gives every table an explicit, unique number and a label-only name. Order and ids never change.
export function normalizeTableNumbers(tables) {
  const used = new Set();
  const parsed = (tables || []).map((table) => ({ table, number: tableNumber(table), label: tableLabel(table) }));
  let next = Math.max(0, ...parsed.map((item) => item.number || 0));
  return parsed.map(({ table, number, label }) => {
    let assigned = number;
    if (assigned == null || used.has(assigned)) { do { next += 1; } while (used.has(next)); assigned = Math.min(next, MAX_NUMBER); }
    used.add(assigned);
    return { ...table, number: assigned, name: label };
  });
}

export function renumberTablesInOrder(tables) {
  return (tables || []).map((table, index) => ({ ...table, number: index + 1, name: tableLabel(table) }));
}

export function duplicateTableNumber(tables) {
  const seen = new Set();
  for (const table of tables || []) {
    const number = tableNumber(table);
    if (seen.has(number)) return number;
    seen.add(number);
  }
  return null;
}
