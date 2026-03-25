import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { getPlayerBySlug, getAllPlayers, handleTransfer, enrichPlayerProfile } from '../services/players.js';
export const playersRouter = Router();
// GET /api/players — list all active players
playersRouter.get('/', (_req, res) => {
    const players = getAllPlayers();
    res.json(players);
});
// GET /api/players/:slug — get full player profile
playersRouter.get('/:slug', (req, res) => {
    const player = getPlayerBySlug(req.params.slug);
    if (!player)
        return res.status(404).json({ error: 'Jugador no encontrado' });
    res.json(player);
});
// POST /api/players/transfer — register a transfer event
playersRouter.post('/transfer', requireAdmin, async (req, res) => {
    const { playerName, type, status, note, articleId } = req.body;
    if (!playerName || !type || !status || !note) {
        return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    await handleTransfer({ playerName, type, status, note, articleId });
    res.json({ success: true });
});
// POST /api/players/:id/enrich — manually trigger enrichment
playersRouter.post('/:id/enrich', requireAdmin, async (req, res) => {
    await enrichPlayerProfile(req.params.id);
    res.json({ success: true });
});
