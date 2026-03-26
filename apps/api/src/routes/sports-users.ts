import { Router, type Request, type Response } from 'express';
import { getStandings, getNextMatch, getLastResult, getAllMatches, getZonaStandings, getZonaAStandings, getCopaStandings } from '../services/sports.js';
import { awardPoints, getUserProfile, getLeaderboard, recordDailyLogin, hasReadArticleToday } from '../services/gamification.js';
import { hashPassword, verifyPassword, signToken, validatePassword } from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { sqlite } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';

export const sportsRouter = Router();
export const usersRouter = Router();

// ── Sports ─────────────────────────────────────────────────────────────────────
sportsRouter.get('/standings',        async (_req, res) => res.json(await getStandings()));
sportsRouter.get('/standings-zona',   async (_req, res) => res.json(await getZonaStandings()));
sportsRouter.get('/standings-zona-a', async (_req, res) => res.json(await getZonaAStandings()));
sportsRouter.get('/standings-copa',   async (_req, res) => res.json(await getCopaStandings()));
sportsRouter.get('/next-match',       async (_req, res) => res.json(await getNextMatch()));
sportsRouter.get('/last-result',      async (_req, res) => res.json(await getLastResult()));
sportsRouter.get('/all-matches',      async (_req, res) => res.json(await getAllMatches()));

// ── Debug: testea la API key y endpoints reales ────────────────────────────────
sportsRouter.get('/debug', async (_req, res) => {
  const key = process.env.API_FOOTBALL_KEY ?? '';
  const season = new Date().getFullYear();
  const results: Record<string, any> = { key_loaded: key.length > 10, key_length: key.length, season };
  if (!key.length) return res.json({ ...results, error: 'API_FOOTBALL_KEY no cargada' });

  const apiFetch = async (path: string) => {
    const r = await fetch(`https://v3.football.api-sports.io${path}`, { headers: { 'x-apisports-key': key } });
    return { http: r.status, data: await r.json() as any };
  };

  // Status
  try {
    const { http, data } = await apiFetch('/status');
    results.plan = data?.response?.subscription?.plan;
    results.requests_today = data?.response?.requests?.current;
    results.limit_day = data?.response?.requests?.limit_day;
    results.api_http = http;
  } catch (e: any) { results.api_error = e.message; }

  // Liga standings (all zones)
  try {
    const { http, data } = await apiFetch(`/standings?league=128&season=${season}`);
    const zones = data?.response?.[0]?.league?.standings ?? [];
    results.liga = {
      http, errors: data?.errors,
      zones: zones.length,
      zone_groups: zones.map((z: any) => z[0]?.group),
      river_zone: zones.findIndex((z: any) => z.some((e: any) => e.team?.id === 435)),
    };
  } catch (e: any) { results.liga_error = e.message; }

  // Copa Sudamericana - raw response inspection
  try {
    const { http, data } = await apiFetch(`/standings?league=11&season=${season}`);
    const resp = data?.response ?? [];
    const zones = resp[0]?.league?.standings ?? [];
    const riverZone = zones.findIndex((z: any) => z.some((e: any) => e.team?.id === 435));
    results.sudamericana = {
      http, errors: data?.errors,
      total_response_items: resp.length,
      total_zones: zones.length,
      river_zone_index: riverZone,
      river_found: riverZone !== -1,
      group_names: zones.slice(0, 4).map((z: any) => z[0]?.group),
      // Show raw structure of first response item if no zones found
      raw_first_item_keys: resp[0] ? Object.keys(resp[0]) : [],
      raw_league_keys: resp[0]?.league ? Object.keys(resp[0].league) : [],
    };
  } catch (e: any) { results.sudamericana_error = e.message; }

  // Copa Sudamericana - try with team filter
  try {
    const { http, data } = await apiFetch(`/standings?league=11&season=${season}&team=435`);
    const resp = data?.response ?? [];
    const zones = resp[0]?.league?.standings ?? [];
    results.sudamericana_team_filter = {
      http, errors: data?.errors,
      total_response_items: resp.length,
      zones: zones.length,
      river_found: zones.some((z: any) => z.some((e: any) => e.team?.id === 435)),
    };
  } catch (e: any) { results.sudamericana_team_filter_error = e.message; }

  // Try different league IDs for Copa Sudamericana
  try {
    // Sometimes API uses different IDs - test 11 and also check /leagues for sudamericana
    const { http, data } = await apiFetch(`/leagues?name=Sudamericana&current=true`);
    results.sudamericana_leagues = {
      http,
      found: (data?.response ?? []).map((l: any) => ({ id: l.league?.id, name: l.league?.name, season: l.seasons?.find((s: any) => s.current)?.year }))
    };
  } catch (e: any) { results.sudamericana_leagues_error = e.message; }

  // Inspect Copa Sudamericana fixtures for River - to understand data we can use to build standings
  try {
    const { http, data } = await apiFetch(`/fixtures?league=11&season=${season}&team=435`);
    const fixtures: any[] = data?.response ?? [];
    const groupFixtures = fixtures.filter((f: any) =>
      (f.league?.round ?? '').toLowerCase().includes('group')
    );
    results.suda_fixtures = {
      http,
      errors: data?.errors,
      total_fixtures: fixtures.length,
      group_fixtures: groupFixtures.length,
      rounds: [...new Set(fixtures.map((f: any) => f.league?.round))],
      sample_fixture: groupFixtures[0] ? {
        round: groupFixtures[0].league?.round,
        home: groupFixtures[0].teams?.home?.name,
        home_id: groupFixtures[0].teams?.home?.id,
        away: groupFixtures[0].teams?.away?.name,
        away_id: groupFixtures[0].teams?.away?.id,
        score: `${groupFixtures[0].goals?.home}-${groupFixtures[0].goals?.away}`,
        status: groupFixtures[0].fixture?.status?.short,
        date: groupFixtures[0].fixture?.date,
      } : null,
    };
  } catch (e: any) { results.suda_fixtures_error = e.message; }

  res.json(results);
});

