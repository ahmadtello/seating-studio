// Eligibility is verified from the order on WordPress, never from MEC's misleading `paid` (payable amount) field.
export function bookingPaymentStatus(attendee) {
  if (attendee.booking_status?.is_active !== true || Number(attendee.booking_status?.confirmed) !== 1) return '';
  if (attendee.booking_payment?.eligible !== true) return '';
  return { paid: 'Paid & confirmed', complimentary: 'Complimentary & confirmed' }[attendee.booking_payment.kind] || '';
}
