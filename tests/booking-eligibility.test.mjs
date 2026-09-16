import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingPaymentStatus } from '../server/booking-eligibility.js';
const base = { booking_status: { is_active: true, confirmed: 1 } };
test('Verified paid and complimentary orders qualify independently of MEC payable amount', () => {
  assert.equal(bookingPaymentStatus({ ...base, paid: 0, booking_payment: { eligible: true, kind: 'paid' } }), 'Paid & confirmed');
  assert.equal(bookingPaymentStatus({ ...base, paid: 0, booking_payment: { eligible: true, kind: 'complimentary' } }), 'Complimentary & confirmed');
});
test('Unconfirmed, inactive, unknown and unpaid records fail closed', () => {
  assert.equal(bookingPaymentStatus({ ...base, paid: 10000 }), '');
  assert.equal(bookingPaymentStatus({ ...base, booking_payment: { eligible: false, kind: 'paid' } }), '');
  assert.equal(bookingPaymentStatus({ ...base, booking_payment: { eligible: true, kind: 'unknown' } }), '');
  for (const state of [{ is_active: false, confirmed: 1 }, { is_active: true, confirmed: 0 }]) assert.equal(bookingPaymentStatus({ booking_status: state, booking_payment: { eligible: true, kind: 'complimentary' } }), '');
});
