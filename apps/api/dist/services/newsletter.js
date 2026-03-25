/**
 * Newsletter Service — desdeeltablon.com
 * ========================================
 * Sistema completamente interno. No depende de MailerLite ni ninguna
 * plataforma de email marketing externa.
 *
 * Stack:
 *   - Suscriptores: SQLite (tabla newsletter_subscribers)
 *   - Envío:        Resend API (3.000 emails/mes gratis, $20/mes hasta 50k)
 *   - Digest:       Claude genera el contenido semanalmente
 *   - Templates:    HTML propio inline, sin dependencias
 *
 * Flujo semanal automático (viernes 9:00 AM ART):
 *   1. Obtener las mejores notas de la semana (por vistas + categoría)
 *   2. Claude genera el texto editorial del digest
 *   3. Armar el HTML del email con las notas
 *   4. Enviar en lotes de 50 para respetar rate limits
 *   5. Registrar en newsletter_sends
 */
import { sqlite } from '../db/index.js';
import Anthropic from '@anthropic-ai/sdk';
import { MODELS } from '../config/models.js';
import { v4 as uuidv4 } from 'uuid';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.NEWSLETTER_FROM || 'newsletter@desdeeltablon.com';
const SITE_URL = process.env.SITE_URL || 'https://desdeeltablon.com';
// ─── DB init ──────────────────────────────────────────────────────────────────
export function initNewsletterTables() {
    sqlite.exec(`
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id           TEXT PRIMARY KEY,
      email        TEXT UNIQUE NOT NULL,
      name         TEXT,
      status       TEXT DEFAULT 'active',  -- active | unsubscribed | bounced
      source       TEXT DEFAULT 'web',     -- web | import | user_account
      confirmed    INTEGER DEFAULT 0,      -- double opt-in
      confirm_token TEXT,
      unsub_token  TEXT NOT NULL,
      created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
      confirmed_at TEXT,
      unsubbed_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS newsletter_sends (
      id           TEXT PRIMARY KEY,
      subject      TEXT NOT NULL,
      sent_at      TEXT DEFAULT CURRENT_TIMESTAMP,
      recipient_count INTEGER DEFAULT 0,
      open_count   INTEGER DEFAULT 0,       -- tracked via pixel
      click_count  INTEGER DEFAULT 0,
      bounce_count INTEGER DEFAULT 0,
      status       TEXT DEFAULT 'sent'      -- sending | sent | failed
    );

    CREATE INDEX IF NOT EXISTS idx_subscribers_status
      ON newsletter_subscribers(status);
    CREATE INDEX IF NOT EXISTS idx_subscribers_email
      ON newsletter_subscribers(email);
  `);
}
// ─── Subscriber management ────────────────────────────────────────────────────
export function subscribe(email, name, source = 'web') {
    const existing = sqlite.prepare('SELECT id, status FROM newsletter_subscribers WHERE email = ?').get(email);
    if (existing) {
        if (existing.status === 'active')
            return { success: true, alreadyExists: true };
        // Reactivate
        sqlite.prepare("UPDATE newsletter_subscribers SET status='active', unsubbed_at=NULL WHERE id=?").run(existing.id);
        return { success: true };
    }
    const id = uuidv4();
    const confirmToken = uuidv4().replace(/-/g, '');
    const unsubToken = uuidv4().replace(/-/g, '');
    sqlite.prepare(`
    INSERT INTO newsletter_subscribers
      (id, email, name, source, confirmed, confirm_token, unsub_token)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, email.toLowerCase().trim(), name || null, source, confirmToken, unsubToken);
    // confirmed=1 by default (single opt-in). Change to 0 for double opt-in.
    return { success: true, confirmToken };
}
export function unsubscribe(token) {
    const r = sqlite.prepare(`
    UPDATE newsletter_subscribers
    SET status='unsubscribed', unsubbed_at=CURRENT_TIMESTAMP
    WHERE unsub_token = ? AND status = 'active'
  `).run(token);
    return r.changes > 0;
}
export function confirmSubscription(token) {
    const r = sqlite.prepare(`
    UPDATE newsletter_subscribers
    SET confirmed=1, confirmed_at=CURRENT_TIMESTAMP
    WHERE confirm_token=? AND confirmed=0
  `).run(token);
    return r.changes > 0;
}
export function getActiveSubscriberCount() {
    return sqlite.prepare("SELECT COUNT(*) as c FROM newsletter_subscribers WHERE status='active' AND confirmed=1").get().c;
}
function getActiveSubscribers() {
    return sqlite.prepare("SELECT id, email, name, unsub_token FROM newsletter_subscribers WHERE status='active' AND confirmed=1 ORDER BY created_at ASC").all();
}
// ─── Get best articles of the week ───────────────────────────────────────────
function getWeeklyTopArticles(limit = 6) {
    return sqlite.prepare(`
    SELECT id, titulo, bajada, slug, categoria, views, published_at
    FROM articles
    WHERE status = 'published'
      AND date(published_at) >= date('now', '-7 days')
    ORDER BY
      (views * 0.6) +
      (CASE categoria
        WHEN 'analisis'   THEN 40
        WHEN 'historia'   THEN 30
        WHEN 'actualidad' THEN 20
        WHEN 'mercado'    THEN 25
        ELSE 10
      END) DESC
    LIMIT ?
  `).all(limit);
}
// ─── Claude generates the editorial intro ────────────────────────────────────
async function generateDigestIntro(articles) {
    const articleList = articles.map((a, i) => `${i + 1}. [${a.categoria.toUpperCase()}] ${a.titulo} — ${a.bajada.substring(0, 100)}`).join('\n');
    const response = await anthropic.messages.create({
        model: MODELS.writer,
        max_tokens: 600,
        messages: [{
                role: 'user',
                content: `Escribí la introducción editorial para el newsletter semanal de desdeeltablon.com.
Debe ser cálida, periodística, en español rioplatense. Máximo 3 párrafos cortos (200 palabras total).
Hacé referencia al tono de la semana en River sin spoilear los artículos.
NO uses saludos formales ni "estimado suscriptor". Arrancá directo con algo interesante de la semana.

Notas de esta semana:
${articleList}

Devolvé SOLO el texto plano con párrafos separados por doble salto de línea. Sin HTML ni markdown.`,
            }],
    });
    return response.content[0].text.trim();
}
// ─── Build HTML email ─────────────────────────────────────────────────────────
const CAT_COLORS = {
    actualidad: '#DC2626',
    analisis: '#2563EB',
    historia: '#D97706',
    mercado: '#16A34A',
    inferiores: '#9333EA',
};
function buildEmailHTML(intro, articles, unsubToken, subscriberName) {
    const greeting = subscriberName ? `Hola ${subscriberName},` : 'Hola,';
    const unsubUrl = `${SITE_URL}/newsletter/unsub?t=${unsubToken}`;
    const weekStr = new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });
    const articlesHTML = articles.map(a => {
        const catColor = CAT_COLORS[a.categoria] || '#666';
        const catLabel = a.categoria.charAt(0).toUpperCase() + a.categoria.slice(1);
        const url = `${SITE_URL}/noticias/${a.slug}?utm_source=newsletter&utm_medium=email&utm_campaign=weekly`;
        return `
      <tr>
        <td style="padding: 0 0 24px 0;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-bottom: 6px;">
                <span style="display:inline-block; background:${catColor}18; color:${catColor};
                  border:1px solid ${catColor}40; font-size:10px; font-weight:700;
                  letter-spacing:0.08em; text-transform:uppercase;
                  padding:2px 8px; border-radius:3px; font-family:Arial,sans-serif;">
                  ${catLabel}
                </span>
              </td>
            </tr>
            <tr>
              <td>
                <a href="${url}" style="text-decoration:none;">
                  <p style="margin:0 0 6px; font-family:Georgia,'Times New Roman',serif;
                    font-size:18px; font-weight:700; color:#111; line-height:1.3;">
                    ${a.titulo}
                  </p>
                </a>
              </td>
            </tr>
            <tr>
              <td>
                <p style="margin:0 0 10px; font-family:Georgia,'Times New Roman',serif;
                  font-size:14px; color:#555; line-height:1.6; font-style:italic;">
                  ${a.bajada}
                </p>
              </td>
            </tr>
            <tr>
              <td>
                <a href="${url}"
                  style="display:inline-block; font-family:Arial,sans-serif;
                    font-size:13px; font-weight:600; color:#DC2626;
                    text-decoration:none; border-bottom:1px solid #DC262640;">
                  Leer nota completa →
                </a>
              </td>
            </tr>
          </table>
          <hr style="margin:24px 0 0; border:none; border-top:1px solid #F0EDE8;" />
        </td>
      </tr>`;
    }).join('');
    const introHTML = intro.split('\n\n').map(p => `<p style="margin:0 0 14px; font-family:Georgia,'Times New Roman',serif;
      font-size:15px; color:#333; line-height:1.75;">${p}</p>`).join('');
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Desde el Tablón · Newsletter semanal</title>
</head>
<body style="margin:0; padding:0; background:#F7F4F0; font-family:Arial,sans-serif;">
  <!-- Tracking pixel -->
  <img src="${SITE_URL}/api/newsletter/open?t=SEND_ID" width="1" height="1" style="display:none" alt="" />

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7F4F0;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0"
          style="max-width:600px; width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:#B91C1C; padding:20px 32px; border-radius:8px 8px 0 0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <span style="font-family:Georgia,'Times New Roman',serif;
                      font-size:22px; font-weight:700; color:white; letter-spacing:-0.02em;">
                      Desde el Tablón
                    </span>
                    <p style="margin:3px 0 0; font-family:Arial,sans-serif;
                      font-size:11px; color:rgba(255,255,255,0.65);
                      letter-spacing:0.1em; text-transform:uppercase;">
                      River con memoria
                    </p>
                  </td>
                  <td align="right">
                    <p style="margin:0; font-family:Arial,sans-serif;
                      font-size:11px; color:rgba(255,255,255,0.55);">
                      Semana del ${weekStr}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:white; padding:32px; border-radius:0 0 8px 8px;">

              <!-- Greeting -->
              <p style="margin:0 0 6px; font-family:Arial,sans-serif;
                font-size:13px; color:#999;">${greeting}</p>

              <!-- Editorial intro -->
              <div style="margin-bottom:28px; padding-bottom:24px;
                border-bottom:2px solid #F0EDE8;">
                ${introHTML}
              </div>

              <!-- Section label -->
              <p style="margin:0 0 20px; font-family:Arial,sans-serif;
                font-size:11px; font-weight:700; color:#999;
                letter-spacing:0.12em; text-transform:uppercase;">
                Las notas de la semana
              </p>

              <!-- Articles -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                ${articlesHTML}
              </table>

              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="margin:8px 0 28px; background:#FEF2F2;
                  border:1px solid #FECACA; border-radius:6px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="margin:0 0 10px; font-family:Georgia,'Times New Roman',serif;
                      font-size:14px; color:#333;">
                      ¿Querés leer análisis más profundos cada semana?
                      Las notas del sitio son más largas que el newsletter.
                    </p>
                    <a href="${SITE_URL}?utm_source=newsletter&utm_medium=email&utm_campaign=cta"
                      style="display:inline-block; background:#DC2626; color:white;
                        font-family:Arial,sans-serif; font-size:13px; font-weight:700;
                        padding:9px 20px; border-radius:5px; text-decoration:none;">
                      Ir al sitio completo →
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 0; text-align:center;">
              <p style="margin:0 0 6px; font-family:Arial,sans-serif;
                font-size:11px; color:#AAA; line-height:1.6;">
                Desde el Tablón · Periodismo independiente sobre River Plate<br />
                No afiliado al Club Atlético River Plate
              </p>
              <p style="margin:0; font-family:Arial,sans-serif; font-size:11px;">
                <a href="${unsubUrl}" style="color:#AAA; text-decoration:underline;">
                  Desuscribirse
                </a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
// ─── Send via Resend ──────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
    if (!RESEND_API_KEY) {
        console.warn('RESEND_API_KEY no configurada — email no enviado');
        return false;
    }
    try {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: `Desde el Tablón <${FROM_EMAIL}>`,
                to: [to],
                subject,
                html,
            }),
        });
        if (!r.ok) {
            const err = await r.text();
            console.error(`Resend error para ${to}: ${err}`);
            return false;
        }
        return true;
    }
    catch (err) {
        console.error(`Error enviando a ${to}:`, err);
        return false;
    }
}
// ─── Main: send weekly digest ─────────────────────────────────────────────────
export async function sendWeeklyDigest() {
    const subscribers = getActiveSubscribers();
    if (subscribers.length === 0) {
        console.log('Newsletter: sin suscriptores activos');
        return { sent: 0, failed: 0, skipped: true };
    }
    const articles = getWeeklyTopArticles(6);
    if (articles.length < 2) {
        console.log('Newsletter: menos de 2 notas esta semana, no se envía');
        return { sent: 0, failed: 0, skipped: true };
    }
    console.log(`📬 Generando digest semanal — ${subscribers.length} suscriptores, ${articles.length} notas...`);
    // Generate editorial intro with Claude
    const intro = await generateDigestIntro(articles);
    // Create send record
    const sendId = uuidv4();
    const subject = `River esta semana: ${articles[0].titulo.substring(0, 45)}…`;
    sqlite.prepare(`
    INSERT INTO newsletter_sends (id, subject, recipient_count, status)
    VALUES (?, ?, ?, 'sending')
  `).run(sendId, subject, subscribers.length);
    let sent = 0;
    let failed = 0;
    const BATCH_SIZE = 50;
    const BATCH_DELAY_MS = 1100; // Resend free tier: 2 req/sec, 50/min
    for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
        const batch = subscribers.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (sub) => {
            const html = buildEmailHTML(intro, articles, sub.unsub_token, sub.name)
                .replace('SEND_ID', `${sendId}_${sub.id}`); // tracking pixel per subscriber
            const ok = await sendEmail(sub.email, subject, html);
            if (ok)
                sent++;
            else
                failed++;
        }));
        // Rate limit pause between batches
        if (i + BATCH_SIZE < subscribers.length) {
            await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        }
    }
    sqlite.prepare(`
    UPDATE newsletter_sends SET status='sent', recipient_count=? WHERE id=?
  `).run(sent, sendId);
    console.log(`📬 Newsletter enviado: ${sent} ok / ${failed} fallidos`);
    return { sent, failed, skipped: false };
}
// ─── Confirmation email ───────────────────────────────────────────────────────
export async function sendConfirmationEmail(email, token) {
    const confirmUrl = `${SITE_URL}/newsletter/confirm?t=${token}`;
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:32px;background:#F7F4F0;font-family:Arial,sans-serif;">
  <table width="500" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;background:white;border-radius:8px;padding:32px;">
    <tr><td>
      <p style="margin:0 0 6px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#B91C1C;">Desde el Tablón</p>
      <p style="font-family:Georgia,serif;font-size:16px;color:#333;line-height:1.7;margin:16px 0;">
        Confirmá tu suscripción al newsletter semanal de desdeeltablon.com.
        Cada viernes te llegan las mejores notas de la semana sobre River.
      </p>
      <a href="${confirmUrl}" style="display:inline-block;background:#DC2626;color:white;
        font-family:Arial,sans-serif;font-size:14px;font-weight:700;
        padding:12px 24px;border-radius:5px;text-decoration:none;margin:8px 0 20px;">
        Confirmar suscripción
      </a>
      <p style="font-size:12px;color:#999;font-family:Arial,sans-serif;">
        Si no te suscribiste, ignorá este email. Sin clics, sin cambios.
      </p>
    </td></tr>
  </table>
</body></html>`;
    await sendEmail(email, 'Confirmá tu suscripción a Desde el Tablón', html);
}
// ─── Stats ────────────────────────────────────────────────────────────────────
export function getNewsletterStats() {
    return {
        active: sqlite.prepare("SELECT COUNT(*) as c FROM newsletter_subscribers WHERE status='active' AND confirmed=1").get().c,
        unconfirmed: sqlite.prepare("SELECT COUNT(*) as c FROM newsletter_subscribers WHERE confirmed=0").get().c,
        unsubscribed: sqlite.prepare("SELECT COUNT(*) as c FROM newsletter_subscribers WHERE status='unsubscribed'").get().c,
        lastSend: sqlite.prepare("SELECT subject, sent_at, recipient_count FROM newsletter_sends ORDER BY sent_at DESC LIMIT 1").get(),
        totalSends: sqlite.prepare("SELECT COUNT(*) as c FROM newsletter_sends WHERE status='sent'").get().c,
    };
}
