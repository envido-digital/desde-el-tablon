import { createHash } from 'crypto';
import { sqlite } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
// River Plate keywords for relevance scoring
const PRIMARY_KEYWORDS = ['river plate', 'river', 'millonario', 'millo'];
const SECONDARY_KEYWORDS = ['gallardo', 'monumental', 'libertadores', 'superclásico', 'boca', 'apertura', 'clausura', 'copa'];
const PLAYER_KEYWORDS = ['echeverri', 'colidio', 'montiel', 'de la cruz', 'borré', 'armani', 'aliendro', 'solari'];
export function calculateRelevanceScore(title, excerpt) {
    const text = `${title} ${excerpt}`.toLowerCase();
    let score = 0;
    for (const kw of PRIMARY_KEYWORDS) {
        if (text.includes(kw))
            score += 0.4;
    }
    for (const kw of SECONDARY_KEYWORDS) {
        if (text.includes(kw))
            score += 0.15;
    }
    for (const kw of PLAYER_KEYWORDS) {
        if (text.includes(kw))
            score += 0.2;
    }
    return Math.min(score, 1.0);
}
export function normalizeTitle(title) {
    return title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
export function hashTitle(title) {
    return createHash('sha256').update(normalizeTitle(title)).digest('hex');
}
export function isDuplicate(titleHash) {
    const existing = sqlite.prepare('SELECT id FROM scraped_items WHERE title_hash = ? AND scraped_at > datetime(\'now\', \'-24 hours\')').get(titleHash);
    return !!existing;
}
export function saveScrapedItem(item) {
    const titleHash = hashTitle(item.title);
    if (isDuplicate(titleHash)) {
        return null; // Already processed
    }
    const id = uuidv4();
    sqlite.prepare(`
    INSERT OR IGNORE INTO scraped_items (id, source_id, url, title_hash, raw_data, processed)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(id, item.sourceId, item.url, titleHash, JSON.stringify(item));
    return id;
}
// RSS-based scraper (more reliable than HTML scraping for news)
export async function scrapeRSS(sourceId, rssUrl) {
    try {
        // Dynamic import to avoid issues
        const Parser = (await import('rss-parser')).default;
        const parser = new Parser({
            timeout: 10000,
            headers: { 'User-Agent': 'Desde el Tablón Bot/1.0' }
        });
        const feed = await parser.parseURL(rssUrl);
        const items = [];
        for (const item of (feed.items || []).slice(0, 20)) {
            const title = item.title || '';
            const excerpt = item.contentSnippet || item.summary || '';
            const url = item.link || '';
            const publishedAt = item.pubDate || item.isoDate;
            const relevance = calculateRelevanceScore(title, excerpt);
            if (relevance < 0.3)
                continue; // Skip irrelevant items
            items.push({
                source: sourceId,
                title,
                excerpt: excerpt.substring(0, 500),
                url,
                publishedAt,
            });
        }
        // Update last scraped
        sqlite.prepare('UPDATE news_sources SET last_scraped = CURRENT_TIMESTAMP, scrape_count = scrape_count + 1 WHERE id = ?')
            .run(sourceId);
        return items;
    }
    catch (error) {
        console.error(`Error scraping RSS ${rssUrl}:`, error);
        sqlite.prepare('UPDATE news_sources SET error_count = error_count + 1 WHERE id = ?').run(sourceId);
        return [];
    }
}
// Fetch news via simple HTTP (for sites with JSON APIs)
export async function fetchNewsFromSource(sourceId, url) {
    // RSS feeds for major Argentine sports media
    const RSS_FEEDS = {
        'ole': 'https://www.ole.com.ar/rss/river.xml',
        'tycsports': 'https://www.tycsports.com/rss/football.xml',
        'infobae': 'https://www.infobae.com/feeds/rss/deportes.xml',
        'carp-oficial': 'https://www.cariverplate.com.ar/noticias',
        'afa': 'https://www.afa.com.ar/feeds/noticias.rss',
    };
    const rssUrl = RSS_FEEDS[sourceId];
    if (rssUrl) {
        return scrapeRSS(sourceId, rssUrl);
    }
    // Fallback: return empty (would implement HTML scraping with Playwright in production)
    return [];
}
// Main function to scrape all active sources
export async function scrapeAllSources() {
    const sources = sqlite.prepare('SELECT * FROM news_sources WHERE active = 1 ORDER BY level ASC').all();
    const allItems = [];
    for (const source of sources) {
        try {
            const items = await fetchNewsFromSource(source.id, source.url);
            for (const item of items) {
                const savedId = saveScrapedItem({ ...item, sourceId: source.id });
                if (savedId) {
                    allItems.push(item);
                }
            }
            // Rate limiting: wait between sources
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        catch (error) {
            console.error(`Error processing source ${source.id}:`, error);
        }
    }
    return allItems;
}
// Get unprocessed items grouped for AI rewriting
export function getUnprocessedItems(limit = 10) {
    const raw = sqlite.prepare(`
    SELECT si.*, ns.level as source_level
    FROM scraped_items si
    JOIN news_sources ns ON si.source_id = ns.id
    WHERE si.processed = 0
    ORDER BY ns.level ASC, si.scraped_at ASC
    LIMIT ?
  `).all(limit);
    // Group similar items (same event, multiple sources)
    const grouped = new Map();
    for (const row of raw) {
        try {
            const item = JSON.parse(row.raw_data);
            const normalTitle = normalizeTitle(item.title).split(' ').slice(0, 5).join(' ');
            if (!grouped.has(normalTitle)) {
                grouped.set(normalTitle, { items: [], sourceLevel: row.source_level, ids: [] });
            }
            grouped.get(normalTitle).items.push(item);
            grouped.get(normalTitle).ids.push(row.id);
        }
        catch { /* skip malformed */ }
    }
    return Array.from(grouped.values()).map(g => ({
        items: g.items,
        sourceLevel: g.sourceLevel,
    }));
}
export function markItemsProcessed(articleId, titleHashes) {
    const placeholders = titleHashes.map(() => '?').join(',');
    sqlite.prepare(`
    UPDATE scraped_items SET processed = 1, article_id = ?
    WHERE title_hash IN (${placeholders})
  `).run(articleId, ...titleHashes);
}
