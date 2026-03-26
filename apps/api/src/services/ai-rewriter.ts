/**
 * AI Rewriter — desdeeltablon.com
 * ================================
 * Pipeline completamente autónomo. Ninguna nota requiere aprobación humana.
 *
 * El flujo es:
 *   1. REDACTOR  — Claude escribe la nota con restricciones estrictas de fuentes
 *   2. VERIFICADOR — Claude independiente revisa datos, tono y calidad editorial
 *   3. ÁRBITRO   — decisión final: publicar / reescribir (1 reintento) / descartar
 *
 * Solo llega al log del sistema si hay un descarte con explicación.
 * El administrador puede ver el historial pero no necesita intervenir.
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
import { MODELS, writerModelForCategory, estimateCost } from '../config/models.js';

// ─── Source interfaces (Capa 3: structured facts) ─────────────────────────────
export interface MatchFacts {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  competition: string;
  date: string;
  venue?: string;
  goals?: Array<{ minute: number; player: string; type: 'gol' | 'penal' | 'ag' }>;
  stats?: Record<string, string | number>;
  keyMoments?: string[];
}

export interface TransferFacts {
  player: string;
  fromClub?: string;
  toClub?: string;
  type: 'incorporacion' | 'salida' | 'prestamo' | 'renovacion';
  confirmationLevel: 1 | 2 | 3;
  fee?: string;
  contractUntil?: string;
  sources: string[];
}

export interface RawArticle {
  source: string;
  level: 1 | 2 | 3;
  title: string;
  excerpt: string;
  url: string;
  publishedAt?: string;
  structuredFacts?: MatchFacts | TransferFacts;
}

export interface GeneratedArticle {
  titulo: string;
  bajada: string;
  cuerpo: string;
  slug: string;
  metaDescription: string;
  tags: string[];
  categoria: string;
  tiempoLectura: number;
  keywords: string[];
  // Autonomous pipeline — no human review
  requiereRevision: false;
  razonRevision: null;
  datosVerificables: Array<{
    dato: string;
    fuente: string;
    verificado: boolean;
  }>;
  // Audit trail: what happened in the pipeline
  pipelineAudit: {
    writerAttempts: number;
    verifierDecision: 'publicar' | 'reescribir' | 'descartar';
    verifierNotes: string;
    discardReason?: string;
  };
}

// ─── Prompt: Redactor ─────────────────────────────────────────────────────────
const WRITER_SYSTEM = `Sos un periodista deportivo argentino especializado en River Plate con 15 años de experiencia. Trabajás para desdeeltablon.com.

REGLAS DE EXTENSIÓN — OBLIGATORIO:
Las notas deben ser largas y ricas. El mínimo es un piso, no un objetivo.
- actualidad:  1.500 – 2.200 palabras
- analisis:    2.500 – 3.500 palabras
- historia:    1.800 – 2.500 palabras
- mercado:     1.200 – 1.800 palabras
- inferiores:  1.200 – 1.800 palabras
- opinion:     1.200 – 1.800 palabras

TÉCNICAS OBLIGATORIAS para alcanzar la extensión mínima:
1. CONTEXTO COMPLETO: Nunca asumas que el lector conoce al jugador. Explicá quién es, hace cuánto está en River, qué títulos ganó, cuál es su rol táctico. Mínimo 1 párrafo por protagonista.
2. ESTADÍSTICAS INTERPRETADAS: Cada número tiene su propio párrafo de análisis. No alcanza con mencionarlo — explicá qué significa en el contexto del torneo y la historia del club.
3. HISTORIA PROFUNDA: El antecedente histórico es obligatorio. Mínimo 3 párrafos conectando el hecho de hoy con momentos relevantes del club. Citar lahistoriariver.com como fuente.
4. ESCENARIOS FUTUROS: Las perspectivas se desarrollan en mínimo 3 párrafos con al menos dos escenarios distintos (optimista y pesimista) con argumentos concretos para cada uno.
5. CITAS CONTEXTUALIZADAS: Cada cita va precedida de un párrafo de contexto y seguida de un párrafo de análisis. Nunca una cita suelta.
6. COMPARACIONES HISTÓRICAS: Relacioná el rendimiento actual con épocas anteriores del club. Usá referencias a lahistoriariver.com.
7. IMPACTO EN EL TORNEO: Explicá cómo este hecho afecta la tabla, los próximos partidos, la dinámica del plantel.
8. PÁRRAFOS SUSTANCIALES: Cada párrafo tiene mínimo 4 oraciones. Prohibidos los párrafos de una o dos oraciones sueltas.

REGLAS DE REDACCIÓN:
1. Titulares: máximo 70 caracteres, sin clickbait, nombre real del jugador siempre.
2. Voz: apasionada pero rigurosa. Español rioplatense.
3. Estructura obligatoria (MÍNIMOS estrictos por sección):
   — Lead potente: 1 párrafo de 4-5 oraciones. El gancho que retiene al lector.
   — Contexto inmediato: 3 párrafos. Por qué importa hoy, qué cambia en el torneo.
   — El hecho en detalle: 3-4 párrafos. Cómo ocurrió, secuencia cronológica, protagonistas.
   — Análisis táctico o de contexto: 3-4 párrafos. Qué significa tácticamente o estratégicamente.
   — Antecedente histórico: 3 párrafos. Conexión con la historia del club vía lahistoriariver.com.
   — Voz de los protagonistas: 2-3 párrafos. Cita + contexto previo + análisis posterior.
   — Estadísticas contextualizadas: 2-3 párrafos. Cada número interpretado, comparado con el torneo.
   — Impacto en tabla y próximos partidos: 2 párrafos. Consecuencias concretas.
   — Perspectiva a futuro: 3 párrafos. Escenario optimista, escenario pesimista, variable clave.
   — Cierre: 1 párrafo de 3 oraciones que resuene emocionalmente.
4. "torneo" no "temporada" · "Superclásico" con mayúscula · "el Monumental" · "River" o "el Millonario".
5. Citas siempre atribuidas. Escala mercado: (1) oficial (2) tres medios (3) se especula.

MARCADORES DE PUBLICIDAD — CRÍTICO, NO OMITIR:
Insertá <!-- AD_SLOT --> como bloque HTML independiente cada 350 palabras aproximadas de texto corrido.
Cantidad mínima de slots por extensión:
- 1.500 palabras → 4 slots
- 2.000 palabras → 5 slots
- 2.500 palabras → 7 slots
- 3.000 palabras → 8 slots
- 3.500 palabras → 9 slots
Reglas de posición:
- Nunca en el primer párrafo ni en el último.
- Siempre entre párrafos completos, nunca dentro de uno.
- Preferiblemente después de un párrafo de cierre de sección, antes de abrir una nueva.
- Distribuidos uniformemente — no agrupes dos slots juntos.
Ejemplo correcto:
  <p>...cierre de sección...</p>
  <!-- AD_SLOT -->
  <p>...apertura de siguiente sección...</p>

REGLA CRÍTICA — DATOS:
Solo podés incluir un número, fecha exacta o estadística si está EXPLÍCITAMENTE en las fuentes de este prompt.
Si el dato no está → eliminalo o escribí "según se informó" sin el número.
NUNCA inferís, promedias ni completás datos desde conocimiento previo.
Para datos históricos sin fuente verificada: mencioná lahistoriariver.com sin inventar el dato.

OUTPUT: SOLO JSON válido (sin backticks):
{
  "titulo": "máx 70 chars",
  "bajada": "1-2 oraciones con el dato clave",
  "cuerpo": "HTML con <p> <strong> <em> <blockquote> <!-- AD_SLOT -->. Mínimo 15 párrafos. Mínimo 4 oraciones por párrafo.",
  "slug": "url-friendly, sin tildes, minúsculas, guiones",
  "metaDescription": "150-160 chars",
  "tags": ["tag1"],
  "categoria": "actualidad|analisis|historia|mercado|inferiores|opinion",
  "tiempoLectura": 8,  // calcular como Math.ceil(wordCount / 200)
  "keywords": ["kw1"],
  "datosVerificables": [
    { "dato": "River 4-1 Boca", "fuente": "cariverplate.com.ar", "verificado": true }
  ]
}`;

// ─── Prompt: Verificador + Árbitro autónomo ───────────────────────────────────
// Este prompt hace dos cosas en un solo llamado:
// 1. Verifica los datos contra las fuentes
// 2. Evalúa calidad editorial (coherencia, tono, errores de lógica)
// 3. Toma la decisión final de forma autónoma
const VERIFIER_SYSTEM = `Sos el editor jefe de desdeeltablon.com. Recibís una nota generada por IA y las fuentes originales.
Tu trabajo tiene DOS partes:

PARTE 1 — VERIFICACIÓN DE DATOS:
Chequeá cada dato duro (número, fecha, estadística, nombre, resultado) contra las fuentes.
Un dato "sin respaldo" es el que no aparece textualmente en ninguna de las fuentes provistas.

PARTE 2 — EVALUACIÓN EDITORIAL AUTÓNOMA:
Evaluás si la nota está apta para publicar en un medio serio sin ninguna intervención humana adicional.
Criterios de rechazo automático:
- Dato principal sin respaldo (el resultado del partido, el jugador que firma, la fecha del hecho)
- Contradicción interna (el titular dice una cosa, el cuerpo otra)
- Declaración atribuida que no está en las fuentes
- Tono sensacionalista que viola el estilo del medio (BOMBA:, LOCURA:, etc.)
- Nota que mezcla información de distintos partidos o mercados sin distinguirlos
- Dato numérico de mercado (valor de pase, salario) sin respaldo en fuente de nivel 1 o 2
- Nota demasiado corta: actualidad <1.400 palabras, analisis <2.300 palabras, historia <1.600 palabras, mercado <1.100 palabras
- Menos de 3 marcadores <!-- AD_SLOT --> en cualquier nota (independientemente de la extensión)

Criterios para reescribir (la nota tiene buena base pero un problema solucionable):
- 1-2 datos menores sin respaldo que se pueden eliminar sin romper la nota
- Un párrafo claramente fuera de tema (no se penaliza la longitud — las notas largas son el estándar del medio)
- Titular que no refleja bien el contenido

Criterios para publicar directamente:
- Todos los datos están respaldados por las fuentes
- No hay contradicciones
- El tono es correcto
- La estructura es periodísticamente sólida

IMPORTANTE: Tomás la decisión vos solo. No derivás al editor humano. Si la nota tiene problemas menores, indicás exactamente qué cambiar para la reescritura. Si tiene problemas graves, la descartás con explicación clara.

OUTPUT: SOLO JSON válido (sin backticks):
{
  "decision": "publicar" | "reescribir" | "descartar",
  "nivelConfianza": 0-100,
  "datosNoRespaldados": [
    { "dato": "texto exacto del dato", "problema": "explicación" }
  ],
  "problemasEditoriales": ["lista de problemas no relacionados con datos"],
  "instruccionesReescritura": "solo si decision=reescribir: qué cambiar exactamente",
  "razonDescarte": "solo si decision=descartar: razón clara y definitiva",
  "notasAprobacion": "solo si decision=publicar: confirmación de que todo está en orden"
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseJSON<T>(text: string): T {
  const clean = text.trim().replace(/^```[a-z]*\n?/g, '').replace(/\n?```$/g, '').trim();
  return JSON.parse(clean) as T;
}

function formatSources(articles: RawArticle[]): string {
  return articles.map(a => {
    const lines = [
      `== FUENTE: ${a.source} (Nivel ${a.level}) | ${a.publishedAt || 'reciente'} ==`,
      `Título: ${a.title}`,
      `Extracto: ${a.excerpt}`,
    ];
    if (a.structuredFacts) {
      const f = a.structuredFacts;
      if ('homeScore' in f) {
        const m = f as MatchFacts;
        lines.push(`DATOS VERIFICADOS: ${m.homeTeam} ${m.homeScore}-${m.awayScore} ${m.awayTeam} | ${m.competition} | ${m.date}`);
        if (m.venue) lines.push(`Estadio: ${m.venue}`);
        if (m.goals?.length) lines.push(`Goles: ${m.goals.map(g=>`${g.player} ${g.minute}' (${g.type})`).join(', ')}`);
        if (m.stats) lines.push(`Stats: ${Object.entries(m.stats).map(([k,v])=>`${k}: ${v}`).join(' | ')}`);
        if (m.keyMoments?.length) lines.push(`Momentos: ${m.keyMoments.join(' | ')}`);
      } else if ('confirmationLevel' in f) {
        const t = f as TransferFacts;
        const lvl = ['','CONFIRMADO OFICIAL','CONFIRMADO TRES MEDIOS','RUMOR SIN CONFIRMAR'][t.confirmationLevel];
        lines.push(`TRANSFERENCIA (${lvl}): ${t.player} | ${t.fromClub||'?'} → ${t.toClub||'?'} | ${t.type}`);
        if (t.fee) lines.push(`Monto: ${t.fee}`);
        if (t.contractUntil) lines.push(`Contrato hasta: ${t.contractUntil}`);
        lines.push(`Fuentes: ${t.sources.join(', ')}`);
      }
    }
    return lines.join('\n');
  }).join('\n\n');
}

type WriterOutput = Omit<GeneratedArticle, 'requiereRevision' | 'razonRevision' | 'pipelineAudit'>;

async function callWriter(sourcesText: string, extraInstructions?: string, categoria = 'actualidad'): Promise<WriterOutput> {
  const prompt = `Redactá una nota periodística original para desdeeltablon.com.
Solo usá hechos explícitamente presentes en las fuentes. Si un dato no está → no lo incluyas.

FUENTES:
${sourcesText}
${extraInstructions ? `\nINSTRUCCIONES ADICIONALES:\n${extraInstructions}` : ''}

Respondé SOLO con el JSON.`;

  const model = writerModelForCategory(categoria);
  const r = await anthropic.messages.create({
    model,
    // Analisis needs more tokens (2500-3500 words ≈ 5000-6000 output tokens + JSON)
    max_tokens: categoria === 'analisis' ? 8000 : 6500,
    system: WRITER_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const cost = estimateCost(model, r.usage.input_tokens, r.usage.output_tokens);
  const modelLabel = model.includes('opus') ? 'opus' : 'sonnet';
  console.log(`  ✍️  [${modelLabel}] ${r.usage.input_tokens}in/${r.usage.output_tokens}out $${cost.toFixed(4)}`);

  const text = (r.content[0] as { type: string; text: string }).text;
  const parsed = parseJSON<WriterOutput>(text);

  // Calculate reading time from actual word count (200 words/min average)
  const wordCount = parsed.cuerpo
    ? parsed.cuerpo.replace(/<[^>]*>/g, ' ').replace(/<!--[^>]*-->/g, '').split(/\s+/).filter(Boolean).length
    : 0;
  parsed.tiempoLectura = Math.max(4, Math.ceil(wordCount / 200));

  // Count ad slots actually inserted
  const adSlotCount = (parsed.cuerpo?.match(/<!-- AD_SLOT -->/g) || []).length;
  console.log(`  📝 ${wordCount} palabras · ${parsed.tiempoLectura} min · ${adSlotCount} ad slots`);

  return parsed;
}

interface VerifierOutput {
  decision: 'publicar' | 'reescribir' | 'descartar';
  nivelConfianza: number;
  datosNoRespaldados: Array<{ dato: string; problema: string }>;
  problemasEditoriales: string[];
  instruccionesReescritura?: string;
  razonDescarte?: string;
  notasAprobacion?: string;
}

async function callVerifier(article: WriterOutput, sourcesText: string): Promise<VerifierOutput> {
  const prompt = `FUENTES ORIGINALES:
${sourcesText}

---
NOTA GENERADA:
Ttulo: ${article.titulo}
Bajada: ${article.bajada}

${article.cuerpo.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}

---
DATOS QUE EL REDACTOR DECLARÓ INCLUIR:
${(article.datosVerificables || []).map(d => `- "${d.dato}" → fuente declarada: ${d.fuente}`).join('\n') || 'Ninguno declarado'}

Verificá los datos y evaluá si la nota está apta para publicación autónoma.
Respondé SOLO con el JSON.`;

  const r = await anthropic.messages.create({
    model: MODELS.verifier,
    max_tokens: 1000,
    system: VERIFIER_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const cost = estimateCost(MODELS.verifier, r.usage.input_tokens, r.usage.output_tokens);
  console.log(`  🔍 [opus/verif] ${r.usage.input_tokens}in/${r.usage.output_tokens}out $${cost.toFixed(4)}`);

  const text = (r.content[0] as { type: string; text: string }).text;
  return parseJSON<VerifierOutput>(text);
}

// ─── Main pipeline ────────────────────────────────────────────────────────────
// Returns null if the article was discarded after all attempts.
export async function rewriteArticle(
  rawArticles: RawArticle[],
  additionalContext?: string
): Promise<GeneratedArticle | null> {

  const sourcesText = formatSources(rawArticles) +
    (additionalContext ? `\n\nCONTEXTO ADICIONAL:\n${additionalContext}` : '');

  let writerAttempts = 0;
  const MAX_ATTEMPTS = 2;

  let article: WriterOutput | null = null;
  let verifierResult: VerifierOutput | null = null;
  let extraInstructions: string | undefined;

  while (writerAttempts < MAX_ATTEMPTS) {
    writerAttempts++;

    // Step 1: Write
    try {
      // Use category from previous attempt (if any) to pick the right model
      const categoria = article?.categoria ?? 'actualidad';
      article = await callWriter(sourcesText, extraInstructions, categoria);
    } catch (err) {
      console.error(`❌ Error en redacción (intento ${writerAttempts}):`, err);
      break;
    }

    // Step 2: Verify + decide
    try {
      verifierResult = await callVerifier(article, sourcesText);
    } catch (err) {
      console.error(`❌ Error en verificación (intento ${writerAttempts}):`, err);
      // If verifier fails, publish anyway (redactor constraints are still active)
      verifierResult = {
        decision: 'publicar',
        nivelConfianza: 60,
        datosNoRespaldados: [],
        problemasEditoriales: [],
        notasAprobacion: 'Verificador no disponible — publicado con restricciones del redactor activas',
      };
    }

    const decision = verifierResult.decision;
    console.log(`🔍 Verificación intento ${writerAttempts}: ${decision} (confianza ${verifierResult.nivelConfianza}%) | datos sin respaldo: ${verifierResult.datosNoRespaldados.length}`);

    if (decision === 'publicar') {
      // Mark verified datos
      if (article.datosVerificables) {
        const unverified = new Set(verifierResult.datosNoRespaldados.map(d => d.dato.toLowerCase().trim()));
        article.datosVerificables = article.datosVerificables.map(d => ({
          ...d,
          verificado: !unverified.has(d.dato.toLowerCase().trim()),
        }));
      }

      return {
        ...article,
        requiereRevision: false,
        razonRevision: null,
        pipelineAudit: {
          writerAttempts,
          verifierDecision: 'publicar',
          verifierNotes: verifierResult.notasAprobacion || 'Aprobado',
        },
      };
    }

    if (decision === 'reescribir' && writerAttempts < MAX_ATTEMPTS) {
      // Feed verifier instructions back to writer for second attempt
      const problems = [
        ...(verifierResult.datosNoRespaldados.map(d => `- Dato sin respaldo: "${d.dato}" — ${d.problema}`)),
        ...(verifierResult.problemasEditoriales.map(p => `- Problema editorial: ${p}`)),
      ].join('\n');

      extraInstructions = `CORRECCIONES REQUERIDAS PARA ESTE INTENTO:
${verifierResult.instruccionesReescritura || ''}
Problemas específicos a corregir:
${problems}
Eliminá o corregí estos puntos. No agregues nuevos datos que no estén en las fuentes.`;

      console.log(`♻️  Reescribiendo con correcciones (intento ${writerAttempts + 1})...`);
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }

    if (decision === 'descartar') break;
    if (decision === 'reescribir' && writerAttempts >= MAX_ATTEMPTS) break;
  }

  // Article was discarded or failed all attempts
  const reason = verifierResult?.razonDescarte ||
    (verifierResult?.decision === 'reescribir' ? `No superó verificación en ${MAX_ATTEMPTS} intentos` : 'Error en pipeline');

  console.log(`🗑️  Nota descartada: "${rawArticles[0].title.substring(0,50)}" — ${reason}`);

  // Log to discards table for admin audit
  logDiscard({
    originalTitle: rawArticles[0].title,
    reason,
    writerAttempts,
    datosProblema: verifierResult?.datosNoRespaldados || [],
    problemasEditoriales: verifierResult?.problemasEditoriales || [],
  });

  return null; // Pipeline caller skips saving
}

// ─── Discard log (audit trail) ────────────────────────────────────────────────
import { sqlite } from '../db/index.js';

export function initDiscardLog() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_discards (
      id           TEXT PRIMARY KEY,
      original_title TEXT NOT NULL,
      reason       TEXT NOT NULL,
      writer_attempts INTEGER DEFAULT 1,
      datos_problema TEXT,   -- JSON
      problemas_editoriales TEXT, -- JSON
      created_at   TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function logDiscard(data: {
  originalTitle: string;
  reason: string;
  writerAttempts: number;
  datosProblema: Array<{ dato: string; problema: string }>;
  problemasEditoriales: string[];
}) {
  try {
    const { v4: uuidv4 } = await import('uuid');
    sqlite.prepare(`
      INSERT INTO pipeline_discards
        (id, original_title, reason, writer_attempts, datos_problema, problemas_editoriales)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      data.originalTitle,
      data.reason,
      data.writerAttempts,
      JSON.stringify(data.datosProblema),
      JSON.stringify(data.problemasEditoriales),
    );
  } catch { /* non-critical */ }
}

