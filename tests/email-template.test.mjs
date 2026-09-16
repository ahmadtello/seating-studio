import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_EMAIL_HTML, EMAIL_VARIABLES, NO_QR_MESSAGE, firstNameOf, tableNumberOf, renderEmailTemplate, templateForEvent } from '../src/email-template.js';

test('derives first names and table numbers for the invitation copy', () => {
  assert.equal(firstNameOf('  Fatima Al Mansoori '), 'Fatima');
  assert.equal(firstNameOf(''), 'Guest');
  assert.equal(tableNumberOf({ name: 'Table 07' }), '7');
  assert.equal(tableNumberOf({ name: 'VIP Stage' }), '—', 'an admin-only name is never shown as the table number');
  assert.equal(tableNumberOf({ id: 3, name: '03 - NORTHWIND' }), '3');
  assert.equal(tableNumberOf({ id: 9, number: 12, name: 'Bluewave' }), '12');
  assert.equal(tableNumberOf(null), '—');
});

test('default template renders every documented variable and stays neutral', () => {
  for (const variable of ['{{table_number}}', '{{qr_code}}', '{{guest_name}}']) assert.ok(DEFAULT_EMAIL_HTML.includes(variable), `${variable} missing`);
  assert.ok(EMAIL_VARIABLES.includes('{{qr_code}}'));
  assert.ok(!/https?:\/\//.test(DEFAULT_EMAIL_HTML), 'default template must not reference remote images');
  assert.ok(!new RegExp(['m', 'e', 'f', 'm', 'a'].join(''), 'i').test(DEFAULT_EMAIL_HTML), 'default template must not name the organisation');
  const html = renderEmailTemplate(DEFAULT_EMAIL_HTML, { name: 'Omar <Khan>', transactionId: 'stTESTKEY01' }, { name: 'Table 12', zone: 'Main' }, { name: 'Gala' }, 'data:image/png;base64,QUJD');
  assert.ok(html.includes('Dear Omar &lt;Khan&gt;,'), 'greeting uses the full name');
  assert.ok(html.includes('>12<'));
  assert.ok(html.includes('<img src="data:image/png;base64,QUJD"'));
  assert.ok(html.includes('The event team'));
  assert.ok(!html.includes('{{'));
});

test('default template greets by full name and stays free of organisation branding', () => {
  assert.ok(!DEFAULT_EMAIL_HTML.includes('{{first_name}}'), 'greeting must not fall back to first name');
  assert.ok(DEFAULT_EMAIL_HTML.includes('Dear {{guest_name}},'));
  assert.ok(!DEFAULT_EMAIL_HTML.includes('Facility Management Association'));
});

test('templateForEvent always returns the neutral default template', () => {
  assert.equal(templateForEvent({ mecEventId: '99001' }), DEFAULT_EMAIL_HTML);
  assert.equal(templateForEvent({ mecEventId: '99999' }), DEFAULT_EMAIL_HTML);
  assert.equal(templateForEvent(), DEFAULT_EMAIL_HTML);
});

test('guests without a QR are told to give their name or email at registration, with no contradicting QR line', () => {
  const html = renderEmailTemplate(DEFAULT_EMAIL_HTML, { name: 'Manual Guest' }, { name: 'Table 03' }, { name: 'Gala' }, '');
  assert.ok(html.includes(NO_QR_MESSAGE));
  assert.match(NO_QR_MESSAGE, /full name or email address/);
  assert.ok(!html.includes('Present this QR code at check-in.'), 'the "present the QR code" line is removed for guests without one');
  assert.ok(!html.includes('alt="Your check-in QR code"'));
  assert.ok(html.includes('We look forward to welcoming you.') && html.includes('YOUR TABLE NUMBER'), 'the rest of the email is untouched');
});

test('only a paragraph mentioning the QR code directly above {{qr_code}} is removed', () => {
  const template = '<p>Keep this intro.</p><p style="x">Show your <b>QR code</b> at the desk.</p>\n  {{qr_code}}<p>After QR code note stays.</p>';
  const html = renderEmailTemplate(template, { name: 'No Code' }, { name: 'Table 1' }, {}, '');
  assert.ok(html.includes('<p>Keep this intro.</p>'));
  assert.ok(!html.includes('Show your'));
  assert.ok(html.includes('After QR code note stays.'));
  const unrelated = renderEmailTemplate('<p>Enjoy the evening.</p>{{qr_code}}', { name: 'No Code' }, { name: 'Table 1' }, {}, '');
  assert.ok(unrelated.includes('<p>Enjoy the evening.</p>'), 'paragraphs that do not mention the QR code stay');
});

test('server email renderer uses the same no-QR wording and rule as the preview', () => {
  const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.ok(server.includes(NO_QR_MESSAGE), 'server no-QR message differs from preview');
  assert.ok(!server.includes('will follow once your MEC booking is linked'));
  assert.ok(server.includes('(?=\\{\\{qr_code\\}\\})'), 'server must drop the contradicting QR line too');
});
