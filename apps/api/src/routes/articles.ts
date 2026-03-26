import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { sqlite } from '../db/index.js';
import { approveArticle, rejectArticle, saveArticle } from '../pipeline/publisher.js';
import { rewriteArticle } from '../services/ai-rewriter.js';
import { createHash } from 'node:crypto';

export const articlesRouter = Router();

// GET /api/articles — list published articles
articlesRouter.get('/', (req: Request, res: Response) => {
  const { page = '1', limit = '10', categoria, search } = req.query;
  const pageNum = parseInt(page as string) || 1;
  const limitNum = Math.min(parseInt(limit as string) || 10, 50);
  const offset = (pageNum - 1) * limitNum;

  let query = `SELECT id, titulo, bajada, slug, categoria, tags, published_at, tiempo_lectura, featured_image, views FROM articles WHERE status = 'published'`;
  const params: (string | number)[] = [];

  if (categoria) {
    query += ` AND categoria = ?`;
    params.push(categoria as string);
  }

  if (search) {
    query += ` AND (titulo LIKE ? OR bajada LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ` ORDER BY published_at DESC LIMIT ? OFFSET ?`;
  params.push(limitNum, offset);

  const articles = sqlite.prepare(query).all(...params) as Array<{
    id: string;
    titulo: string;
    bajada: string;
    slug: string;
    categoria: string;
    tags: string;
    published_at: string;
    tiempo_lectura: number;
    featured_image: string;
    views: number;
  }>;

  const total = sqlite.prepare(
    `SELECT COUNT(*) as count FROM articles WHERE status = 'published'${categoria ? ` AND categoria = '${categoria}'` : ''}`
  ).get() as { count: number };

  res.json({
    articles: articles.map(a => ({
      ...a,
      tags: a.tags ? JSON.parse(a.tags) : [],
      featuredImage: a.featured_image ? JSON.parse(a.featured_image) : null,
    })),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: total.count,
      pages: Math.ceil(total.count / limitNum),
    },
  });
});

// GET /api/articles/slug/:slug — get article by slug
articlesRouter.get('/slug/:slug', (req: Request, res: Response) => {
  const article = sqlite.prepare(`
    SELECT * FROM articles WHERE slug = ? AND status = 'published'
  `).get(req.params.slug) as Record<string, unknown> | undefined;

  if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

  // Only count real browser visits (not bots, not API calls without Accept)
  const accept = req.headers['accept'] || '';
  const ua = req.headers['user-agent'] || '';
  const isBot = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|twitterbot/i.test(ua);
  const isBrowser = accept.includes('text/html') || accept.includes('application/json');
  if (!isBot && isBrowser) {
    // Deduplicate: one view per IP per article per day
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress || 'unknown';
    const viewKey = createHash('sha256').update(`${ip}:${req.params.slug}:${new Date().toISOString().split('T')[0]}`).digest('hex');
    const alreadyCounted = sqlite.prepare('SELECT user_id FROM article_reads WHERE user_id = ? AND article_id = ? AND date(read_at) = date(\'now\')').get(viewKey, article.id as string);
    if (!alreadyCounted) {
      sqlite.prepare('UPDATE articles SET views = views + 1 WHERE slug = ?').run(req.params.slug);
      // Record the view (reusing article_reads table with viewKey as pseudo user_id)
      sqlite.prepare('INSERT OR IGNORE INTO article_reads (user_id, article_id) VALUES (?, ?)').run(viewKey, article.id as string);
    }
  }

  res.json({
    ...article,
    tags: article.tags ? JSON.parse(article.tags as string) : [],
    keywords: article.keywords ? JSON.parse(article.keywords as string) : [],
    featured_image: article.featured_image ? JSON.parse(article.featured_image as string) : null,
    embeds: article.embeds ? JSON.parse(article.embeds as string) : [],
    sources: article.sources ? JSON.parse(article.sources as string) : [],
  });
});

// GET /api/articles/featured — get featured (most important) articles
articlesRouter.get('/featured', (_req: Request, res: Response) => {
  const articles = sqlite.prepare(`
    SELECT id, titulo, bajada, slug, categoria, tags, published_at, tiempo_lectura, featured_image, views, importance_score
    FROM articles WHERE status = 'published'
    ORDER BY importance_score DESC, published_at DESC
    LIMIT 5
  `).all() as Array<Record<string, unknown>>;

  res.json(articles.map(a => ({
    ...a,
    tags: a.tags ? JSON.parse(a.tags as string) : [],
    featuredImage: a.featured_image ? JSON.parse(a.featured_image as string) : null,
  })));
});

// GET /api/articles/related/:slug — related articles
articlesRouter.get('/related/:slug', (req: Request, res: Response) => {
  const article = sqlite.prepare('SELECT categoria, tags FROM articles WHERE slug = ?').get(req.params.slug) as {
    categoria: string;
    tags: string;
  } | undefined;

  if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

  const related = sqlite.prepare(`
    SELECT id, titulo, bajada, slug, categoria, published_at, featured_image, views
    FROM articles
    WHERE status = 'published' AND slug != ? AND categoria = ?
    ORDER BY published_at DESC LIMIT 4
  `).all(req.params.slug, article.categoria) as Array<Record<string, unknown>>;

  res.json(related.map(a => ({
    ...a,
    featuredImage: a.featured_image ? JSON.parse(a.featured_image as string) : null,
  })));
});

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET /api/articles/admin/queue — artículos pendientes de revisión manual
articlesRouter.get('/admin/queue', requireAdmin, (_req: Request, res: Response) => {
  const articles = sqlite.prepare(`
    SELECT id, titulo, bajada, slug, categoria, tags, sources,
           created_at, requires_review, review_reason, importance_score
    FROM articles WHERE status = 'pending'
    ORDER BY importance_score DESC, created_at ASC
    LIMIT 100
  `).all() as Array<Record<string, unknown>>;

  res.json(articles.map(a => {
    let datosVerificables: Array<{ dato: string; fuente: string; verificado: boolean }> = [];
    let datosFlag = 0;
    if (a.sources) {
      try {
        const src = JSON.parse(a.sources as string);
        datosVerificables = src.datosVerificables || [];
        datosFlag = datosVerificables.filter((d: { verificado: boolean }) => !d.verificado).length;
      } catch { /* ignore */ }
    }
    return {
      id: a.id,
      titulo: a.titulo,
      bajada: a.bajada,
      slug: a.slug,
      categoria: a.categoria,
      tags: a.tags ? JSON.parse(a.tags as string) : [],
      created_at: a.created_at,
      review_reason: a.review_reason,
      importance_score: a.importance_score,
      datosVerificables,
      datosFlag,
      alertLevel: datosFlag === 0 ? 'ok' : datosFlag <= 2 ? 'warn' : 'danger',
    };
  }));
});

// GET /api/articles/admin/queue_LEGACY — kept for manual override if needed
articlesRouter.get('/admin/queue_legacy', requireAdmin, (_req: Request, res: Response) => {
  const articles = sqlite.prepare(`
    SELECT id, titulo, bajada, cuerpo, slug, categoria, tags, sources,
           created_at, requires_review, review_reason, importance_score
    FROM articles WHERE status = 'pending'
    ORDER BY importance_score DESC, created_at ASC
  `).all() as Array<Record<string, unknown>>;

  res.json(articles.map(a => {
    let datosVerificables: Array<{ dato: string; fuente: string; verificado: boolean }> = [];
    let datosFlag = 0;

    if (a.sources) {
      try {
        const src = JSON.parse(a.sources as string);
        datosVerificables = src.datosVerificables || [];
        datosFlag = datosVerificables.filter((d: { verificado: boolean }) => !d.verificado).length;
      } catch { /* ignore */ }
    }

    return {
      id: a.id,
      titulo: a.titulo,
      bajada: a.bajada,
      slug: a.slug,
      categoria: a.categoria,
      tags: a.tags ? JSON.parse(a.tags as string) : [],
      created_at: a.created_at,
      review_reason: a.review_reason,
      importance_score: a.importance_score,
      // Verification detail for admin UI
      datosVerificables,
      datosFlag,                    // number of unverified data points
      alertLevel: datosFlag === 0   // 'ok' | 'warn' | 'danger'
        ? 'ok'
        : datosFlag <= 2 ? 'warn' : 'danger',
    };
  }));
});

// POST /api/articles/admin/:id/approve
articlesRouter.post('/admin/:id/approve', requireAdmin, (req: Request, res: Response) => {
  const success = approveArticle(req.params.id);
  if (!success) return res.status(404).json({ error: 'Artículo no encontrado o ya procesado' });
  res.json({ success: true, message: 'Artículo aprobado y publicado' });
});

// POST /api/articles/admin/:id/reject
articlesRouter.post('/admin/:id/reject', requireAdmin, (req: Request, res: Response) => {
  const { reason } = req.body;
  const success = rejectArticle(req.params.id, reason);
  if (!success) return res.status(404).json({ error: 'Artículo no encontrado' });
  res.json({ success: true, message: 'Artículo rechazado' });
});

// POST /api/articles/admin/generate — manually trigger AI generation
articlesRouter.post('/admin/generate', requireAdmin, async (req: Request, res: Response) => {
  const { sources, context, autoPublish } = req.body;

  if (!sources || !Array.isArray(sources) || sources.length === 0) {
    return res.status(400).json({ error: 'Se requieren fuentes para generar el artículo' });
  }

  try {
    const generated = await rewriteArticle(sources, context);
    const id = saveArticle({
      ...generated,
      importanceScore: 0.7,
    });

    res.json({ success: true, id, article: generated });
  } catch (error) {
    res.status(500).json({ error: 'Error generando artículo con IA' });
  }
});

// GET /api/articles/admin/stats — dashboard stats
articlesRouter.get('/admin/stats', requireAdmin, (_req: Request, res: Response) => {
  const stats = {
    published: (sqlite.prepare(`SELECT COUNT(*) as c FROM articles WHERE status = 'published'`).get() as { c: number }).c,
    pending: (sqlite.prepare(`SELECT COUNT(*) as c FROM articles WHERE status = 'pending'`).get() as { c: number }).c,
    discarded: (sqlite.prepare(`SELECT COUNT(*) as c FROM pipeline_discards`).get() as { c: number }).c,
    rejected: (sqlite.prepare(`SELECT COUNT(*) as c FROM articles WHERE status = 'rejected'`).get() as { c: number }).c,
    todayPublished: (sqlite.prepare(`SELECT COUNT(*) as c FROM articles WHERE status = 'published' AND date(published_at) = date('now')`).get() as { c: number }).c,
    totalViews: (sqlite.prepare(`SELECT COALESCE(SUM(views), 0) as v FROM articles WHERE status = 'published'`).get() as { v: number }).v,
    categories: sqlite.prepare(`
      SELECT categoria, COUNT(*) as count FROM articles WHERE status = 'published'
      GROUP BY categoria ORDER BY count DESC
    `).all(),
  };

  res.json(stats);
});

// PUT /api/articles/admin/:id — edit article
articlesRouter.put('/admin/:id', requireAdmin, (req: Request, res: Response) => {
  const { titulo, bajada, cuerpo, slug, metaDescription, categoria, tags } = req.body;

  sqlite.prepare(`
    UPDATE articles
    SET titulo = ?, bajada = ?, cuerpo = ?, slug = ?, meta_description = ?,
        categoria = ?, tags = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(titulo, bajada, cuerpo, slug, metaDescription, categoria, JSON.stringify(tags), req.params.id);

  res.json({ success: true });
});
