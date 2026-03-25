import { Router } from 'express';
import { getStandings, getNextMatch, getLastResult, getAllMatches } from '../services/sports.js';
import { awardPoints, getUserProfile, getLeaderboard, recordDailyLogin, hasReadArticleToday } from '../services/gamification.js';
import { hashPassword, verifyPassword, signToken, validatePassword } from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { sqlite } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
export const sportsRouter = Router();
export const usersRouter = Router();
// ── Sports ─────────────────────────────────────────────────────────────────────
sportsRouter.get('/standings', async (_req, res) => res.json(await getStandings()));
sportsRouter.get('/next-match', async (_req, res) => res.json(await getNextMatch()));
sportsRouter.get('/last-result', async (_req, res) => res.json(await getLastResult()));
sportsRouter.get('/all-matches', async (_req, res) => res.json(await getAllMatches()));
// ── Register ───────────────────────────────────────────────────────────────────
usersRouter.post('/register', async (req, res) => {
    const { email, username, password } = req.body;
    if (!email || !username || !password)
        return res.status(400).json({ error: 'Email, username y contraseña son requeridos' });
    const pwCheck = validatePassword(password);
    if (!pwCheck.ok)
        return res.status(400).json({ error: pwCheck.error });
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
    sqlite.prepare("INSERT INTO users (id, email, username, password_hash, email_verified, role) VALUES (?, ?, ?, ?, 1, 'reader')").run(id, email.toLowerCase().trim(), username, hash);
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
usersRouter.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    const user = sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
    // Constant-time comparison to prevent timing attacks
    if (!user) {
        await bcryptDummy(); // prevent timing oracle
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok)
        return res.status(401).json({ error: 'Credenciales inválidas' });
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
usersRouter.get('/profile', requireAuth, (req, res) => {
    const userId = req.userId;
    const profile = getUserProfile(userId);
    if (!profile)
        return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(profile);
});
// ── Leaderboard ────────────────────────────────────────────────────────────────
usersRouter.get('/leaderboard', (_req, res) => res.json(getLeaderboard(50)));
// ── Read article (award points) ────────────────────────────────────────────────
usersRouter.post('/read-article', requireAuth, (req, res) => {
    const userId = req.userId;
    const { articleId, scrollPercentage = 0 } = req.body;
    if (!articleId)
        return res.status(400).json({ error: 'articleId es requerido' });
    if (scrollPercentage < 60)
        return res.json({ success: false, message: 'Necesitás leer más del 60%' });
    if (hasReadArticleToday(userId, articleId))
        return res.json({ success: false, message: 'Ya ganaste puntos por este artículo hoy' });
    const article = sqlite.prepare('SELECT categoria FROM articles WHERE id = ?').get(articleId);
    if (!article)
        return res.status(404).json({ error: 'Artículo no encontrado' });
    const action = article.categoria === 'analisis' ? 'READ_ANALYSIS'
        : article.categoria === 'historia' ? 'READ_HISTORY'
            : 'READ_ARTICLE';
    const result = awardPoints(userId, action, articleId);
    if (!result)
        return res.status(500).json({ error: 'Error otorgando puntos' });
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
