import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const DEFAULT_MEC_BASE = 'https://example.com';
const cleanKey = (value) => /^[A-Za-z0-9._-]{1,120}$/.test(String(value || '')) ? String(value) : '';
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The MEC invoice renders one QR image per attendee at this address; the image encodes the attendee's ticket link.
export function ticketImageUrl(invoice, attendee, mecBase = DEFAULT_MEC_BASE) {
  const invoiceId = /^\d{1,20}$/.test(String(invoice?.invoice_id || '')) ? String(invoice.invoice_id) : '';
  const invoiceKey = cleanKey(invoice?.invoice_hash);
  const email = String(attendee?.email || '').trim();
  const place = Number(attendee?.key) + 1;
  if (!invoiceId || !invoiceKey || !email || !Number.isInteger(place) || place < 1) return '';
  return `${mecBase}/?invoiceID=${invoiceId}&makeQRCode=${invoiceKey}&attendee=${encodeURIComponent(email)}&place=${place}&Hash=${invoiceKey}`;
}

export function decodeTicketToken(pngBuffer, mecHost = new URL(DEFAULT_MEC_BASE).hostname) {
  try {
    const png = PNG.sync.read(pngBuffer);
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    const match = String(decoded?.data || '').match(new RegExp(`^https:\\/\\/(?:www\\.)?${escapeRegExp(mecHost)}\\/invoice\\/([A-Za-z0-9._-]{4,120})\\/?$`, 'i'));
    return match ? match[1] : '';
  } catch { return ''; }
}

export async function loadMecTickets(bookingIds, { apiKey, cache = new Map(), fetchImpl = fetch, concurrency = 10, knownTokens = new Map(), expectedSeats = new Map(), mecBase = DEFAULT_MEC_BASE } = {}) {
  const result = new Map();
  const pending = [...new Set(bookingIds.map(String).filter((bookingId) => /^\d{1,20}$/.test(bookingId)))];
  const headers = { 'X-API-Key': apiKey, Accept: 'application/json' };
  const mecHost = (() => { try { return new URL(mecBase).hostname; } catch { return ''; } })();
  let cursor = 0;
  async function loadBooking(bookingId) {
    const response = await fetchImpl(`${mecBase}/wp-json/mec-utility/v1/bookings/${bookingId}/invoice`, { headers, redirect: 'error', signal: AbortSignal.timeout(12_000) });
    const invoice = response.ok ? await response.json() : {};
    const invoiceKey = cleanKey(invoice.invoice_hash);
    const known = knownTokens.get(bookingId) || {};
    if (Object.keys(known).length && Object.keys(known).length >= (expectedSeats.get(bookingId) || 1)) return { invoiceKey, tokens: { ...known } };
    const tokens = { ...known };
    if (invoiceKey) {
      const details = await fetchImpl(`${mecBase}/wp-json/mec-utility/v1/bookings/${bookingId}`, { headers, redirect: 'error', signal: AbortSignal.timeout(12_000) });
      const attendees = details.ok ? (await details.json()).attendees || [] : [];
      for (const attendee of attendees) {
        const place = Number(attendee.key) + 1;
        const url = ticketImageUrl(invoice, attendee, mecBase);
        if (!url || tokens[place]) continue;
        try {
          const picture = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(12_000) });
          if (!picture.ok) continue;
          const token = decodeTicketToken(Buffer.from(await picture.arrayBuffer()), mecHost);
          if (token) tokens[place] = token;
        } catch {}
      }
    }
    return { invoiceKey, tokens };
  }
  async function worker() {
    while (cursor < pending.length) {
      const bookingId = pending[cursor++];
      const cached = cache.get(bookingId);
      if (cached?.expires > Date.now()) { if (cached.value?.invoiceKey) result.set(bookingId, cached.value); continue; }
      try {
        const value = await loadBooking(bookingId);
        cache.set(bookingId, { value, expires: Date.now() + 15 * 60 * 1000 });
        if (value.invoiceKey) result.set(bookingId, value);
      } catch {
        cache.set(bookingId, { value: null, expires: Date.now() + 60 * 1000 });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
  while (cache.size > 2_000) cache.delete(cache.keys().next().value);
  return result;
}
