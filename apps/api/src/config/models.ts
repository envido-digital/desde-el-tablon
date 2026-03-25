/**
 * models.ts — Configuración central de modelos de IA
 * ====================================================
 * Asigna el modelo correcto a cada tarea según su nivel de exigencia.
 *
 * Criterio:
 *   Opus 4   → decisiones críticas que afectan lo que se publica
 *   Sonnet 4 → redacción y generación de contenido de calidad
 *   Haiku 4.5 → extracción mecánica de datos, clasificación, slugs
 *
 * Cambiar un modelo en producción: editar solo este archivo.
 */

export const MODELS = {
  // ── Verificador/Árbitro ───────────────────────────────────────────────────
  // La decisión más crítica del sistema: qué se publica y qué no.
  // Detecta datos sin respaldo, contradicciones, errores de lógica.
  // Siempre el mejor modelo disponible.
  verifier: 'claude-opus-4-6',

  // ── Redactor — análisis táctico largo ────────────────────────────────────
  // 900-1.500 palabras con coherencia táctica a lo largo de todo el texto.
  // El razonamiento sostenido justifica Opus.
  tacticalWriter: 'claude-opus-4-6',

  // ── Redactor — notas estándar ─────────────────────────────────────────────
  // Actualidad, mercado, historia, inferiores (400-700 palabras).
  // Sonnet es más que suficiente para estructura narrativa estándar.
  writer: 'claude-sonnet-4-20250514',

  // ── Perfiles de jugadores — enriquecimiento ───────────────────────────────
  // Bio profunda con contexto histórico y comparación con figuras del club.
  // Requiere conocimiento fino de la historia de River → Sonnet.
  playerEnrich: 'claude-sonnet-4-20250514',

  // ── Tareas mecánicas ──────────────────────────────────────────────────────
  // Extracción de nombres, clasificación, stubs iniciales de jugadores.
  // Input/output pequeño y bien definido → Haiku.
  utility: 'claude-haiku-4-5-20251001',
} as const;

export type ModelKey = keyof typeof MODELS;

/**
 * Selecciona el modelo de redacción según la categoría del artículo.
 * Los análisis tácticos usan Opus; el resto usa Sonnet.
 */
export function writerModelForCategory(categoria: string): string {
  return categoria === 'analisis' ? MODELS.tacticalWriter : MODELS.writer;
}

/**
 * Estima el costo aproximado de una llamada en USD.
 * Útil para el log de auditoría y proyecciones de gasto.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6':           { input: 15,   output: 75   },  // por millón de tokens
  'claude-sonnet-4-20250514':  { input: 3,    output: 15   },
  'claude-haiku-4-5-20251001': { input: 0.8,  output: 4    },
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
 * Basado en notas de 1.200-2.500 palabras (modelo de negocio: AdSense in-content).
 */
export function estimateMonthlyApiCost(articlesPerDay: number): {
  verifier: number;
  writers: number;
  utility: number;
  total: number;
} {
  const daysPerMonth = 30;
  const tacticalRatio = 0.15; // ~15% son análisis tácticos (1.800-2.500 palabras)

  // Notas más largas → más tokens de output
  // Actualidad/mercado/historia: ~1.500 palabras promedio → ~2.200 output tokens
  // Análisis: ~2.200 palabras → ~3.200 output tokens
  // Verificador lee la nota completa → más input tokens también

  // Verificador: siempre Opus, ~1.2 llamadas/artículo (incluye reescrituras)
  const verifierCost = articlesPerDay * 1.2 * daysPerMonth *
    estimateCost('claude-opus-4-6', 3500, 800);  // más input porque la nota es más larga

  // Redactores
  const tacticalCost = articlesPerDay * tacticalRatio * daysPerMonth *
    estimateCost('claude-opus-4-6', 2500, 3200);  // análisis tácticos: 2.500+ palabras
  const standardCost = articlesPerDay * (1 - tacticalRatio) * daysPerMonth *
    estimateCost('claude-sonnet-4-20250514', 2000, 2200);  // notas estándar: 1.500 palabras
  const writersCost = tacticalCost + standardCost;

  // Utilidad: Haiku para extracción de jugadores + stubs + scoring
  const utilityCost = articlesPerDay * 3 * daysPerMonth *
    estimateCost('claude-haiku-4-5-20251001', 800, 300);

  // Nota histórica diaria (1/día, Sonnet + Opus verifier)
  const historicalCost = daysPerMonth * (
    estimateCost('claude-sonnet-4-20250514', 1800, 2000) +  // ~1.400 palabras
    estimateCost('claude-opus-4-6', 3000, 800)
  );

  const total = verifierCost + writersCost + utilityCost + historicalCost;

  return {
    verifier: Math.round(verifierCost * 100) / 100,
    writers:  Math.round(writersCost  * 100) / 100,
    utility:  Math.round(utilityCost  * 100) / 100,
    total:    Math.round(total        * 100) / 100,
  };
}
