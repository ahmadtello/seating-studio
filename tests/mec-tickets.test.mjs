import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { decodeTicketToken, loadMecTickets, ticketImageUrl } from '../server/mec-tickets.js';

const HASH = '1c192aee3c377e912673bbc665027e92ef4cc74a';
const invoice = { invoice_id: 100377, invoice_hash: HASH };
const attendees = [{ key: 0, email: 'one@example.test' }, { key: 1, email: 'two+vip@example.test' }];

test('builds the MEC per-attendee QR image address from invoice and attendee data', () => {
  assert.equal(ticketImageUrl(invoice, attendees[1]), `https://example.com/?invoiceID=100377&makeQRCode=${HASH}&attendee=two%2Bvip%40example.test&place=2&Hash=${HASH}`);
  assert.equal(ticketImageUrl(invoice, attendees[1], 'https://shop.example.test'), `https://shop.example.test/?invoiceID=100377&makeQRCode=${HASH}&attendee=two%2Bvip%40example.test&place=2&Hash=${HASH}`);
  assert.equal(ticketImageUrl({ invoice_id: 'x', invoice_hash: HASH }, attendees[0]), '');
  assert.equal(ticketImageUrl(invoice, { key: 0, email: '' }), '');
});

test('decodes a MEC ticket QR image into its short token', async () => {
  const png = await QRCode.toBuffer('https://example.com/invoice/stTESTKEY01', { type: 'png', width: 120, margin: 2 });
  assert.equal(decodeTicketToken(png), 'stTESTKEY01');
  const dotted = await QRCode.toBuffer('https://example.com/invoice/stMxxABcDEf9.', { type: 'png', width: 111, margin: 2 });
  assert.equal(decodeTicketToken(dotted), 'stMxxABcDEf9.', 'tokens may end with a period');
  const other = await QRCode.toBuffer('https://other.test/invoice/stTESTKEY01', { type: 'png', width: 120, margin: 2 });
  assert.equal(decodeTicketToken(other), '');
  const custom = await QRCode.toBuffer('https://shop.example.test/invoice/stTESTKEY01', { type: 'png', width: 120, margin: 2 });
  assert.equal(decodeTicketToken(custom, 'shop.example.test'), 'stTESTKEY01', 'accepts a configured MEC host');
  assert.equal(decodeTicketToken(Buffer.from('not a png')), '');
});

test('loads invoice hashes and one token per attendee place, reusing known tokens', async () => {
  const pngs = {
    1: await QRCode.toBuffer('https://example.com/invoice/stTESTKEY01', { type: 'png', width: 120, margin: 2 }),
    2: await QRCode.toBuffer('https://example.com/invoice/stM99ab-Qx1Zz', { type: 'png', width: 120, margin: 2 })
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/bookings/100376/invoice')) return { ok: true, json: async () => invoice };
    if (url.endsWith('/bookings/100376')) return { ok: true, json: async () => ({ attendees }) };
    const place = new URL(url).searchParams.get('place');
    return { ok: true, arrayBuffer: async () => pngs[place] };
  };
  const tickets = await loadMecTickets(['100376'], { apiKey: 'k', fetchImpl });
  assert.deepEqual(tickets.get('100376'), { invoiceKey: HASH, tokens: { 1: 'stTESTKEY01', 2: 'stM99ab-Qx1Zz' } });
  assert.equal(calls.length, 4);
  const reused = await loadMecTickets(['100376'], { apiKey: 'k', fetchImpl, knownTokens: new Map([['100376', { 1: 'stTESTKEY01', 2: 'stM99ab-Qx1Zz' }]]), expectedSeats: new Map([['100376', 2]]) });
  assert.deepEqual(reused.get('100376').tokens, { 1: 'stTESTKEY01', 2: 'stM99ab-Qx1Zz' });
  assert.equal(calls.length, 5, 'known tokens skip the booking and image fetches');
});
