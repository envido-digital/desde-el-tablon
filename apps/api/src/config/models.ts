/**
 * models.ts — Configuración central de modelos de IA
 * ====================================================
 * Asigna el modelo correcto a cada tarea según su nivel de exigencia.
 *
 * Criterio:
 * Opus 4      → SOLO si el task requiere razonamiento autónomo extendido sin contexto guiado
 * Sonnet 4    → redacción, verificación contra fuentes provistas, análisis con contexto
 * Haiku 4.5   → extracción mecánica de datos, clasificación, slugs
 *
 * Cambiar un modelo en producción: editar solo este archivo.
 *
 * NOTA SOBRE EL VERIFICADOR:
 * El verificador NO necesita Opus. Su trabajo es comparar claims contra fuentes
 * que están en el mismo prompt — tarea de matching contextual, no razonamiento abierto.
 * Sonnet tiene el mismo rendimiento a 1/5 del costo de output.
 *
 * NOTA SOBRE EL ESCRITOR TÁCTICO:
 * Los análisis tácticos son largos pero su estructura está completamente guiada
 * por el WRITER_SYSTEM prompt. Sonnet sigue instrucciones complejas sin problema.
 * Mover a Opus solo si la calidad táctica es notablemente inferior en producción.
 */

export const MODELS = {
  // ── Verificador/Árbitro ───────────────────────────────────────────────────
  // Verifica datos contra fuentes provistas en el mismo prompt.
  // Sonnet es suficiente: el razonamiento está guiado, no es abierto.
  // Ahorro: ~$0.10-0.15 por artículo vs Opus.
  verifier: 'claude-sonnet-4-20250514',

  // ── Redactor — análisis táctico largo ────────────────────────────────────
  // Análisis de 2.500-3.500 palabras con coherencia táctica.
  // Sonnet sigue el WRITER_SYSTEM sin problemas. Cambiar a Opus si la calidad
  // táctica es visiblemente inferior después de 10+ artículos en producción.
  tacticalWriter: 'claude-sonnet-4-20250514',

  // ── Redactor — notas estándar ─────────────────────────────────────────────
  // Actualidad, mercado, historia, inferiores.
  writer: 'claude-sonnet-4-20250514',

  // ── Perfiles de jugadores — enriquecimiento ───────────────────────────────
  playerEnrich: 'claude-sonnet-4-20250514',

  // ── Tareas mecánicas ──────────────────────────────────────────────────────
  // Extracción de nombres, clasificación, stubs.
  utility: 'claude-haiku-4-5-20251001',
} as const;

export type ModelKey = keyof typeof MODELS;

export function writerModelForCategory(categoria: string): string {
  return categoria === 'analisis' ? MODELS.tacticalWriter : MODELS.writer;
}

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6':            { input: 15,  output: 75 },
  'claude-sonnet-4-20250514':   { input: 3,   output: 15 },
  'claude-haiku-4-5-20251001':  { input: 0.8, output: 4  },
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

/**
 * Costo mensual estimado según volumen diario de artículos.
 *
 * Comparativa por artículo (estimado):
 *   Configuración anterior (Opus verifier + Opus tactical):
 *     Nota estándar:  ~$0.35-0.50  |  Análisis: ~$0.70-1.00
 *   Configuración actual (todo Sonnet):
 *     Nota estándar:  ~$0.08-0.15  |  Análisis: ~$0.15-0.25
 *   Ahorro estimado: 65-75% por artículo
 */
export function estimateMonthlyApiCost(articlesPerDay: number): {
  verifier: number;
  writers: number;
  utility: number;
  total: number;
  savingsVsOpus: number;
} {
  const daysPerMonth = 30;
  const tacticalRatio = 0.15;

  // Verificador: Sonnet, ~1.2 llamadas/artículo (incluye reescrituras)
  const verifierCost = articlesPerDay * 1.2 * daysPerMonth *
    estimateCost('claude-sonnet-4-20250514', 5000, 600);

  // Redactores — todo Sonnet
  const tacticalCost = articlesPerDay * tacticalRatio * daysPerMonth *
    estimateCost('claude-sonnet-4-20250514', 2500, 4500); // análisis: más output
  const standardCost = articlesPerDay * (1 - tacticalRatio) * daysPerMonth *
    estimateCost('claude-sonnet-4-20250514', 2000, 2800);
  const writersCost = tacticalCost + standardCost;

  // Utilidad: Haiku
  const utilityCost = articlesPerDay * 3 * daysPerMonth *
    estimateCost('claude-haiku-4-5-20251001', 800, 300);

  // Nota histórica diaria
  const historicalCost = daysPerMonth * (
    estimateCost('claude-sonnet-4-20250514', 1800, 2500) +
    estimateCost('claude-sonnet-4-20250514', 3000, 600) // verifier
  );

  const total = verifierCost + writersCost + utilityCost + historicalCost;

  // Costo anterior con Opus verifier + Opus tactical (para referencia)
  const oldVerifierCost = articlesPerDay * 1.2 * daysPerMonth *
    estimateCost('claude-opus-4-6', 3500, 800);
  const oldTacticalCost = articlesPerDay * tacticalRatio * daysPerMonth *
    estimateCost('claude-opus-4-6', 2500, 3200);
  const oldTotal = oldVerifierCost + oldTacticalCost +
    articlesPerDay * (1 - tacticalRatio) * daysPerMonth *
    estimateCost('claude-sonnet-4-20250514', 2000, 2200) +
    utilityCost + historicalCost;

  return {
    verifier:       Math.round(verifierCost * 100) / 100,
    writers:        Math.round(writersCost * 100) / 100,
    utility:        Math.round(utilityCost * 100) / 100,
    total:          Math.round(total * 100) / 100,
    savingsVsOpus:  Math.round((oldTotal - total) * 100) / 100,
  };
}
