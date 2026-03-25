/**
 * GET /api/logo/:teamName
 *
 * Devuelve el escudo de un equipo.
 * - Si está cacheado: respuesta inmediata (< 1ms)
 * - Si no está cacheado: busca en Wikimedia, cachea, responde (1-3s primera vez)
 * - Si no se encuentra: 404 + JSON { found: false }
 *
 * El frontend puede usar la URL directamente como src de <img>
 * porque devuelve la imagen con headers de caché de 30 días.
 */
import { Router } from "express";
import { resolveLogo, clearLogoCache, getLogoCacheStats } from "../services/logo-resolver.js";
export const logoRouter = Router();
// GET /api/logo/:teamName — resolve a single logo
logoRouter.get("/:teamName", async (req, res) => {
    const teamName = decodeURIComponent(req.params.teamName);
    if (!teamName || teamName.length > 100) {
        return res.status(400).json({ error: "Nombre de equipo inválido" });
    }
    const dataUrl = await resolveLogo(teamName);
    if (!dataUrl) {
        return res.status(404).json({ found: false, team: teamName });
    }
    // Extract the base64 data and content type from the data URL
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
        return res.status(500).json({ error: "Logo data corrupta" });
    }
    const [, mimeType, base64] = match;
    const buffer = Buffer.from(base64, "base64");
    // Serve as actual image with long cache headers
    res
        .set("Content-Type", mimeType)
        .set("Cache-Control", "public, max-age=2592000, immutable") // 30 days
        .set("ETag", `"${teamName.toLowerCase().replace(/\s+/g, "-")}"`)
        .send(buffer);
});
// POST /api/logo/batch — resolve multiple logos at once
// Body: { teams: string[] }
logoRouter.post("/batch", async (req, res) => {
    const { teams } = req.body;
    if (!Array.isArray(teams) || teams.length === 0) {
        return res.status(400).json({ error: "teams debe ser un array" });
    }
    if (teams.length > 30) {
        return res.status(400).json({ error: "Máximo 30 equipos por request" });
    }
    const results = {};
    // Resolve all in parallel (cached ones are instant)
    await Promise.all(teams.map(async (team) => {
        results[team] = await resolveLogo(team);
    }));
    res.json({ logos: results });
});
// GET /api/logo/_stats — cache statistics (admin)
logoRouter.get("/_stats", (_req, res) => {
    res.json(getLogoCacheStats());
});
// DELETE /api/logo/_cache — clear logo cache (admin)
logoRouter.delete("/_cache", (req, res) => {
    const { team } = req.query;
    clearLogoCache(team);
    res.json({ success: true, message: team ? `Cache limpiado para: ${team}` : "Cache completo limpiado" });
});
