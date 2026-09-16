const normalized = (value) => String(value || '').trim().toLowerCase();
const ticketHosts = String(import.meta.env?.VITE_TICKET_HOSTS || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);

export function invoiceReferenceFromScan(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    if (ticketHosts.length && !ticketHosts.includes(url.hostname.toLowerCase())) return '';
    const match = url.pathname.match(/^\/invoice\/([A-Za-z0-9._-]{1,120})\/?$/i);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return /^[A-Za-z0-9._-]{4,120}$/.test(value) ? value : '';
  }
}

export function invoiceKeyFromScan(rawValue) {
  return normalized(invoiceReferenceFromScan(rawValue));
}

export function findGuestsFromScan(guests, rawValue) {
  const value = normalized(rawValue);
  if (!value) return [];
  const invoiceKey = invoiceKeyFromScan(rawValue);
  const invoiceMatches = invoiceKey ? guests.filter((guest) => [guest.qrToken, guest.invoiceKey, guest.transactionId].some((field) => field && normalized(field) === invoiceKey)) : [];
  if (invoiceMatches.length) return invoiceMatches;
  const directMatches = guests.filter((guest) => [guest.bookingId, guest.email]
    .some((candidate) => candidate && normalized(candidate) === value));
  if (directMatches.length) return directMatches;
  try {
    const url = new URL(String(rawValue).trim());
    for (const [key, candidate] of url.searchParams) {
      if (!/^(booking(?:_id)?|email|transaction|makepreview)$/i.test(key)) continue;
      const matches = guests.filter((guest) => [guest.bookingId, guest.email, guest.qrToken, guest.invoiceKey, guest.transactionId]
        .some((field) => field && normalized(field) === normalized(candidate)));
      if (matches.length) return matches;
    }
  } catch {}
  return [];
}