// ── Register ───────────────────────────────────────────────────────────────────
usersRouter.post('/register', async (req: Request, res: Response) => {
  const { email, username, password } = req.body as { email?: string; username?: string; password?: string };

  if (!email || !username || !password)
    return res.status(400).json({ error: 'Email, username y contraseña son requeridos' });

  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Email inválido' });

  if (username.length < 3 || username.length > 30 || !/^[a-zA-Z0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Username: 3-30 caracteres, solo letras, números y guión bajo' });

  if (sqlite.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase()))
    return res.status(409).json({ error: 'El email ya está registrado' });

  if (sqlite.prepare('SELECT id FROM users WHERE username = ?').get(username))
    return res.status(409).json({ error: 'El username ya está en uso' });

  const id = uuidv4();
  const hash = await hashPassword(password);

  sqlite.prepare(
    "INSERT INTO users (id, email, username, password_hash, email_verified, role) VALUES (?, ?, ?, ?, 1, 'reader')"
  ).run(id, email.toLowerCase().trim(), username, hash);

  awardPoints(id, 'REGISTER');
  sqlite.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)').run(id, 'tablonero');

  const profile = getUserProfile(id);
  const token = signToken({ userId: id, role: 'reader' });

  res.status(201).json({
    success: true,
    message: '¡Bienvenido al tablón! +50 puntos de bienvenida',
    user: profile,
    token,
  });
});

// ── Login ──────────────────────────────────────────────────────────────────────
usersRouter.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password)
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });

  const user = sqlite.prepare('SELECT * FROM users WHERE email = ?').get(
    email.toLowerCase().trim()
  ) as { id: string; password_hash: string; role: string } | undefined;

  // Constant-time comparison to prevent timing attacks
  if (!user) {
    await bcryptDummy(); // prevent timing oracle
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

  const { alreadyLoggedIn, points } = recordDailyLogin(user.id);
  const profile = getUserProfile(user.id);
  const token = signToken({ userId: user.id, role: user.role });

  res.json({
    success: true,
    user: profile,
    dailyBonus: alreadyLoggedIn ? null : { points, message: `+${points} puntos por login diario` },
    token,
  });
});

// ── Profile ────────────────────────────────────────────────────────────────────
usersRouter.get('/profile', requireAuth, (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const profile = getUserProfile(userId);
  if (!profile) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(profile);
});

// ── Leaderboard ────────────────────────────────────────────────────────────────
usersRouter.get('/leaderboard', (_req, res) => res.json(getLeaderboard(50)));

// ── Read article (award points) ────────────────────────────────────────────────
usersRouter.post('/read-article', requireAuth, (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const { articleId, scrollPercentage = 0 } = req.body as { articleId?: string; scrollPercentage?: number };

  if (!articleId) return res.status(400).json({ error: 'articleId es requerido' });
  if (scrollPercentage < 60) return res.json({ success: false, message: 'Necesitás leer más del 60%' });
  if (hasReadArticleToday(userId, articleId)) return res.json({ success: false, message: 'Ya ganaste puntos por este artículo hoy' });

  const article = sqlite.prepare('SELECT categoria FROM articles WHERE id = ?').get(articleId) as { categoria: string } | undefined;
  if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

  const action = article.categoria === 'analisis' ? 'READ_ANALYSIS'
    : article.categoria === 'historia' ? 'READ_HISTORY'
    : 'READ_ARTICLE';

  const result = awardPoints(userId, action as any, articleId);
  if (!result) return res.status(500).json({ error: 'Error otorgando puntos' });

  res.json({
    success: true,
    points: result.points,
    newTotal: result.newTotal,
    levelUp: result.levelUp,
    newLevel: result.newLevel,
    message: `+${result.points} puntos 📖`,
  });
});

// Dummy bcrypt call to prevent timing oracle on missing users
async function bcryptDummy() {
  await verifyPassword('dummy', '$2b$12$invalidhashinvalidhashinvalidhashXX');
}
