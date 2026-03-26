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
import { MODELS, OPERATION_MODE, writerModelForCategory, estimateCost } from '../config/models.js';

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
Modo volume: notas concisas y directas. Cubrir el hecho con claridad, sin relleno.
- actualidad:  500 – 700 palabras
- analisis:    700 – 900 palabras
- historia:    500 – 700 palabras
- mercado:     400 – 600 palabras
- inferiores:  400 – 600 palabras
- opinion:     400 – 600 palabras

TÉCNICAS OBLIGATORIAS:
1. Presentá al protagonista en una sola oración si es necesario (no un párrafo entero).
2. Incluí el dato más relevante en el primer párrafo. No lo guardés para el final.
3. Si hay una cita, usala directamente sin párrafos de introducción largos.
4. No inventés estadísticas. Si no hay datos en las fuentes, no los pongas.

REGLAS DE REDACCIÓN:
1. Titulares: máximo 70 caracteres, sin clickbait, nombre real del jugador siempre.
2. Voz: periodismo deportivo argentino real. Urgente cuando el hecho lo pide. Irónico cuando corresponde. Nunca neutro ni académico.
3. Estructura obligatoria:
   — Lead (1 párrafo): arrancá con el hecho, no con contexto.
   — Desarrollo (2-3 párrafos): qué pasó, quiénes son los protagonistas, por qué importa.
   — Contexto rápido (1 párrafo): situación en el torneo o en el mercado.
   — Cierre (1 párrafo): consecuencia concreta o dato hacia adelante.
4. "torneo" no "temporada" · "Superclásico" con mayúscula · "el Monumental" · "River" o "el Millonario".
5. Citas siempre atribuidas. Escala mercado: (1) oficial (2) tres medios (3) se especula.

RITMO Y LONGITUD DE PÁRRAFOS — CRÍTICO:
Los párrafos NO deben ser todos iguales. Variá deliberadamente:
- Mayoría de párrafos: 3-5 oraciones (ritmo normal de análisis).
- Cada 4-5 párrafos: uno de 1-2 oraciones, solo para romper el ritmo y dar impacto.
- Nunca más de 5 párrafos seguidos de la misma longitud aproximada.
- Los párrafos de 1 oración reservalos para datos que necesitan énfasis brutal o para cierres de sección.
Ejemplo de alternancia correcta:
  [párrafo largo — análisis] [párrafo largo] [párrafo largo] [UNA SOLA ORACIÓN DE GOLPE] [párrafo largo]

PALABRAS Y FRASES PROHIBIDAS — NUNCA USARLAS:
Estas frases delatan redacción automática y serán rechazadas por el verificador:
- "no es menor" / "no es un dato menor"
- "vale la pena" / "vale destacar" / "vale mencionar"
- "en ese sentido" / "en este sentido"
- "cabe destacar" / "cabe señalar" / "cabe mencionar"
- "en el marco de"
- "en definitiva" (como conector vacío)
- "a todas luces"
- "resulta fundamental" / "resulta clave" / "resulta evidente"
- "más allá de" (como conector genérico)
- "sin lugar a dudas"
- "en lo que respecta a" / "en cuanto a" (al inicio de párrafo)
- "es importante destacar" / "es importante señalar"
- "el hecho de que"
- "a lo largo de" (salvo contexto literal temporal)
- "en el contexto de"
- "cobra relevancia" / "cobra importancia"
- "nos encontramos ante"
- "esto nos lleva a"
- Listas con guiones o bullets dentro del cuerpo de la nota
- Dos puntos seguidos de enumeración (": X, Y y Z") salvo citas textuales

VOZ Y ESTILO — LO QUE SÍ:
- Arrancá oraciones con el sujeto o con un verbo directo. Nunca con conector genérico.
- Usá la segunda persona del plural ocasionalmente: "Los hinchas de River saben que..."
- El tiempo presente es urgencia. Usalo en el lead y los momentos de clímax narrativo.
- Las digresiones están permitidas: una oración entre guiones que agregue color sin ser esencial.
- La ironía sutil está permitida cuando el contexto lo justifica.
- Usá los puntos suspensivos para generar tensión narrativa, no para evadir precisión.
- Las oraciones pueden empezar con "Y" o "Pero" cuando el ritmo lo exige.

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

PARTE 2 — EVALUACIÓN EDITORIAL:
El sistema opera en MODO VOLUMEN: las notas van a revisión humana antes de publicarse.
Tu único rol es detectar problemas GRAVES que harían la nota inutilizable.

Criterios de rechazo (solo los más graves):
- La nota está completamente vacía o es incoherente
- El titular contradice directamente el cuerpo
- La nota no tiene nada que ver con las fuentes provistas

Criterios para reescribir (solo si hay un error concreto y fácil de corregir):
- Un dato claramente incorrecto que sea el punto central de la nota

En TODOS los demás casos: decisión = "publicar".
No rechaces por longitud, estilo, frases, párrafos ni formato.
La revisión humana se encarga del resto.

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
    // En modo volume: salteamos el verifier completamente — el humano revisa
    if (OPERATION_MODE === 'volume') {
      verifierResult = {
        decision: 'publicar',
        nivelConfianza: 100,
        datosNoRespaldados: [],
        problemasEditoriales: [],
        notasAprobacion: 'Modo volume — aprobado sin verificación para revisión humana',
      };
    } else {
      try {
        verifierResult = await callVerifier(article, sourcesText);
      } catch (err) {
        console.error(`❌ Error en verificación (intento ${writerAttempts}):`, err);
        verifierResult = {
          decision: 'publicar',
          nivelConfianza: 60,
          datosNoRespaldados: [],
          problemasEditoriales: [],
          notasAprobacion: 'Verificador no disponible — publicado con restricciones del redactor activas',
        };
      }
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
