import { v4 as uuidv4 } from 'uuid';
import { sqlite } from '../db/index.js';
import { scrapeAllSources, getUnprocessedItems, markItemsProcessed, hashTitle } from '../services/scraper.js';
import { rewriteArticle, generateHistoricalNote, initDiscardLog, type RawArticle, type MatchFacts, type TransferFacts } from '../services/ai-rewriter.js';
import { findFeaturedImage } from '../services/media.js';
import { linkArticleToPlayers } from '../services/players.js';

export interface PublishOptions {
  importanceScoreThreshold?: number;
}

export function initPublisher() {
  initDiscardLog();
}

export function saveArticle(data: {
  titulo: string; bajada: string; cuerpo: string; slug: string;
  metaDescription: string; tags: string[]; categoria: string;
  tiempoLectura: number; keywords: string[];
  datosVerificables?: Array<{ dato: string; fuente: string; verificado: boolean }>;
  pipelineAudit?: Record<string, unknown>;
  sources?: RawArticle[];
  featuredImage?: object | null;
  importanceScore?: number;
}): string {
  const id = uuidv4();
  let slug = data.slug;
  if (sqlite.prepare('SELECT id FROM articles WHERE slug = ?').get(slug)) {
    slug = `${slug}-${Date.now()}`;
  }

  sqlite.prepare(`
    INSERT INTO articles (
      id, titulo, bajada, cuerpo, slug, meta_description, categoria,
      tags, keywords, status, importance_score, tiempo_lectura,
      featured_image, sources, author_id, requires_review, review_reason,
      published_at, views
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, 'ai-system', 0, null,
      CURRENT_TIMESTAMP, 0)
  `).run(
    id, data.titulo, data.bajada, data.cuerpo, slug, data.metaDescription, data.categoria,
    JSON.stringify(data.tags), JSON.stringify(data.keywords),
    data.importanceScore || 0.5, data.tiempoLectura,
    data.featuredImage ? JSON.stringify(data.featuredImage) : null,
    JSON.stringify({
      original: data.sources,
      datosVerificables: data.datosVerificables || [],
      pipelineAudit: data.pipelineAudit || {},
    }),
  );

  const audit = data.pipelineAudit as { writerAttempts?: number; verifierNotes?: string } | undefined;
  const attempts = audit?.writerAttempts || 1;
  console.log(`✅ Publicado: "${data.titulo.substring(0, 50)}" (${attempts > 1 ? `${attempts} intentos` : 'primer intento'})`);
  return id;
}

// Approve/reject kept for manual override if ever needed via admin
export function approveArticle(id: string): boolean {
  return (sqlite.prepare("UPDATE articles SET status='published', published_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(id)).changes > 0;
}
export function rejectArticle(id: string, reason?: string): boolean {
  return (sqlite.prepare("UPDATE articles SET status='rejected', review_reason=? WHERE id=? AND status='pending'").run(reason||'Rechazado', id)).changes > 0;
}

function calcImportance(sourceLevel: number, itemCount: number): number {
  return Math.min(0.5 + (sourceLevel===1?0.3:sourceLevel===2?0.15:0) + (itemCount>=3?0.2:0) + (itemCount>=5?0.1:0), 1.0);
}

// ─── Main pipeline — fully autonomous ────────────────────────────────────────
export async function runPipeline(options: PublishOptions = {}): Promise<{
  scraped: number; published: number; discarded: number; errors: number;
}> {
  const stats = { scraped: 0, published: 0, discarded: 0, errors: 0 };

  try {
    const newItems = await scrapeAllSources();
    stats.scraped = newItems.length;
    if (!newItems.length) return stats;

    const groups = getUnprocessedItems(5);

    for (const group of groups) {
      try {
        const rawArticles: RawArticle[] = group.items.map(item => ({
          source: item.source,
          level: group.sourceLevel as 1 | 2 | 3,
          title: item.title,
          excerpt: item.excerpt,
          url: item.url,
          publishedAt: item.publishedAt,
        }));

        console.log(`🤖 "${rawArticles[0].title.substring(0, 50)}..."`);

        // Fully autonomous: write → verify → publish OR discard
        const generated = await rewriteArticle(rawArticles);

        if (!generated) {
          // Verifier discarded — reason is in pipeline_discards table
          markItemsProcessed('discarded', rawArticles.map(a => hashTitle(a.title)));
          stats.discarded++;
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        const featuredImage = await findFeaturedImage(
          generated.keywords,
          rawArticles[0]?.url,   // URL del artículo fuente principal
        );
        const importanceScore = calcImportance(group.sourceLevel, group.items.length);

        const articleId = saveArticle({
          ...generated,
          sources: rawArticles,
          featuredImage,
          importanceScore,
          pipelineAudit: generated.pipelineAudit,
          datosVerificables: generated.datosVerificables,
        });

        markItemsProcessed(articleId, rawArticles.map(a => hashTitle(a.title)));

        // Auto-detect player profiles
        const body = generated.cuerpo.replace(/<[^>]*>/g, ' ');
        linkArticleToPlayers(articleId, generated.titulo, body).catch(console.error);

        stats.published++;
        await new Promise(r => setTimeout(r, 3000));

      } catch (err) {
        console.error('Error en grupo:', err);
        stats.errors++;
      }
    }

  } catch (err) {
    console.error('Error en pipeline:', err);
    stats.errors++;
  }

  console.log(`Pipeline: scraped ${stats.scraped} | publicados ${stats.published} | descartados ${stats.discarded} | errores ${stats.errors}`);
  return stats;
}

// ─── Daily historical note ────────────────────────────────────────────────────
export async function generateDailyHistoricalNote(): Promise<string | null> {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  if (sqlite.prepare("SELECT id FROM articles WHERE categoria='historia' AND date(published_at)=? AND status='published'").get(todayStr)) return null;

  const dayMonth = `${today.getDate()} de ${today.toLocaleString('es-AR', { month: 'long' })}`;
  const generated = await generateHistoricalNote(dayMonth);
  if (!generated) return null;

  return saveArticle({ ...generated, importanceScore: 0.6, pipelineAudit: generated.pipelineAudit });
}

// ─── Match analysis ───────────────────────────────────────────────────────────
export async function generateMatchAnalysis(matchFacts: MatchFacts): Promise<string | null> {
  const { generateTacticalAnalysis } = await import('../services/ai-rewriter.js');
  const generated = await generateTacticalAnalysis(matchFacts);
  if (!generated) return null;
  return saveArticle({ ...generated, importanceScore: 0.85, pipelineAudit: generated.pipelineAudit });
}

// ─── Transfer news ────────────────────────────────────────────────────────────
export async function generateTransferNews(transferFacts: TransferFacts): Promise<string | null> {
  const { generateTransferArticle } = await import('../services/ai-rewriter.js');
  const generated = await generateTransferArticle(transferFacts);
  if (!generated) return null;

  const id = saveArticle({ ...generated, importanceScore: 0.9, pipelineAudit: generated.pipelineAudit });

  const { handleTransfer } = await import('../services/players.js');
  await handleTransfer({
    playerName: transferFacts.player,
    type: transferFacts.type === 'incorporacion' ? 'in' : 'out',
    status: transferFacts.confirmationLevel === 1 ? 'confirmed' : 'rumor',
    note: `${transferFacts.fromClub||''} → ${transferFacts.toClub||''}`.trim(),
    articleId: id,
  });

  return id;
}
