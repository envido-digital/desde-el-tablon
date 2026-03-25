/**
 * Player Profile Service — desdeeltablon.com
 * ============================================
 * Los perfiles de jugadores NO se crean manualmente.
 * Se generan y actualizan automáticamente de dos maneras:
 *
 * 1. DETECCIÓN: cuando el AI rewriter genera una nota, extrae los nombres
 *    de jugadores mencionados. Si alguno no tiene perfil → crea un stub.
 *
 * 2. ENRIQUECIMIENTO: el stub inicial es básico. Una tarea nocturna lo
 *    enriquece con datos de Sofascore/Transfermarkt y más contexto de Claude.
 *
 * 3. MERCADO: cuando se confirma una incorporación o salida, el sistema
 *    actualiza automáticamente el perfil (nuevo club, nuevo estado).
 *
 * Tabla en SQLite:
 *   players (id, slug, name, status, position, number, age, nationality,
 *            bio, comparison, stats_json, titles_json, hist_link,
 *            article_mentions, transfer_status, created_at, updated_at)
 */
import { sqlite } from '../db/index.js';
import Anthropic from '@anthropic-ai/sdk';
import { MODELS } from '../config/models.js';
import { v4 as uuidv4 } from 'uuid';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// ─── DB init ──────────────────────────────────────────────────────────────────
export function initPlayersTable() {
    sqlite.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id               TEXT PRIMARY KEY,
      slug             TEXT UNIQUE NOT NULL,
      name             TEXT NOT NULL,
      status           TEXT DEFAULT 'active',   -- active | sold | loaned | retired
      position         TEXT,
      number           INTEGER,
      age              INTEGER,
      nationality      TEXT,
      bio              TEXT,
      comparison       TEXT,                     -- historical comparison
      stats_json       TEXT,                     -- JSON: [[label, value], ...]
      titles_json      TEXT,                     -- JSON: [title, ...]
      hist_link        TEXT,                     -- lahistoriariver.com/jugadores/...
      article_mentions TEXT DEFAULT '[]',        -- JSON: [articleId, ...]
      transfer_status  TEXT,                     -- 'rumor' | 'confirmed_in' | 'confirmed_out' | null
      transfer_note    TEXT,                     -- e.g. "Negociación con Atlético Madrid"
      enriched         INTEGER DEFAULT 0,        -- 0 = stub, 1 = full profile
      created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at       TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_players_slug ON players(slug);
    CREATE INDEX IF NOT EXISTS idx_players_status ON players(status);
  `);
}
// ─── Slug generation ──────────────────────────────────────────────────────────
function toSlug(name) {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // remove accents
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .trim();
}
// ─── Extract player names from article text using Claude ──────────────────────
export async function extractPlayerMentions(articleText) {
    try {
        const response = await anthropic.messages.create({
            model: MODELS.utility,
            max_tokens: 500,
            system: `Extraés nombres de jugadores de River Plate de un texto periodístico.
Devolvés SOLO un JSON válido sin markdown: {"players": ["Nombre Completo", ...]}
Solo jugadores actuales o recientes de River Plate. Sin entrenadores, árbitros, ni rivales.
Si no hay ninguno: {"players": []}`,
            messages: [{ role: 'user', content: articleText.substring(0, 2000) }],
        });
        const text = response.content[0].text.trim();
        const clean = text.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(clean);
        return parsed.players.map(name => ({
            name,
            slug: toSlug(name),
        }));
    }
    catch {
        return [];
    }
}
// ─── Generate a player stub from just a name ─────────────────────────────────
// Called the first time a player is mentioned in an article.
// The stub is minimal but has enough structure to show a profile page.
export async function generatePlayerStub(playerName, articleContext // the article where they were first mentioned
) {
    try {
        const prompt = `Generá un perfil básico de ${playerName}, jugador de River Plate, para el sitio desdeeltablon.com.
${articleContext ? `Contexto: fue mencionado en una nota sobre: "${articleContext.substring(0, 200)}"` : ''}

Respondé SOLO con JSON válido (sin backticks):
{
  "position": "posición principal y secundaria",
  "age": número o null,
  "nationality": "país",
  "bio": "2-3 oraciones breves sobre el jugador y su rol en River",
  "comparison": "una oración comparándolo con un jugador histórico de River si aplica, o null",
  "stats": [["label", "valor"], ...],
  "titles": ["título 1", "título 2"],
  "histNote": "dato histórico breve relevante o null"
}

Si no conocés al jugador con certeza, dejá los campos en null. NO inventés datos.`;
        const response = await anthropic.messages.create({
            model: MODELS.utility,
            max_tokens: 800,
            messages: [{ role: 'user', content: prompt }],
        });
        const text = response.content[0].text.trim();
        const clean = text.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(clean);
        const id = uuidv4();
        const slug = toSlug(playerName);
        // Check if slug already exists
        const existing = sqlite.prepare('SELECT id FROM players WHERE slug = ?').get(slug);
        if (existing)
            return existing.id;
        const histLink = `lahistoriariver.com/jugadores/${slug.replace(/-/g, '')}`;
        sqlite.prepare(`
      INSERT OR IGNORE INTO players
        (id, slug, name, position, age, nationality, bio, comparison,
         stats_json, titles_json, hist_link, article_mentions,
         transfer_status, enriched)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', null, 0)
    `).run(id, slug, playerName, data.position, data.age, data.nationality, data.bio, data.comparison, JSON.stringify(data.stats || []), JSON.stringify(data.titles || []), histLink);
        console.log(`👤 Perfil creado: ${playerName} (stub)`);
        return id;
    }
    catch (err) {
        console.error(`Error generando perfil para ${playerName}:`, err);
        return null;
    }
}
// ─── Link article to player and create stub if needed ────────────────────────
export async function linkArticleToPlayers(articleId, articleTitle, articleText) {
    const mentions = await extractPlayerMentions(articleText);
    const linkedIds = [];
    for (const { name, slug } of mentions) {
        // Check if player profile exists
        let player = sqlite.prepare('SELECT id, article_mentions FROM players WHERE slug = ?').get(slug);
        if (!player) {
            // Auto-create stub
            const newId = await generatePlayerStub(name, articleTitle);
            if (newId) {
                player = sqlite.prepare('SELECT id, article_mentions FROM players WHERE id = ?')
                    .get(newId);
            }
        }
        if (player) {
            // Add article to mentions list
            const mentions = JSON.parse(player.article_mentions || '[]');
            if (!mentions.includes(articleId)) {
                mentions.push(articleId);
                sqlite.prepare('UPDATE players SET article_mentions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(JSON.stringify(mentions), player.id);
            }
            linkedIds.push(player.id);
        }
        // Rate limit Claude calls
        await new Promise(r => setTimeout(r, 500));
    }
    return linkedIds;
}
// ─── Handle market transfer ───────────────────────────────────────────────────
// Called when a confirmed transfer (in or out) is published.
export async function handleTransfer(data) {
    const slug = toSlug(data.playerName);
    const player = sqlite.prepare('SELECT id FROM players WHERE slug = ?').get(slug);
    if (!player) {
        // Create profile for new incoming player
        if (data.type === 'in' && data.status === 'confirmed') {
            await generatePlayerStub(data.playerName, data.note);
        }
        return;
    }
    const transferStatus = data.status === 'confirmed'
        ? data.type === 'out' ? 'confirmed_out' : 'confirmed_in'
        : 'rumor';
    const playerStatus = data.status === 'confirmed' && data.type === 'out' ? 'sold' : 'active';
    sqlite.prepare(`
    UPDATE players
    SET transfer_status = ?, transfer_note = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(transferStatus, data.note, playerStatus, player.id);
    console.log(`🔄 Transfer update: ${data.playerName} → ${transferStatus}: ${data.note}`);
}
// ─── Enrich a stub with fuller bio (nightly task) ────────────────────────────
export async function enrichPlayerProfile(playerId) {
    const player = sqlite.prepare('SELECT * FROM players WHERE id = ? AND enriched = 0').get(playerId);
    if (!player)
        return;
    const mentions = JSON.parse(player.article_mentions || '[]');
    const articleCount = mentions.length;
    // Only enrich players with 2+ article mentions (worth the API call)
    if (articleCount < 2)
        return;
    try {
        const response = await anthropic.messages.create({
            model: MODELS.playerEnrich,
            max_tokens: 1200,
            messages: [{
                    role: 'user',
                    content: `Enriquecé el perfil de ${player.name}, jugador de River Plate, para desdeeltablon.com.
Bio actual: "${player.bio || 'Sin bio'}"

Respondé SOLO con JSON:
{
  "bio": "párrafo completo de 3-4 oraciones, con más contexto histórico y análisis",
  "comparison": "comparación detallada con un jugador histórico de River",
  "histNote": "dato histórico específico de lahistoriariver.com",
  "additionalStats": [["estadística adicional", "valor"]]
}
NO inventés datos. Si no conocés al jugador en profundidad, mejorá solo lo que podés confirmar.`
                }],
        });
        const text = response.content[0].text.trim();
        const clean = text.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(clean);
        const currentStats = JSON.parse(player.stats_json || '[]');
        const newStats = [...currentStats, ...(data.additionalStats || [])];
        sqlite.prepare(`
      UPDATE players
      SET bio = COALESCE(?, bio),
          comparison = COALESCE(?, comparison),
          stats_json = ?,
          enriched = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(data.bio || null, data.comparison || null, JSON.stringify(newStats), playerId);
        console.log(`✨ Perfil enriquecido: ${player.name}`);
    }
    catch (err) {
        console.error(`Error enriqueciendo perfil ${player.name}:`, err);
    }
}
// ─── Get player profile for API ──────────────────────────────────────────────
export function getPlayerBySlug(slug) {
    const player = sqlite.prepare('SELECT * FROM players WHERE slug = ?').get(slug);
    if (!player)
        return null;
    // Get related articles
    const articleIds = JSON.parse(player.article_mentions || '[]');
    const articles = articleIds.length > 0
        ? sqlite.prepare(`
        SELECT id, titulo, bajada, slug, categoria, published_at, featured_image
        FROM articles WHERE id IN (${articleIds.map(() => '?').join(',')}) AND status = 'published'
        ORDER BY published_at DESC LIMIT 5
      `).all(...articleIds)
        : [];
    return {
        ...player,
        stats: JSON.parse(player.stats_json || '[]'),
        titles: JSON.parse(player.titles_json || '[]'),
        articles,
    };
}
export function getAllPlayers(includeInactive = false) {
    const query = includeInactive
        ? 'SELECT id, slug, name, position, number, age, nationality, status, transfer_status, transfer_note, enriched FROM players ORDER BY name'
        : "SELECT id, slug, name, position, number, age, nationality, status, transfer_status, transfer_note, enriched FROM players WHERE status = 'active' ORDER BY name";
    return sqlite.prepare(query).all();
}
