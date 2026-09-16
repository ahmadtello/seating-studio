const MAX_TABLES_PER_ROW = 20;

export function buildUniformRows(tableCount, tablesPerRow = 5) {
  const count = Number(tableCount);
  const size = Number(tablesPerRow);
  if (!Number.isInteger(count) || count < 1 || count > 100) return [];
  const safeSize = Number.isInteger(size) && size >= 1 && size <= MAX_TABLES_PER_ROW ? size : 5;
  const rows = [];
  for (let remaining = count; remaining > 0; remaining -= safeSize) rows.push(Math.min(safeSize, remaining));
  return rows;
}

export function buildBalancedRows(tableCount, rowCount) {
  const count = Number(tableCount);
  const requestedRows = Number(rowCount);
  if (!Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(requestedRows) || requestedRows < 1) return [];
  const numberOfRows = Math.min(count, requestedRows);
  const baseSize = Math.floor(count / numberOfRows);
  const largerRows = count % numberOfRows;
  if (baseSize > MAX_TABLES_PER_ROW) return buildUniformRows(count, MAX_TABLES_PER_ROW);
  return Array.from({ length: numberOfRows }, (_, index) => baseSize + (index < largerRows ? 1 : 0));
}

export function validateTableRows(value, tableCount) {
  const count = Number(tableCount);
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error('Add between 1 and 100 table rows.');
  const rows = value.map(Number);
  if (rows.some((row) => !Number.isInteger(row) || row < 1 || row > MAX_TABLES_PER_ROW)) throw new Error('Each row must contain between 1 and 20 whole tables.');
  const total = rows.reduce((sum, row) => sum + row, 0);
  if (total !== count) throw new Error(`Your rows contain ${total} tables, but the room is set to ${count}. Adjust the row counts before applying.`);
  return rows;
}

export function normalizeTableRows(value, tableCount, fallbackSize = 5) {
  try {
    return validateTableRows(value, tableCount);
  } catch {
    return buildUniformRows(tableCount, fallbackSize);
  }
}

export function fitTableRows(value, tableCount, fallbackSize = 5) {
  const count = Number(tableCount);
  if (!Number.isInteger(count) || count < 1 || count > 100) return value;
  const source = Array.isArray(value) ? value.map(Number).filter((row) => Number.isInteger(row) && row > 0).map((row) => Math.min(row, MAX_TABLES_PER_ROW)) : [];
  const rows = [];
  let remaining = count;
  for (const row of source) {
    if (!remaining) break;
    const next = Math.min(row, remaining);
    rows.push(next);
    remaining -= next;
  }
  if (remaining && rows.length && rows[rows.length - 1] < MAX_TABLES_PER_ROW) {
    const extra = Math.min(MAX_TABLES_PER_ROW - rows[rows.length - 1], remaining);
    rows[rows.length - 1] += extra;
    remaining -= extra;
  }
  const preferred = Number.isInteger(Number(fallbackSize)) ? Math.min(MAX_TABLES_PER_ROW, Math.max(1, Number(fallbackSize))) : 5;
  while (remaining) {
    const next = Math.min(preferred, remaining);
    rows.push(next);
    remaining -= next;
  }
  return rows.length ? rows : buildUniformRows(count, preferred);
}

export function partitionTables(tables, rowSizes) {
  const rows = [];
  let offset = 0;
  for (const size of rowSizes) {
    rows.push(tables.slice(offset, offset + size));
    offset += size;
  }
  if (offset < tables.length) rows.push(tables.slice(offset));
  return rows.filter((row) => row.length);
}

// Moves one table between (or within) rows. `to.index` means "insert before the item currently at that index".
export function moveTableInRows(rows, from, to) {
  const source = rows[from?.row];
  if (!source || !source[from.index] || !rows[to?.row]) return { rows, moved: false, reason: 'invalid' };
  if (from.row !== to.row && rows[to.row].length >= MAX_TABLES_PER_ROW) return { rows, moved: false, reason: 'full' };
  const next = rows.map((row) => [...row]);
  const [item] = next[from.row].splice(from.index, 1);
  const target = from.row === to.row && to.index > from.index ? to.index - 1 : to.index;
  const index = Math.max(0, Math.min(target, next[to.row].length));
  if (from.row === to.row && index === from.index) return { rows, moved: false, reason: 'same' };
  next[to.row].splice(index, 0, item);
  return { rows: next, moved: true };
}

// Empty rows are dropped; tables keep their order so the floor plan matches the arrangement.
export function flattenArrangedRows(rows) {
  const kept = rows.filter((row) => row.length);
  return { tables: kept.flat(), tableRows: kept.map((row) => row.length) };
}
