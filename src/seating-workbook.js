import { buildRoomModel } from './seating-export.js';
import { membershipLabel } from './seating-config.js';

// Event colour palette as Excel ARGB colours.
const C = { green: 'FF153D2C', greenSeat: 'FF1E5A3D', gold: 'FFC9A352', goldDark: 'FF8A6A2C', goldLight: 'FFE3C98F', cream: 'FFFFFDF8', creamDeep: 'FFF6F0E0', line: 'FFDCD3BB', white: 'FFFFFFFF', muted: 'FF6B776F', ink: 'FF17251D', vip: 'FFF3E6C4', mint: 'FFE8F2EC', amber: 'FFFFF4E0' };
const ORG_NAME = import.meta.env?.VITE_ORGANIZATION_NAME || 'Seating Studio';
const FONT = 'Calibri';
const BOOKING_TYPES = { 'Paid & confirmed': 'Paid', 'Complimentary & confirmed': 'Complimentary', 'Manually added': 'Manually added' };
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = (argb) => ({ style: 'thin', color: { argb } });
const columnLetter = (index) => { let n = index, s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
// Values are written as typed string cells, which Excel never evaluates as formulas (unlike CSV).
const safeText = (value) => String(value ?? '');

async function loadExcel() {
  const mod = await import('exceljs');
  return mod.default?.Workbook ? mod.default : mod;
}

// Green banner (rows 1-3), gold rule (row 4), summary (row 5), spacer (row 6), header (row 7).
function addBanner(workbook, sheet, { columns, title, subtitle, summary, logoId }) {
  const last = columnLetter(columns.length);
  sheet.columns = columns.map((column) => ({ key: column.key, width: column.width }));
  [34, 24, 10].forEach((height, index) => { sheet.getRow(index + 1).height = height; });
  sheet.getRow(4).height = 4;
  sheet.getRow(5).height = 22;
  sheet.getRow(6).height = 8;
  for (let row = 1; row <= 3; row += 1) for (let col = 1; col <= columns.length; col += 1) sheet.getCell(row, col).fill = fill(C.green);
  for (let col = 1; col <= columns.length; col += 1) sheet.getCell(4, col).fill = fill(C.gold);
  // Start the title after enough column width to clear the emblem (Excel width units are roughly 7px each).
  let textStart = 1;
  if (logoId != null) { let pixels = 0; while (textStart <= columns.length && pixels < 222) { pixels += columns[textStart - 1].width * 7 + 5; textStart += 1; } textStart = Math.min(textStart, columns.length); }
  sheet.mergeCells(`${columnLetter(textStart)}1:${last}1`);
  sheet.mergeCells(`${columnLetter(textStart)}2:${last}2`);
  Object.assign(sheet.getCell(1, textStart), { value: title, font: { name: FONT, size: 18, bold: true, color: { argb: C.white } }, alignment: { vertical: 'bottom', horizontal: 'left', indent: 1 } });
  Object.assign(sheet.getCell(2, textStart), { value: subtitle, font: { name: FONT, size: 11, bold: true, color: { argb: C.goldLight } }, alignment: { vertical: 'top', horizontal: 'left', indent: 1 } });
  if (logoId != null) sheet.addImage(logoId, { tl: { col: 0.25, row: 0.3 }, ext: { width: 200, height: 58 }, editAs: 'absolute' });
  sheet.mergeCells(`A5:${last}5`);
  Object.assign(sheet.getCell('A5'), { value: summary, font: { name: FONT, size: 10, bold: true, color: { argb: C.green } }, alignment: { vertical: 'middle', horizontal: 'left', indent: 1 }, fill: fill(C.creamDeep) });
}

function addHeader(sheet, columns, rowNumber = 7) {
  const header = sheet.getRow(rowNumber);
  header.values = columns.map((column) => column.header);
  header.height = 26;
  header.eachCell((cell, col) => {
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: C.white } };
    cell.fill = fill(C.green);
    cell.alignment = { vertical: 'middle', horizontal: columns[col - 1].align || 'left', indent: columns[col - 1].align ? 0 : 1, wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: C.gold } } };
  });
  sheet.autoFilter = { from: { row: rowNumber, column: 1 }, to: { row: rowNumber, column: columns.length } };
}

function styleBodyRow(row, columns, index, { tint } = {}) {
  row.height = 19;
  row.eachCell({ includeEmpty: true }, (cell, col) => {
    const column = columns[col - 1];
    if (!column) return;
    cell.font = { name: FONT, size: 10, color: { argb: C.ink }, ...(column.bold ? { bold: true, color: { argb: C.green } } : {}) };
    cell.fill = fill(tint || (index % 2 ? C.cream : C.white));
    cell.alignment = { vertical: 'middle', horizontal: column.align || 'left', indent: column.align ? 0 : 1 };
    cell.border = { bottom: thin(C.line) };
    if (column.numFmt) cell.numFmt = column.numFmt;
  });
}

