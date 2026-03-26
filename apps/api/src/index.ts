import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import { initDb, sqlite } from './db/index.js';
import { requireAdmin } from './middleware/auth.js';
import { logoRouter } from './routes/logo.js';
import { newsletterRouter } from './routes/newsletter.js';
import { initLogoCache } from './services/logo-resolver.js';
import { articlesRouter } from './routes/articles.js';
import { sportsRouter, usersRouter } from './routes/sports-users.js';
import { startScheduler } from './scheduler.js';
import { runPipeline, generateDailyHistoricalNote } from './pipeline/publisher.js';

const app = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// ── Trust proxy (Railway está detrás de un proxy) ─────────────────────────────
app.set('trust proxy', 1);

// ── Security headers (helmet) ─────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'"],                      // AdSense added by frontend
      styleSrc:    ["'self'", "'unsafe-inline'"],    // inline styles in HTML emails
      imgSrc:      ["'self'", 'data:', 'https:'],
      connectSrc:  ["'self'"],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      objectSrc:   ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,  // needed for AdSense iframes
}));

// ── Compression (gzip) ────────────────────────────────────────────────────────
app.use(compression());

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:4321',
  'https://desdeeltablon.com',
  'https://www.desdeeltablon.com',
  'https://desde-el-tablon.vercel.app',
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} no permitido`));
  },
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// General API limit — alto porque Vercel SSR hace muchas requests desde la misma IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intentá de nuevo en 15 minutos.' },
  skip: (req) => {
    // Skip rate limiting for public read-only endpoints
    return req.path === '/health' 
      || req.path.startsWith('/api/articles')
      || req.path.startsWith('/api/sports')
      || req.path.startsWith('/api/logos');
  },
});

// Stricter limit for auth endpoints (login, register)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de autenticación. Intentá de nuevo en 15 minutos.' },
});

// Newsletter subscribe: 5 per hour per IP
const subscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de suscripción.' },
});

app.use('/api/users/login', authLimiter);
app.use('/api/users/register', authLimiter);
app.use('/api/newsletter/subscribe', subscribeLimiter);

// ── Body parser ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));  // was 10mb — no endpoint needs more than 100kb

// ── Request logging (only in dev) ────────────────────────────────────────────
if (!isProd) {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// ── Cache headers helper ──────────────────────────────────────────────────────
function setCacheHeaders(res: express.Response, seconds: number) {
  if (isProd) {
    res.setHeader('Cache-Control', `public, max-age=${seconds}, stale-while-revalidate=${seconds * 2}`);
  }
}

// Cache headers on public routes (not admin)
app.use('/api/articles', (req, res, next) => {
  if (req.method === 'GET' && !req.path.includes('/admin')) {
    setCacheHeaders(res, 60);  // articles list: 1 min
  }
  next();
}, articlesRouter);
app.use('/api/sports', (req, res, next) => {
  if (req.method === 'GET') setCacheHeaders(res, 300);  // sports data: 5 min
  next();
}, sportsRouter);
app.use('/api/logo', (req, res, next) => {
  if (req.method === 'GET') setCacheHeaders(res, 2592000);  // logos: 30 days
  next();
}, logoRouter);
app.use('/api/newsletter', newsletterRouter);
app.use('/api/users', usersRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', site: 'Desde el Tablón', timestamp: new Date().toISOString() }));

app.post('/api/admin/pipeline/run', requireAdmin, async (_req, res) => {
  console.log('🔄 Pipeline activado manualmente');
  const stats = await runPipeline();
  res.json({ success: true, stats });
});

app.post('/api/admin/pipeline/historical', requireAdmin, async (_req, res) => {
  const id = await generateDailyHistoricalNote();
  res.json({ success: true, articleId: id });
});

app.get('/robots.txt', (_req, res) => {
  const base = process.env.SITE_URL || 'https://desdeeltablon.com';
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /mi-cuenta',
    'Disallow: /api/',
    'Disallow: /newsletter/confirm',
    '',
    '# Crawl-delay for polite bots',
    'Crawl-delay: 1',
    '',
    `Sitemap: ${base}/sitemap.xml`,
  ].join('\n'));
});

app.get('/sitemap.xml', (_req, res) => {
  const articles = sqlite.prepare(
    "SELECT slug, published_at FROM articles WHERE status='published' ORDER BY published_at DESC LIMIT 1000"
  ).all() as Array<{ slug: string; published_at: string }>;

  const base = process.env.SITE_URL || 'https://desdeeltablon.com';
  const players = sqlite.prepare(
    "SELECT slug, updated_at FROM players WHERE status='active' ORDER BY updated_at DESC"
  ).all() as Array<{ slug: string; updated_at: string }>;

  const urls = [
    `<url><loc>${base}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${base}/tabla</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    `<url><loc>${base}/jugadores</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`,
    `<url><loc>${base}/noticias</loc><changefreq>hourly</changefreq><priority>0.9</priority></url>`,
    `<url><loc>${base}/acerca-de</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>`,
    ...articles.map(a => `<url><loc>${base}/noticias/${a.slug}</loc><lastmod>${a.published_at?.split('T')[0] || ''}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`),
    ...players.map(p => `<url><loc>${base}/jugadores/${p.slug}</loc><lastmod>${p.updated_at?.split('T')[0] || ''}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`),
  ];

  res.setHeader('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Don't leak stack traces in production
  if (isProd) {
    console.error('Unhandled error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
  console.error(err.stack);
  res.status(500).json({ error: err.message });
});

async function main() {
  initDb();
  initLogoCache();
  const { initNewsletterTables } = await import('./services/newsletter.js');
  initNewsletterTables();

  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║        Desde el Tablón — API Server            ║
║  River con memoria · desdeeltablon.com         ║
╠════════════════════════════════════════════════╣
║  Puerto: ${PORT}                                  ║
║  Claude AI: ${process.env.ANTHROPIC_API_KEY ? '✅ Configurado' : '⚠️  Sin API key (modo demo)'}      ║
╚════════════════════════════════════════════════╝
    `);
  });

  if (process.env.ENABLE_SCHEDULER === 'true') startScheduler();

  // Seed demo articles if DB is empty and no API key
  const count = (sqlite.prepare('SELECT COUNT(*) as c FROM articles').get() as { c: number }).c;
  if (count === 0) {
    if (process.env.ANTHROPIC_API_KEY) {
      console.log('📝 Generando contenido inicial con IA...');
      await generateDailyHistoricalNote();
    } else {
      console.log('📝 Insertando artículos de demo (sin API key)...');
      seedDemoArticles();
    }
  }
}

function seedDemoArticles() {
  const ins = sqlite.prepare(`
    INSERT OR IGNORE INTO articles (id, titulo, bajada, cuerpo, slug, meta_description, categoria, tags, keywords, status, importance_score, tiempo_lectura, published_at, views)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, datetime('now', ?), ?)
  `);

  const demos = [
    {
      id: 'demo-1',
      titulo: 'River Plate abre la temporada con ambición: el plantel está completo',
      bajada: 'El Millonario terminó el mercado de pases con incorporaciones clave y apunta a pelear en todos los frentes.',
      cuerpo: '<p>River Plate cerró un mercado de pases que refuerza la competitividad del plantel en todas las líneas. El cuerpo técnico tiene las variantes necesarias para afrontar la Liga Profesional y la Copa Libertadores con chances reales.</p><p>Las incorporaciones llegaron en los momentos clave. El refuerzo en el mediocampo era una necesidad detectada desde el torneo anterior, y la dirigencia respondió con dos jugadores que ya conocen la exigencia del fútbol argentino.</p><p>Históricamente, River ha construido sus mejores campañas sobre la base de una pretemporada ordenada. En 2018, año de la consagración histórica en Madrid, el equipo llegó al torneo con la misma sensación de equilibrio que transmite este plantel.</p><p>El desafío será mantener el nivel durante toda la temporada. Las rotaciones serán clave para llegar en condiciones a las instancias definitorias.</p>',
      slug: 'river-plate-abre-temporada-plantel-completo',
      meta: 'River Plate cerró el mercado de pases con el plantel completo para pelear en Liga Profesional y Copa Libertadores.',
      categoria: 'actualidad',
      tags: '["River Plate","mercado de pases","Liga Profesional"]',
      keywords: '["River Plate","temporada","plantel"]',
      score: 0.85, reading: 3, offset: '-2 hours', views: 247,
    },
    {
      id: 'demo-2',
      titulo: 'Análisis táctico: cómo River dominó el mediocampo ante Boca',
      bajada: 'El Millonario controló los espacios con una línea de cinco y aprovechó los errores de presión del rival.',
      cuerpo: '<p>El Superclásico dejó un análisis táctico claro: River fue superior en la zona medular del campo y aprovechó cada transición rápida para generar peligro. La propuesta del cuerpo técnico funcionó a la perfección durante los primeros 70 minutos.</p><p>La clave estuvo en la presión alta coordinada. Cuando River recuperaba la pelota en campo propio, la salida limpia hacia los costados generaba situaciones de superioridad numérica que Boca no pudo resolver.</p><p>Estadísticamente, River completó 487 pases con un 87% de efectividad. Los datos de pressing (PPDA de 7.2) confirman la intensidad defensiva con y sin pelota.</p><p>Este fue el mejor Superclásico de River desde la victoria en la Bombonera de 2019, cuando el equipo también dominó el mediocampo con una propuesta similar.</p><p>La continuidad del sistema es lo que más ilusiona de cara a la Copa Libertadores.</p>',
      slug: 'analisis-tactico-river-domino-mediocampo-boca',
      meta: 'Análisis táctico del Superclásico: River controló el mediocampo y ganó con autoridad ante Boca Juniors.',
      categoria: 'analisis',
      tags: '["Superclásico","análisis táctico","Boca Juniors"]',
      keywords: '["análisis táctico","River Plate","Superclásico"]',
      score: 0.9, reading: 5, offset: '-1 day', views: 1543,
    },
    {
      id: 'demo-3',
      titulo: 'Un día como hoy: River ganó la Libertadores en Madrid (2018)',
      bajada: 'A cinco años de la final más histórica del club, repasamos la noche que cambió para siempre la historia del Millonario.',
      cuerpo: '<p>El 9 de diciembre de 2018, el estadio Santiago Bernabéu de Madrid fue escenario de una de las páginas más gloriosas de la historia del fútbol argentino. River Plate venció a Boca Juniors 3-1 en la final de la Copa Libertadores más recordada de todos los tiempos.</p><p>Esa noche, Marcelo Gallardo diseñó una obra maestra táctica. El equipo salió a proponer, a jugar sin miedo, a imponer sus condiciones en el campo desde el primer minuto. Los goles de Palacios, Quintero y Pratto sentenciaron una final que comenzó igualada pero que tuvo un único protagonista: el Millonario.</p><p>Según el archivo de lahistoriariver.com, fue el cuarto título continental del club, pero el primero ganado en cancha neutral y contra el máximo rival. Una circunstancia que amplifica el valor histórico de aquella noche.</p><p>Cinco años después, aquella final sigue siendo el parámetro máximo de referencia para cada nueva campaña en el torneo continental.</p>',
      slug: 'dia-como-hoy-river-gano-libertadores-madrid-2018',
      meta: 'Un día como hoy: River Plate ganó la Copa Libertadores 2018 ante Boca Juniors en Madrid.',
      categoria: 'historia',
      tags: '["Copa Libertadores","historia","Madrid 2018"]',
      keywords: '["Libertadores 2018","River Plate historia","final Madrid"]',
      score: 0.75, reading: 4, offset: '-2 days', views: 892,
    },
    {
      id: 'demo-4',
      titulo: 'Claudio Echeverri: el 10 que River esperaba desde la era Saviola',
      bajada: 'Con apenas 19 años, el volante creativo ya es titular indiscutido y la comparación con Javier Saviola empieza a tomar forma.',
      cuerpo: '<p>Claudio Echeverri llegó a la primera de River con la etiqueta de ser el jugador más importante surgido de las inferiores del club en la última década. Con apenas 19 años, ya demostró que esa expectativa no era exagerada.</p><p>Su perfil técnico recuerda a los mejores mediapuntas que pasaron por el Monumental. La capacidad de asociarse en espacios reducidos, la visión de juego y el remate desde lejos son características que lo hacen diferente.</p><p>Los datos respaldan la sensación visual: según Sofascore, Echeverri promedia 2.3 regates exitosos por partido y 1.1 chances creadas en los 20 torneos que lleva en primera. Números que, a su edad, muy pocos jugadores argentinos han alcanzado.</p><p>La comparación con Javier Saviola, el último 10 generacional que emergió de las inferiores del club a tan corta edad, empieza a circular con más fuerza en cada partido que Echeverri convierte en espectáculo.</p>',
      slug: 'claudio-echeverri-10-river-esperaba-desde-era-saviola',
      meta: 'Perfil de Claudio Echeverri, el talento de 19 años que ya es titular en River Plate.',
      categoria: 'analisis',
      tags: '["Echeverri","inferiores","perfil"]',
      keywords: '["Echeverri River","juveniles River","10 River"]',
      score: 0.8, reading: 4, offset: '-3 days', views: 654,
    },
    {
      id: 'demo-5',
      titulo: 'River Sub-20 clasificó al hexagonal final del Torneo de Reserva',
      bajada: 'La reserva del Millonario continúa mostrando una generación prometedora con varios jugadores ya en órbita del primer equipo.',
      cuerpo: '<p>La reserva de River Plate selló su clasificación al hexagonal final del Torneo de Reserva con una victoria convincente que muestra la profundidad del semillero del club.</p><p>El modelo de inferiores que construyó River en los últimos quince años sigue produciendo jugadores con nivel para el primer equipo. La transición entre categorías es fluida, y varios juveniles de esta generación ya entrenaron con el plantel principal.</p><p>El hexagonal final enfrentará a River con los otros cinco mejores equipos del torneo en formato de liguilla. El historial del club en estas instancias es positivo.</p>',
      slug: 'river-sub-20-clasifico-hexagonal-final-reserva',
      meta: 'River Plate Sub-20 clasificó al hexagonal final del Torneo de Reserva.',
      categoria: 'inferiores',
      tags: '["Sub-20","Reserva","inferiores"]',
      keywords: '["River Plate Reserva","inferiores River","Sub-20"]',
      score: 0.65, reading: 3, offset: '-4 days', views: 312,
    },
    {
      id: 'demo-6',
      titulo: 'Mercado: River sigue de cerca a un delantero de la MLS',
      bajada: 'Según tres medios especializados, el Millonario evalúa el regreso de un jugador formado en el club que actualmente milita en los Estados Unidos.',
      cuerpo: '<p>Según informaron tres medios especializados, sin confirmación oficial del club, River Plate tiene en carpeta la incorporación de un delantero que actualmente juega en la Major League Soccer y que se formó en las inferiores del club.</p><p>El perfil buscado es claro: un nueve con presencia en el área, buen juego aéreo y capacidad para hacer hold-up play. Una característica que el plantel actual no tiene cubierta de manera ideal.</p><p>La operación depende de varios factores: la voluntad del jugador de regresar al fútbol argentino, la negociación entre clubes y el cupo de extranjeros. Desde el lado del futbolista, fuentes cercanas señalan que habría predisposición al regreso.</p><p>El mercado de verano cierra el 31 de enero. La dirigencia tiene margen para negociar, pero el tiempo se acorta.</p>',
      slug: 'mercado-river-sigue-delantero-mls',
      meta: 'River Plate evalúa incorporar a un delantero formado en el club que actualmente juega en la MLS.',
      categoria: 'mercado',
      tags: '["mercado de pases","incorporaciones","MLS"]',
      keywords: '["River mercado","incorporación River","mercado de pases"]',
      score: 0.7, reading: 3, offset: '-5 days', views: 421,
    },
  ];

  for (const d of demos) {
    ins.run(d.id, d.titulo, d.bajada, d.cuerpo, d.slug, d.meta, d.categoria,
            d.tags, d.keywords, d.score, d.reading, d.offset, d.views);
  }
  console.log(`✅ ${demos.length} artículos de demo insertados`);
}

main().catch(console.error);
