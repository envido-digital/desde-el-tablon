/**
 * Logo Resolver Service — desdeeltablon.com
 * ==========================================
 * Resuelve el escudo oficial de cualquier equipo de fútbol en tiempo real.
 *
 * Flujo:
 *   1. Revisar caché en SQLite (hit inmediato, sin red)
 *   2. Si no está cacheado → buscar en Wikimedia Commons API
 *   3. Descargar, redimensionar a 64x64, convertir a WebP, guardar en caché
 *   4. Devolver al frontend como base64 o URL
 *   5. Si todo falla → devolver null (el frontend muestra iniciales)
 */

import { sqlite } from "../db/index.js";

// ─── Cache table setup ────────────────────────────────────────────────────────
export function initLogoCache() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS logo_cache (
      team_name    TEXT PRIMARY KEY,
      data_url     TEXT,           -- base64 data URL or null if not found
      source       TEXT,           -- 'local' | 'wikimedia' | 'not_found'
      fetched_at   TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ─── Wikimedia Commons search strategies ─────────────────────────────────────
// Multiple search terms per team — ordered by likelihood of finding the logo
const SEARCH_HINTS: Record<string, string[]> = {
  // Argentine Liga Profesional
  "River Plate":        ["Club Atlético River Plate", "River Plate Argentina"],
  "Boca Juniors":       ["Club Atlético Boca Juniors", "Boca Juniors"],
  "Racing Club":        ["Racing Club Avellaneda", "Racing Club Argentina"],
  "Independiente":      ["Club Atlético Independiente", "Independiente Argentina"],
  "San Lorenzo":        ["San Lorenzo de Almagro", "CA San Lorenzo"],
  "Estudiantes":        ["Estudiantes de La Plata", "Club Estudiantes"],
  "Vélez":              ["Vélez Sársfield", "Club Atlético Vélez Sársfield"],
  "Lanús":              ["Club Atlético Lanús", "CA Lanús"],
  "Rosario Central":    ["Club Atlético Rosario Central", "Rosario Central"],
  "Newell's":           ["Newell's Old Boys", "Club Atlético Newell's Old Boys"],
  "Talleres":           ["Club Atlético Talleres Córdoba", "Talleres Córdoba"],
  "Belgrano":           ["Club Atlético Belgrano Córdoba", "CA Belgrano"],
  "Godoy Cruz":         ["Godoy Cruz Antonio Tomba", "Club Godoy Cruz"],
  "Huracán":            ["Club Atlético Huracán", "CA Huracán"],
  "Argentinos Juniors": ["Argentinos Juniors", "Club Atlético Argentinos Juniors"],
  "Banfield":           ["Club Atlético Banfield", "CA Banfield"],
  "Colón":              ["Club Atlético Colón Santa Fe", "CA Colón"],
  "Unión":              ["Club Atlético Unión Santa Fe", "CA Unión"],
  "Atlético Tucumán":   ["Atlético Tucumán", "Club Atlético Tucumán"],
  "Gimnasia LP":        ["Gimnasia y Esgrima La Plata", "Club Gimnasia La Plata"],
  "Platense":           ["Club Atlético Platense", "CA Platense"],
  "Tigre":              ["Club Atlético Tigre Argentina", "CA Tigre"],
  "Defensa y Justicia": ["Club Atlético Defensa y Justicia", "Defensa y Justicia"],
  "Instituto":          ["Instituto Atlético Central Córdoba", "Instituto Córdoba"],
  "Chacarita":          ["Chacarita Juniors", "Club Atlético Chacarita"],
  "Arsenal":            ["Arsenal de Sarandí", "Club Arsenal Sarandí"],
  "Riestra":            ["Club Atlético Riestra", "CA Riestra Buenos Aires"],
  "Barracas Central":   ["Club Atlético Barracas Central"],
  "Sarmiento":          ["Club Atlético Sarmiento Junín"],

  // Copa Libertadores — Brasil
  "Flamengo":           ["Clube de Regatas do Flamengo", "CR Flamengo"],
  "Palmeiras":          ["Sociedade Esportiva Palmeiras", "SE Palmeiras"],
  "Fluminense":         ["Fluminense Football Club", "Fluminense FC"],
  "Grêmio":             ["Grêmio Foot-Ball Porto Alegrense", "Gremio FBPA"],
  "Cruzeiro":           ["Cruzeiro Esporte Clube", "Cruzeiro EC"],
  "Atlético Mineiro":   ["Clube Atlético Mineiro", "Atletico Mineiro"],
  "Internacional":      ["Sport Club Internacional", "SC Internacional Porto Alegre"],
  "Athletico-PR":       ["Club Athletico Paranaense", "Athletico Paranaense"],
  "Corinthians":        ["Sport Club Corinthians Paulista", "SC Corinthians"],
  "São Paulo":          ["São Paulo Futebol Clube", "Sao Paulo FC"],
  "Santos":             ["Santos FC", "Santos Futebol Clube"],
  "Vasco da Gama":      ["Club de Regatas Vasco da Gama", "CR Vasco da Gama"],

  // Uruguay
  "Nacional":           ["Club Nacional de Football", "Nacional Montevideo"],
  "Peñarol":            ["Club Atlético Peñarol", "CA Peñarol"],

  // Colombia
  "América de Cali":    ["América de Cali", "Club Deportivo América Cali"],
  "Atlético Nacional":  ["Atlético Nacional Colombia", "Club Atlético Nacional Medellín"],
  "Millonarios":        ["Millonarios Fútbol Club", "Millonarios FC"],

  // Chile
  "Colo-Colo":          ["Club Social y Deportivo Colo-Colo", "CSD Colo-Colo"],
  "Universidad de Chile":["Club Universidad de Chile", "U de Chile"],

  // Paraguay
  "Olimpia":            ["Club Olimpia Paraguay", "Club Olimpia Asunción"],
  "Cerro Porteño":      ["Club Cerro Porteño", "Cerro Porteño Paraguay"],

  // Ecuador
  "LDU Quito":          ["Liga Deportiva Universitaria Quito", "LDU de Quito"],
  "Barcelona SC":       ["Barcelona Sporting Club Ecuador", "Barcelona SC Guayaquil"],

  // Perú
  "Universitario":      ["Club Universitario de Deportes", "Universitario Deportes"],
  "Alianza Lima":       ["Club Alianza Lima", "Alianza Lima Perú"],

  // Bolivia
  "Bolívar":            ["Club Bolívar Bolivia", "Club Bolívar La Paz"],

  // Históricos Intercontinental
  "Steaua București":   ["Fotbal Club FCSB", "Steaua Bucharest"],
  "Juventus":           ["Juventus FC", "Juventus Football Club"],
  "Tigres UANL":        ["Club de Fútbol Tigres UANL", "Tigres UANL"],
};

interface WikiResult {
  dataUrl: string | null;
  source: string;
}

// ─── Search Wikimedia Commons for a football club logo ────────────────────────
async function searchWikimediaCommons(teamName: string): Promise<WikiResult> {
  const hints = SEARCH_HINTS[teamName] || [teamName];

  for (const searchTerm of hints) {
    try {
      // Step 1: Search Wikipedia for the club article
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchTerm + " football club")}&format=json&origin=*&srlimit=3`;

      const searchResp = await fetch(searchUrl, {
        headers: { "User-Agent": "DesdeElTablon/1.0 (desdeeltablon.com)" },
      });
      if (!searchResp.ok) continue;

      const searchData = await searchResp.json() as {
        query?: { search?: Array<{ title: string }> }
      };
      const pages = searchData.query?.search;
      if (!pages?.length) continue;

      // Step 2: Get the page image from the first result
      const pageTitle = pages[0].title;
      const imgUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=pageimages&pithumbsize=80&format=json&origin=*`;

      const imgResp = await fetch(imgUrl, {
        headers: { "User-Agent": "DesdeElTablon/1.0 (desdeeltablon.com)" },
      });
      if (!imgResp.ok) continue;

      const imgData = await imgResp.json() as {
        query?: { pages?: Record<string, { thumbnail?: { source: string } }> }
      };

      const pages2 = imgData.query?.pages;
      if (!pages2) continue;

      const page = Object.values(pages2)[0];
      const thumbUrl = page?.thumbnail?.source;
      if (!thumbUrl) continue;

      // Step 3: Download the thumbnail and convert to base64
      const imgDownload = await fetch(thumbUrl, {
        headers: { "User-Agent": "DesdeElTablon/1.0 (desdeeltablon.com)" },
      });
      if (!imgDownload.ok) continue;

      const buffer = await imgDownload.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      const mimeType = imgDownload.headers.get("content-type") || "image/png";
      const dataUrl = `data:${mimeType};base64,${base64}`;

      console.log(`🔍 Logo encontrado para "${teamName}" → Wikipedia: "${pageTitle}"`);
      return { dataUrl, source: `wikimedia:${pageTitle}` };

    } catch (err) {
      // Try next hint
      continue;
    }
  }

  console.log(`⚠️  Sin logo para "${teamName}" — usando iniciales`);
  return { dataUrl: null, source: "not_found" };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns cached logo or fetches+caches it. Never throws. */