// ─── Historical note ──────────────────────────────────────────────────────────
export async function generateHistoricalNote(
  dayMonth: string,
  historicalFact?: string
): Promise<GeneratedArticle | null> {
  const sources: RawArticle[] = [{
    source: historicalFact ? 'lahistoriariver.com' : 'contexto general',
    level: historicalFact ? 1 : 2,
    url: '',
    title: `Efeméride: ${dayMonth}`,
    excerpt: historicalFact || `Fecha ${dayMonth} — sin hecho específico verificado. Escribir con contexto general sin números exactos.`,
  }];
  return rewriteArticle(sources);
}

// ─── Tactical analysis ────────────────────────────────────────────────────────
export async function generateTacticalAnalysis(matchFacts: MatchFacts): Promise<GeneratedArticle | null> {
  const sources: RawArticle[] = [{
    source: 'Sofascore / FBref / cariverplate.com.ar',
    level: 1,
    url: '',
    title: `${matchFacts.homeTeam} ${matchFacts.homeScore}-${matchFacts.awayScore} ${matchFacts.awayTeam}`,
    excerpt: `Análisis ${matchFacts.competition} ${matchFacts.date}`,
    structuredFacts: matchFacts,
  }];
  return rewriteArticle(sources);
}

// ─── Transfer article ─────────────────────────────────────────────────────────
export async function generateTransferArticle(
  transferFacts: TransferFacts,
  additionalSources?: RawArticle[]
): Promise<GeneratedArticle | null> {
  const primary: RawArticle = {
    source: transferFacts.sources[0] || 'fuente especializada',
    level: transferFacts.confirmationLevel as 1 | 2 | 3,
    url: '',
    title: `${transferFacts.type}: ${transferFacts.player}`,
    excerpt: `${transferFacts.fromClub || '?'} → ${transferFacts.toClub || '?'}`,
    structuredFacts: transferFacts,
  };
  return rewriteArticle([primary, ...(additionalSources || [])]);
}
