/**
 * server/config/email.js — transactional email via Resend.
 *
 * We send verification emails from our OWN domain (verificacion@mercaticocr.com)
 * through Resend instead of relying on Firebase's default sender. Firebase's
 * generic noreply@…firebaseapp.com address has poor reputation and routinely
 * lands in spam; sending from our SPF/DKIM-verified domain dramatically improves
 * inbox placement.
 *
 * Uses Resend's REST API via global fetch (Node 18+) — no extra dependency.
 *
 * Required env: RESEND_API_KEY
 * Optional env: RESEND_FROM  (default 'MercaTico <verificacion@mercaticocr.com>')
 *               SITE_URL     (default 'https://www.mercaticocr.com')
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM     = process.env.RESEND_FROM || 'MercaTico <verificacion@mercaticocr.com>';

/** True when a Resend API key is configured. Callers fall back to Firebase's
 *  built-in email sending when this is false. */
function isConfigured() {
  return !!RESEND_API_KEY;
}

/** Low-level send. Throws on any non-2xx so callers can fall back. */
async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('Resend ' + res.status + ': ' + detail.slice(0, 300));
  }
  return res.json();
}

/** Branded, mostly-text Spanish HTML for the verification email. One clear
 *  button + a plain-text fallback URL keeps spam filters happy. */
function verificationEmailHtml(link) {
  const safeLink = String(link).replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:0;background:#0d0d0d;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d0d;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#161616;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:28px 28px 8px;">
          <h1 style="margin:0;color:#e8c97a;font-size:22px;">MercaTico</h1>
        </td></tr>
        <tr><td style="padding:8px 28px 0;">
          <h2 style="margin:0 0 12px;color:#ffffff;font-size:19px;">Verificá tu correo</h2>
          <p style="margin:0 0 20px;color:#cccccc;font-size:15px;line-height:1.6;">
            ¡Gracias por registrarte! Hacé clic en el botón para activar tu cuenta y empezar a comprar y vender en Costa Rica.
          </p>
        </td></tr>
        <tr><td align="center" style="padding:4px 28px 24px;">
          <a href="${safeLink}" style="display:inline-block;background:#e8c97a;color:#1a1a1a;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 28px;border-radius:8px;">
            Verificar mi correo
          </a>
        </td></tr>
        <tr><td style="padding:0 28px 24px;">
          <p style="margin:0 0 6px;color:#888888;font-size:13px;line-height:1.6;">
            Si el botón no funciona, copiá y pegá este enlace en tu navegador:
          </p>
          <p style="margin:0;color:#e8c97a;font-size:12px;word-break:break-all;">${safeLink}</p>
        </td></tr>
        <tr><td style="padding:16px 28px 28px;border-top:1px solid #2a2a2a;">
          <p style="margin:0;color:#666666;font-size:12px;line-height:1.6;">
            Si no creaste esta cuenta, podés ignorar este correo.<br>
            © 2026 MercaTico. Todos los derechos reservados.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Send the verification email to `to` containing `link`. */
async function sendVerificationEmail(to, link) {
  return sendEmail({
    to,
    subject: 'Verificá tu correo — MercaTico',
    html: verificationEmailHtml(link),
  });
}

module.exports = { isConfigured, sendEmail, sendVerificationEmail };