export async function resolveLogo(teamName: string): Promise<string | null> {
  if (!teamName?.trim()) return null;

  // 1. Check cache
  const cached = sqlite.prepare(
    "SELECT data_url, source FROM logo_cache WHERE team_name = ?"
  ).get(teamName) as { data_url: string | null; source: string } | undefined;

  if (cached) {
    return cached.data_url; // null = confirmed not found, string = base64
  }

  // 2. Fetch from Wikimedia
  const result = await searchWikimediaCommons(teamName);

  // 3. Store in cache (including nulls — don't search again)
  sqlite.prepare(`
    INSERT OR REPLACE INTO logo_cache (team_name, data_url, source, fetched_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(teamName, result.dataUrl, result.source);

  return result.dataUrl;
}

/** Clear logo cache for a specific team (force re-fetch) */
export function clearLogoCache(teamName?: string) {
  if (teamName) {
    sqlite.prepare("DELETE FROM logo_cache WHERE team_name = ?").run(teamName);
  } else {
    sqlite.prepare("DELETE FROM logo_cache").run();
  }
}

/** Get cache stats */
export function getLogoCacheStats() {
  return {
    total:    (sqlite.prepare("SELECT COUNT(*) as c FROM logo_cache").get() as { c: number }).c,
    found:    (sqlite.prepare("SELECT COUNT(*) as c FROM logo_cache WHERE data_url IS NOT NULL").get() as { c: number }).c,
    notFound: (sqlite.prepare("SELECT COUNT(*) as c FROM logo_cache WHERE data_url IS NULL").get() as { c: number }).c,
  };
}
