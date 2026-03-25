import cron from 'node-cron';
import { runPipeline, generateDailyHistoricalNote } from './pipeline/publisher.js';
import { getAllPlayers, enrichPlayerProfile } from './services/players.js';
import { sqlite } from './db/index.js';
export function startScheduler() {
    console.log('⏰ Iniciando scheduler...');
    // Run pipeline every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
        console.log(`[${new Date().toISOString()}] 🔄 Pipeline automático...`);
        await runPipeline();
    });
    // Generate daily historical note at 12:00 UTC (9:00 AM ART)
    cron.schedule('0 12 * * *', async () => {
        console.log(`[${new Date().toISOString()}] 📜 Nota histórica diaria...`);
        await generateDailyHistoricalNote();
    });
    // Auto-approve safe pending articles every 15 minutes
    cron.schedule('*/15 * * * *', () => {
        sqlite.prepare(`
      UPDATE articles SET status = 'published', published_at = CURRENT_TIMESTAMP
      WHERE status = 'pending' AND requires_review = 0
      AND created_at < datetime('now', '-15 minutes')
    `).run();
    });
    // Nightly: enrich player stubs that have 2+ article mentions
    cron.schedule('0 3 * * *', async () => {
        const stubs = getAllPlayers()
            .filter(p => p.enriched === 0);
        for (const p of stubs) {
            await enrichPlayerProfile(p.id);
            await new Promise(r => setTimeout(r, 2000));
        }
    });
    // Newsletter digest — desactivado intencionalmente.
    // La recopilación de emails está activa (POST /api/newsletter/subscribe).
    // Para activar el envío cuando el sitio esté listo:
    //   1. Descomentar el cron de abajo
    //   2. Agregar RESEND_API_KEY (o SMTP config) al .env
    //
    // cron.schedule('0 12 * * 5', async () => {
    //   const result = await sendWeeklyDigest();
    //   console.log(`📬 Newsletter: ${result.sent} enviados / ${result.failed} fallidos`);
    // });
    console.log('✅ Scheduler activo: pipeline c/30min | histórica diaria | enriquecimiento nocturno | newsletter: recopilación activa, envío desactivado');
}
