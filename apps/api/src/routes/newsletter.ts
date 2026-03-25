import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import {
  subscribe, unsubscribe, confirmSubscription,
  getNewsletterStats, sendWeeklyDigest, getActiveSubscriberCount
} from '../services/newsletter.js';

export const newsletterRouter = Router();

// POST /api/newsletter/subscribe
newsletterRouter.post('/subscribe', async (req: Request, res: Response) => {
  const { email, name } = req.body as { email?: string; name?: string };

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email inválido' });
  }

  const result = subscribe(email, name, 'web');

  if (result.alreadyExists) {
    return res.json({ success: true, message: 'Ya estás suscripto' });
  }

  res.json({ success: true, message: '¡Suscripto! Revisá tu casilla para confirmar.' });
});

// GET /api/newsletter/confirm?t=TOKEN
newsletterRouter.get('/confirm', (req: Request, res: Response) => {
  const { t } = req.query as { t?: string };
  if (!t) return res.status(400).json({ error: 'Token requerido' });

  const ok = confirmSubscription(t);
  if (!ok) return res.status(400).json({ error: 'Token inválido o ya confirmado' });

  // Redirect to a thank-you page
  res.redirect(`${process.env.SITE_URL || 'https://desdeeltablon.com'}/newsletter/gracias`);
});

// GET /api/newsletter/unsub?t=TOKEN
newsletterRouter.get('/unsub', (req: Request, res: Response) => {
  const { t } = req.query as { t?: string };
  if (!t) return res.status(400).json({ error: 'Token requerido' });

  const ok = unsubscribe(t);
  if (!ok) return res.status(404).json({ error: 'Token no encontrado' });

  res.redirect(`${process.env.SITE_URL || 'https://desdeeltablon.com'}/newsletter/unsub-ok`);
});

// GET /api/newsletter/open?t=SEND_SUBSCRIBER_ID (tracking pixel)
newsletterRouter.get('/open', (req: Request, res: Response) => {
  // 1x1 transparent GIF
  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache');
  res.send(pixel);
  // TODO: log open event to newsletter_sends if needed
});

// GET /api/newsletter/stats (admin)
newsletterRouter.get('/stats', requireAdmin, (_req: Request, res: Response) => {
  res.json(getNewsletterStats());
});

// POST /api/newsletter/send — desactivado hasta activar el envío
// newsletterRouter.post('/send', async (req: Request, res: Response) => {
//   const result = await sendWeeklyDigest();
//   res.json(result);
// });
