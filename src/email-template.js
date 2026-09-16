import { tableNumber, tableTitle } from '../shared/table-labels.js';

export const DEFAULT_EMAIL_HTML = `<!doctype html>
<html>
  <body style="margin:0;background:#ece8dc;font-family:Arial,Helvetica,sans-serif;color:#18251e">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ece8dc;padding:24px 12px">
      <tr><td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
          <tr><td style="padding:30px 36px 12px">
            <p style="margin:0 0 12px;font-size:18px;line-height:1.45;color:#13301e"><b>Dear {{guest_name}},</b></p>
            <p style="margin:0;color:#4f5e55;font-size:15px;line-height:1.65">Your place is confirmed. Here are the details you need for a smooth arrival.</p>
          </td></tr>
          <tr><td style="padding:10px 36px 8px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#13301e;color:#ffffff;border-radius:10px;overflow:hidden">
              <tr><td style="padding:24px 28px;text-align:center;vertical-align:middle"><div style="font-size:11px;letter-spacing:.12em;color:#e2d2ac">YOUR TABLE NUMBER</div><div style="margin-top:7px;font-size:52px;line-height:1;font-weight:800;color:#ffffff">{{table_number}}</div></td></tr>
            </table>
          </td></tr>
          <tr><td style="padding:22px 36px 8px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e3ddcf">
              <tr>
                <td width="120" style="padding:13px 0;border-bottom:1px solid #e3ddcf;font-size:12px;font-weight:700;color:#7c6b45;vertical-align:top">DATE</td>
                <td style="padding:13px 0;border-bottom:1px solid #e3ddcf;font-size:14px;font-weight:700;color:#20352a">{{event_date}}</td>
              </tr>
              <tr>
                <td width="120" style="padding:13px 0;border-bottom:1px solid #e3ddcf;font-size:12px;font-weight:700;color:#7c6b45;vertical-align:top">ARRIVAL</td>
                <td style="padding:13px 0;border-bottom:1px solid #e3ddcf;font-size:14px;font-weight:700;color:#20352a">{{start_time}}</td>
              </tr>
              <tr>
                <td width="120" style="padding:13px 0;font-size:12px;font-weight:700;color:#7c6b45;vertical-align:top">VENUE</td>
                <td style="padding:13px 0;font-size:14px;font-weight:700;color:#20352a">{{venue}}</td>
              </tr>
            </table>
          </td></tr>
          <tr><td style="padding:18px 36px 26px;text-align:center">
            <p style="margin:0 0 15px;color:#4f5e55;font-size:14px;line-height:1.55">Present this QR code at check-in.</p>
            {{qr_code}}
          </td></tr>
          <tr><td style="padding:0 36px 28px"><p style="margin:0;font-size:14px;line-height:1.55;color:#26372e">We look forward to welcoming you.<br><b style="color:#13301e">The event team</b></p></td></tr>
          <tr><td style="padding:12px 24px 8px;background:#13301e;text-align:center;font-size:10px;color:#c9d5ce;line-height:1.45">This seating notice is personal to {{guest_name}}.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

export const templateForEvent = () => DEFAULT_EMAIL_HTML;

export const EMAIL_VARIABLES = ['{{first_name}}', '{{guest_name}}', '{{table_number}}', '{{table_name}}', '{{qr_code}}', '{{event_name}}', '{{event_date}}', '{{start_time}}', '{{venue}}', '{{table_zone}}', '{{ticket_name}}'];

export const escapeTemplateValue = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0] || 'Guest';

// Guest-facing number only; the admin table name is never shown to guests.
export const tableNumberOf = (table) => String(tableNumber(table) ?? '—');

export const NO_QR_MESSAGE = 'Your name is on our guest list. When you arrive, simply give your full name or email address at the registration desk and our team will check you in.';

export const qrCodeBlock = (imageUrl) => imageUrl
  ? `<table role="presentation" align="center" cellspacing="0" cellpadding="0" style="margin:0 auto"><tr><td style="padding:14px;background:#ffffff;border:1px solid #d8e3dc;border-radius:12px"><img src="${escapeTemplateValue(imageUrl)}" width="180" height="180" alt="Your check-in QR code" style="display:block;width:180px;height:180px"></td></tr></table>`
  : `<p style="margin:0;padding:16px 18px;background:#f3f6f2;border:1px solid #d8e3dc;border-radius:12px;color:#26372e;font-size:15px;line-height:1.6">${NO_QR_MESSAGE}</p>`;

// Without a QR, a "present the QR code" paragraph directly above {{qr_code}} would contradict the
// no-QR message, so that one paragraph is dropped. Nothing else in the template changes.
const applyQrCode = (html, imageUrl) => (imageUrl ? html : html.replace(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?\bQR code\b(?:(?!<\/p>)[\s\S])*?<\/p>\s*(?=\{\{qr_code\}\})/gi, ''))
  .split('{{qr_code}}').join(qrCodeBlock(imageUrl));

export const sanitizeEmailPreview = (value) => String(value || '')
  .replace(/<!--([\s\S]*?)-->/g, '')
  .replace(/<\s*(script|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  .replace(/<\s*(script|iframe|object|embed|form|input|button|textarea|select|option|meta|base|link)\b[^>]*\/?\s*>/gi, '')
  .replace(/\s+on[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/\s+(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data\s*:\s*text\/html)[\s\S]*?\2/gi, '');

export const renderEmailTemplate = (template, guest, table, details, qrImageUrl = '') => {
  const values = {
    first_name: firstNameOf(guest?.name || 'Sample Guest'),
    guest_name: guest?.name || 'Sample Guest',
    event_name: details.name || 'the event',
    event_date: details.dateLabel || 'Date to be confirmed',
    start_time: details.startTime || 'See event details',
    venue: details.venue || 'Venue to be confirmed',
    table_number: tableNumberOf(table),
    table_name: tableNumber(table) == null ? 'Table preview' : tableTitle(table),
    table_zone: table?.zone || 'Main floor',
    ticket_name: guest?.ticketName || 'Event ticket'
  };
  const html = Object.entries(values).reduce((output, [key, value]) => output.split(`{{${key}}}`).join(escapeTemplateValue(value)), sanitizeEmailPreview(template || DEFAULT_EMAIL_HTML));
  return applyQrCode(html, qrImageUrl);
};
