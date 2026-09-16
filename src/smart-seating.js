export const DEFAULT_SEATING_RULES = Object.freeze({
  style: 'balanced',
  tableUsage: 'efficient',
  priorityMemberships: ['Premium Corporate Member'],
  balanceLeaders: true
});

const placeholderCompany = /^(company|organisation|organization|employer|company not provided|not provided|unknown|n\/a|-)?$/i;

export function guestCompany(guest) {
  const value = String(guest.company || '').trim();
  return value && !placeholderCompany.test(value) ? value.toLocaleLowerCase() : '';
}

export function activeMemberships(guest) {
  return (guest.bookingMembership?.levels || []).filter(level => level.active && level.name).map(level => level.name);
}

export function titleSeniority(title) {
  const value = String(title || '').toLocaleLowerCase();
  if (/\b(chair(?:man|woman|person)?|ceo|chief executive|president|founder|managing director|secretary general|director general)\b/.test(value)) return 4;
  if (/\b(chief|cfo|coo|cto|cmo|vice president|vp|partner|general manager|executive director)\b/.test(value)) return 3;
  if (/\b(director|head|country manager|regional manager)\b/.test(value)) return 2;
  if (/\b(manager|lead)\b/.test(value)) return 1;
  return 0;
}

export function normalizeSeatingRules(rules = {}, membershipNames = []) {
  const fallbackPriority = membershipNames.filter(name => /strategic/i.test(name));
  return {
    style: ['balanced', 'company', 'networking'].includes(rules.style) ? rules.style : DEFAULT_SEATING_RULES.style,
    tableUsage: ['efficient', 'spread'].includes(rules.tableUsage) ? rules.tableUsage : DEFAULT_SEATING_RULES.tableUsage,
    priorityMemberships: Array.isArray(rules.priorityMemberships)
      ? [...new Set(rules.priorityMemberships.filter(name => membershipNames.includes(name)))].slice(0, 30)
      : fallbackPriority,
    balanceLeaders: rules.balanceLeaders !== false
  };
}

function guestSignals(guest, priorityMemberships) {
  const memberships = activeMemberships(guest);
  const company = guestCompany(guest);
  const seniority = titleSeniority(guest.title);
  return {
    company,
    memberships,
    seniority,
    priority: Boolean(guest.vip) || memberships.some(name => priorityMemberships.includes(name))
  };
}

function companyScore(style, sameCompany, load, table) {
  if (!sameCompany) return style === 'company' ? 10 : style === 'balanced' ? 3 : 0;
  if (style === 'networking') return 28 * sameCompany;
  if (style === 'company') {
    const limit = Math.min(6, Math.max(2, Math.ceil(table.capacity * 0.6)));
    return sameCompany < limit ? -16 - sameCompany : 90 + sameCompany * 10;
  }
  // Balanced networking deliberately creates colleague pairs, then starts a new pair elsewhere.
  if (sameCompany === 1) return -10;
  if (sameCompany === 2) return 24;
  return 80 + sameCompany * 12;
}

export function smartAutoAssign(guests, tables, details = {}, requestedRules = {}) {
  const membershipNames = [...new Set(guests.flatMap(activeMemberships))].sort();
  const rules = normalizeSeatingRules(requestedRules, membershipNames);
  const tableOrder = new Map(tables.map((table, index) => [table.id, index]));
  const validTableIds = new Set(tables.map(table => table.id));
  const working = guests.map(guest => ({ ...guest, tableId: validTableIds.has(guest.tableId) ? guest.tableId : null }));
  const signals = new Map(working.map(guest => [guest.id, guestSignals(guest, rules.priorityMemberships)]));
  const companySizes = working.reduce((counts, guest) => {
    const company = signals.get(guest.id).company;
    if (company) counts.set(company, (counts.get(company) || 0) + 1);
    return counts;
  }, new Map());
  const tableLoads = new Map(tables.map(table => [table.id, working.filter(guest => guest.tableId === table.id)]));
  const initiallyAssigned = new Map(working.filter(guest => guest.tableId).map(guest => [guest.id, guest.tableId]));
  const priorityZone = details.vipZone && tables.some(table => table.zone === details.vipZone) ? details.vipZone : '';

  const queue = working.filter(guest => !guest.tableId).sort((left, right) => {
    const a = signals.get(left.id), b = signals.get(right.id);
    return Number(b.priority) - Number(a.priority)
      || (companySizes.get(b.company) || 0) - (companySizes.get(a.company) || 0)
      || b.seniority - a.seniority
      || String(left.name || left.id).localeCompare(String(right.name || right.id));
  });

  for (const guest of queue) {
    const signal = signals.get(guest.id);
    const choices = tables.filter(table => tableLoads.get(table.id).length < table.capacity).map(table => {
      const load = tableLoads.get(table.id);
      const sameCompany = signal.company ? load.filter(person => signals.get(person.id).company === signal.company).length : 0;
      const sameMembership = signal.memberships.length ? load.filter(person => signals.get(person.id).memberships.some(name => signal.memberships.includes(name))).length : 0;
      const seniorLeaders = signal.seniority >= 2 ? load.filter(person => signals.get(person.id).seniority >= 2).length : 0;
      const fillRatio = load.length / table.capacity;
      let score = companyScore(rules.style, sameCompany, load, table);

      if (rules.tableUsage === 'efficient') score += load.length ? -10 - fillRatio * 6 : 24;
      else score += fillRatio * 24;
      if (rules.style !== 'company') score += sameMembership * 2.5;
      if (rules.balanceLeaders && signal.seniority >= 2 && load.length) score += seniorLeaders * 5;
      if (priorityZone) {
        if (signal.priority) score += table.zone === priorityZone ? -120 : 48;
        else if (table.zone === priorityZone) score += 18;
      }
      return { table, score };
    }).sort((a, b) => a.score - b.score || tableOrder.get(a.table.id) - tableOrder.get(b.table.id));
    if (choices[0]) {
      guest.tableId = choices[0].table.id;
      tableLoads.get(choices[0].table.id).push(guest);
    }
  }

  const usedTables = tables.filter(table => tableLoads.get(table.id).length);
  const seatedPriority = working.filter(guest => signals.get(guest.id).priority && guest.tableId);
  const priorityInZone = seatedPriority.filter(guest => tables.find(table => table.id === guest.tableId)?.zone === priorityZone).length;
  const guestsWithColleague = working.filter(guest => {
    const company = signals.get(guest.id).company;
    return guest.tableId && company && tableLoads.get(guest.tableId).some(person => person.id !== guest.id && signals.get(person.id).company === company);
  }).length;
  const mixedCompanyTables = usedTables.filter(table => new Set(tableLoads.get(table.id).map(person => signals.get(person.id).company).filter(Boolean)).size >= 2).length;
  const mixedMembershipTables = usedTables.filter(table => new Set(tableLoads.get(table.id).flatMap(person => signals.get(person.id).memberships)).size >= 2).length;
  const unseated = working.filter(guest => !guest.tableId).length;

  return {
    guests: working,
    rules,
    summary: {
      newlyAssigned: queue.length - unseated,
      existingAssignmentsKept: [...initiallyAssigned].filter(([id, tableId]) => working.find(guest => guest.id === id)?.tableId === tableId).length,
      unseated,
      usedTables: usedTables.length,
      totalTables: tables.length,
      priorityInZone,
      priorityTotal: seatedPriority.length,
      priorityZone,
      guestsWithColleague,
      mixedCompanyTables,
      mixedMembershipTables
    }
  };
}