function setupPrint(sheet, title, headerRow = 7) {
  sheet.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headerRow}:${headerRow}`, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.25 } };
  sheet.headerFooter = { oddFooter: `&L&8${ORG_NAME} · ${title.replace(/&/g, '&&')}&R&8Page &P of &N` };
}

export async function buildSeatingWorkbook({ tables, guests, details = {}, zone = '', includeLabels = true, includeEmail = false, logoBase64 = '' }) {
  const ExcelJS = await loadExcel();
  const model = buildRoomModel({ tables, guests, details, zone });
  const event = details.name || 'Event';
  const generated = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  // The awards emblem already names the event, so its sheets show only when and where.
  const emblemNamesEvent = Boolean(logoBase64) && /award/i.test(event);
  const subtitle = [emblemNamesEvent ? '' : event, [details.dateLabel, details.startTime].filter(Boolean).join(' · '), details.venue].filter(Boolean).join('  ·  ');
  const summary = `${zone ? `Area: ${zone}` : 'Entire room'}  ·  ${model.tableCount} tables  ·  ${model.seatedCount} of ${model.capacity} seats filled  ·  ${model.vipCount} VIP  ·  ${model.unseated.length} unseated  ·  Generated ${generated}`;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Seating Studio';
  workbook.company = ORG_NAME;
  workbook.title = `${event} seating`;
  workbook.created = new Date();
  workbook.calcProperties = { fullCalcOnLoad: true };
  const logoId = logoBase64 ? workbook.addImage({ base64: logoBase64, extension: 'png' }) : null;
  const sheetOptions = (tab) => ({ properties: { tabColor: { argb: tab } }, views: [{ state: 'frozen', ySplit: 7, xSplit: 0, showGridLines: false, zoomScale: 100 }] });

  // Sheet 1: every seat in room order.
  const seatingColumns = [
    { key: 'number', header: 'Table', width: 11, align: 'center', bold: true },
    ...(includeLabels ? [{ key: 'label', header: 'Table name (admin)', width: 20 }] : []),
    { key: 'zone', header: 'Area', width: 12 },
    { key: 'row', header: 'Row', width: 9, align: 'center' },
    { key: 'seat', header: 'Seat', width: 9, align: 'center' },
    { key: 'name', header: 'Guest name', width: 28, bold: true },
    { key: 'company', header: 'Company', width: 30 },
    { key: 'title', header: 'Job title', width: 26 },
    ...(includeEmail ? [{ key: 'email', header: 'Email', width: 30 }] : []),
    { key: 'vip', header: 'VIP', width: 9, align: 'center' },
    { key: 'membership', header: 'Membership', width: 24 },
    { key: 'booking', header: 'Booking type', width: 15 },
    { key: 'arrived', header: 'Checked in', width: 15, align: 'center' }
  ];
  const seating = workbook.addWorksheet('Seating', sheetOptions(C.green));
  addBanner(workbook, seating, { columns: seatingColumns, title: 'Seating plan', subtitle, summary, logoId });
  addHeader(seating, seatingColumns);
  const seatRows = [
    ...model.rows.flatMap((row) => row.tables.flatMap((item) => item.seated.map((guest, index) => ({ guest, item, seat: index + 1 })))),
    ...model.unseated.map((guest) => ({ guest, item: null, seat: '' }))
  ];
  seatRows.forEach(({ guest, item, seat }, index) => {
    const row = seating.addRow({
      number: item ? item.number : 'Unseated', label: item ? safeText(item.label) : '', zone: item ? safeText(item.table.zone) : '', row: item ? item.row : '', seat,
      name: safeText(guest.name), company: safeText(guest.company), title: safeText(guest.title), email: safeText(guest.email),
      vip: guest.vip ? 'VIP' : '', membership: safeText(membershipLabel(guest)), booking: BOOKING_TYPES[guest.paymentStatus] || safeText(guest.paymentStatus), arrived: guest.checkedIn ? '✓ Yes' : ''
    });
    styleBodyRow(row, seatingColumns, index, { tint: item ? null : C.amber });
    const vipCell = row.getCell('vip');
    if (guest.vip) { vipCell.fill = fill(C.vip); vipCell.font = { name: FONT, size: 9, bold: true, color: { argb: C.goldDark } }; }
    if (guest.checkedIn) row.getCell('arrived').font = { name: FONT, size: 10, bold: true, color: { argb: C.greenSeat } };
    if (!item) row.getCell('number').font = { name: FONT, size: 9, bold: true, color: { argb: C.goldDark } };
  });
  setupPrint(seating, 'Seating plan');

  // Sheet 2: one row per table with totals.
  const tableColumns = [
    { key: 'number', header: 'Table', width: 11, align: 'center', bold: true },
    ...(includeLabels ? [{ key: 'label', header: 'Table name (admin)', width: 22 }] : []),
    { key: 'zone', header: 'Area', width: 12 },
    { key: 'row', header: 'Row', width: 9, align: 'center' },
    { key: 'capacity', header: 'Seats', width: 11, align: 'center' },
    { key: 'seated', header: 'Seated', width: 12, align: 'center' },
    { key: 'open', header: 'Open seats', width: 15, align: 'center' },
    { key: 'vips', header: 'VIP', width: 9, align: 'center' },
    { key: 'fillRate', header: 'Fill', width: 10, align: 'center', numFmt: '0%' },
    { key: 'status', header: 'Status', width: 14, align: 'center' }
  ];
  const tableSheet = workbook.addWorksheet('Tables', sheetOptions(C.gold));
  addBanner(workbook, tableSheet, { columns: tableColumns, title: 'Tables', subtitle, summary, logoId });
  addHeader(tableSheet, tableColumns);
  const items = model.rows.flatMap((row) => row.tables);
  const letter = (key) => columnLetter(tableColumns.findIndex((column) => column.key === key) + 1);
  items.forEach((item, index) => {
    const rowNumber = 8 + index;
    const seated = item.seated.length;
    const row = tableSheet.addRow({
      number: item.number, label: safeText(item.label), zone: safeText(item.table.zone), row: item.row, capacity: item.table.capacity, seated,
      open: { formula: `${letter('capacity')}${rowNumber}-${letter('seated')}${rowNumber}`, result: item.table.capacity - seated },
      vips: item.seated.filter((guest) => guest.vip).length,
      fillRate: { formula: `IF(${letter('capacity')}${rowNumber}=0,0,${letter('seated')}${rowNumber}/${letter('capacity')}${rowNumber})`, result: item.table.capacity ? seated / item.table.capacity : 0 },
      status: seated >= item.table.capacity ? 'Full' : seated === 0 ? 'Empty' : 'Seats open'
    });
    styleBodyRow(row, tableColumns, index, { tint: seated >= item.table.capacity ? C.mint : null });
    const status = row.getCell('status');
    status.font = { name: FONT, size: 9, bold: true, color: { argb: seated >= item.table.capacity ? C.greenSeat : seated === 0 ? C.muted : C.goldDark } };
  });
  const firstData = 8;
  const lastData = 7 + items.length;
  const totals = tableSheet.addRow({
    number: 'Total', capacity: { formula: `SUM(${letter('capacity')}${firstData}:${letter('capacity')}${lastData})`, result: model.capacity },
    seated: { formula: `SUM(${letter('seated')}${firstData}:${letter('seated')}${lastData})`, result: model.seatedCount },
    open: { formula: `SUM(${letter('open')}${firstData}:${letter('open')}${lastData})`, result: model.capacity - model.seatedCount },
    vips: { formula: `SUM(${letter('vips')}${firstData}:${letter('vips')}${lastData})`, result: model.vipCount },
    fillRate: { formula: `IF(${letter('capacity')}${lastData + 1}=0,0,${letter('seated')}${lastData + 1}/${letter('capacity')}${lastData + 1})`, result: model.capacity ? model.seatedCount / model.capacity : 0 }
  });
  totals.height = 24;
  totals.eachCell({ includeEmpty: true }, (cell, col) => {
    const column = tableColumns[col - 1];
    if (!column) return;
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: C.white } };
    cell.fill = fill(C.green);
    cell.alignment = { vertical: 'middle', horizontal: column.align || 'left', indent: column.align ? 0 : 1 };
    cell.border = { top: { style: 'medium', color: { argb: C.gold } } };
    if (column.numFmt) cell.numFmt = column.numFmt;
  });
  setupPrint(tableSheet, 'Tables');

  // Sheet 3: alphabetical door list.
  const azColumns = [
    { key: 'name', header: 'Guest name', width: 32, bold: true },
    { key: 'company', header: 'Company', width: 32 },
    { key: 'table', header: 'Table', width: 13, align: 'center' },
    { key: 'zone', header: 'Area', width: 14 },
    { key: 'vip', header: 'VIP', width: 9, align: 'center' }
  ];
  const az = workbook.addWorksheet('Guests A–Z', sheetOptions(C.greenSeat));
  addBanner(workbook, az, { columns: azColumns, title: 'Guest list A–Z', subtitle, summary, logoId });
  addHeader(az, azColumns);
  [...seatRows].sort((a, b) => a.guest.name.localeCompare(b.guest.name, 'en', { sensitivity: 'base' })).forEach(({ guest, item }, index) => {
    const row = az.addRow({ name: safeText(guest.name), company: safeText(guest.company), table: item ? `Table ${item.number}` : 'Unseated', zone: item ? safeText(item.table.zone) : '', vip: guest.vip ? 'VIP' : '' });
    styleBodyRow(row, azColumns, index);
    const tableCell = row.getCell('table');
    tableCell.fill = fill(item ? C.green : C.amber);
    tableCell.font = { name: FONT, size: 10, bold: true, color: { argb: item ? C.white : C.goldDark } };
    if (guest.vip) { row.getCell('vip').fill = fill(C.vip); row.getCell('vip').font = { name: FONT, size: 9, bold: true, color: { argb: C.goldDark } }; }
  });
  setupPrint(az, 'Guest list A–Z');

  return workbook;
}

export async function buildSeatingWorkbookBuffer(options) {
  const workbook = await buildSeatingWorkbook(options);
  return workbook.xlsx.writeBuffer();
}
