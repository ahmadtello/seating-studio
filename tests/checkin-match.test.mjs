import test from 'node:test';
import assert from 'node:assert/strict';
import { findGuestsFromScan, invoiceKeyFromScan, invoiceReferenceFromScan } from '../src/checkin-match.js';

const HASH_ONE = 'b6b7be519371e5d720fe8050973b01d9d08ca62c';
const guests = [
  { id: 'one', name: 'Guest One', bookingId: '8648', attendeeKey: '0', email: 'one@example.test', invoiceKey: HASH_ONE, transactionId: 'stTESTKEY01' },
  { id: 'two', name: 'Guest Two', bookingId: '9001', attendeeKey: '1', email: 'two@example.test', invoiceKey: 'ABcd1234' }
];

test('extracts invoice references from ticket URLs on any https host by default', () => {
  assert.equal(invoiceKeyFromScan('https://shop.example.com/invoice/stTESTKEY01'), 'sttestkey01');
  assert.equal(invoiceKeyFromScan('https://www.other-host.example/invoice/ABcd1234/?print=1'), 'abcd1234');
  assert.equal(invoiceKeyFromScan('http://shop.example.com/invoice/stTESTKEY01'), '', 'non-https links are rejected');
});

test('matches the transaction reference encoded in the invoice QR', () => {
  assert.equal(findGuestsFromScan(guests, 'https://shop.example.com/invoice/stTESTKEY01')[0]?.id, 'one');
  assert.equal(findGuestsFromScan(guests, 'stTESTKEY01')[0]?.id, 'one');
});

test('matches invoice hashes and exact identifiers without partial numeric collisions', () => {
  assert.equal(findGuestsFromScan(guests, `https://shop.example.com/invoice/${HASH_ONE}`)[0]?.id, 'one');
  assert.equal(findGuestsFromScan(guests, 'https://shop.example.com/invoice/ABcd1234')[0]?.id, 'two');
  assert.equal(findGuestsFromScan(guests, 'ABcd1234')[0]?.id, 'two');
  assert.equal(findGuestsFromScan(guests, '9001')[0]?.id, 'two');
  assert.equal(findGuestsFromScan(guests, 'https://shop.example.com/event/12345').length, 0);
});

test('keeps the case of the short invoice key so the server can resolve it', () => {
  assert.equal(invoiceReferenceFromScan('https://shop.example.com/invoice/stTESTKEY01'), 'stTESTKEY01');
  assert.equal(invoiceReferenceFromScan('stTESTKEY01'), 'stTESTKEY01');
  assert.equal(invoiceReferenceFromScan('ftp://shop.example.com/invoice/stTESTKEY01'), '', 'only https links resolve');
  assert.equal(invoiceReferenceFromScan('https://shop.example.com/invoice/stMxxABcDEf9.'), 'stMxxABcDEf9.');
  assert.equal(findGuestsFromScan([{ id: 'dot', qrToken: 'stMxxABcDEf9.' }], 'https://shop.example.com/invoice/stMxxABcDEf9.')[0]?.id, 'dot');
  assert.equal(findGuestsFromScan(guests, `https://shop.example.com/?invoiceID=1&makePreview=${HASH_ONE}&doCheckin=abc`)[0]?.id, 'one');
});

test('returns every attendee attached to a shared invoice', () => {
  const shared = [...guests, { ...guests[0], id: 'three', name: 'Guest Three' }];
  assert.deepEqual(findGuestsFromScan(shared, 'https://shop.example.com/invoice/stTESTKEY01').map((guest) => guest.id), ['one', 'three']);
});

test('matches the per-attendee ticket token to exactly one guest on a shared invoice', () => {
  const list = [{ id: 'a', qrToken: 'stTESTKEY01', invoiceKey: HASH_ONE }, { id: 'b', qrToken: 'stM99ab-Qx1Zz', invoiceKey: HASH_ONE }];
  assert.deepEqual(findGuestsFromScan(list, 'https://shop.example.com/invoice/stM99ab-Qx1Zz').map((guest) => guest.id), ['b']);
  assert.deepEqual(findGuestsFromScan(list, 'https://shop.example.com/invoice/' + HASH_ONE).map((guest) => guest.id), ['a', 'b']);
});
