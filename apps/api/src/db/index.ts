import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../../data/desdeeltablon.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

export const sqlite = new DatabaseSync(DB_PATH);

sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');

export function initDb() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY, titulo TEXT NOT NULL, bajada TEXT, cuerpo TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL, meta_description TEXT, categoria TEXT NOT NULL,
      tags TEXT, keywords TEXT, status TEXT DEFAULT 'pending',
      importance_score REAL DEFAULT 0.5, tiempo_lectura INTEGER,
      featured_image TEXT, embeds TEXT, sources TEXT, author_id TEXT DEFAULT 'ai-system',
      requires_review INTEGER DEFAULT 1, review_reason TEXT, published_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      views INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS news_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, level INTEGER NOT NULL,
      active INTEGER DEFAULT 1, last_scraped TEXT, scrape_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0, config TEXT
    );
    CREATE TABLE IF NOT EXISTS scraped_items (
      id TEXT PRIMARY KEY, source_id TEXT, url TEXT NOT NULL, title_hash TEXT NOT NULL,
      raw_data TEXT, processed INTEGER DEFAULT 0, article_id TEXT,
      scraped_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, avatar_url TEXT, level INTEGER DEFAULT 1,
      total_points INTEGER DEFAULT 0, email_verified INTEGER DEFAULT 0,
      role TEXT DEFAULT 'reader', created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS point_transactions (
      id TEXT PRIMARY KEY, user_id TEXT, points INTEGER NOT NULL, action TEXT NOT NULL,
      article_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS badges (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, icon TEXT,
      points_required INTEGER DEFAULT 0, condition TEXT
    );
    CREATE TABLE IF NOT EXISTS user_badges (
      user_id TEXT, badge_id TEXT, earned_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, badge_id)
    );
    CREATE TABLE IF NOT EXISTS article_reads (
      user_id TEXT, article_id TEXT, read_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, article_id)
    );
    CREATE TABLE IF NOT EXISTS match_cache (
      id TEXT PRIMARY KEY, match_id TEXT UNIQUE, data TEXT NOT NULL,
      cached_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles(slug);
    CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status, published_at);
    CREATE INDEX IF NOT EXISTS idx_articles_categoria ON articles(categoria);
    CREATE INDEX IF NOT EXISTS idx_scraped_hash ON scraped_items(title_hash);
  `);

  const sourceCount = (sqlite.prepare('SELECT COUNT(*) as count FROM news_sources').get() as { count: number }).count;
  if (sourceCount === 0) {
    const ins = sqlite.prepare('INSERT OR IGNORE INTO news_sources (id,name,url,level,active,scrape_count,error_count) VALUES (?,?,?,?,1,0,0)');
    [['carp-oficial','River Plate Oficial','https://www.cariverplate.com.ar/noticias',1],
     ['ole','Olé','https://www.ole.com.ar/river-plate/',2],
     ['tycsports','TyC Sports','https://www.tycsports.com/futbol/river-plate',2],
     ['infobae','Infobae Deportes','https://www.infobae.com/deportes/river-plate/',2],
     ['afa','AFA','https://www.afa.com.ar/es/noticias/',1]].forEach(s => ins.run(...s));
  }

  const badgeCount = (sqlite.prepare('SELECT COUNT(*) as count FROM badges').get() as { count: number }).count;
  if (badgeCount === 0) {
    const ins = sqlite.prepare('INSERT OR IGNORE INTO badges (id,name,description,icon,points_required,condition) VALUES (?,?,?,?,?,?)');
    [['tablonero','Tablonero','Bienvenido al tablón','🏟️',0,'{"type":"register"}'],
     ['popular','Popular','Llegaste a 100 puntos','⚽',100,'{"type":"points","count":100}'],
     ['socio','Socio','300 puntos acumulados','🎫',300,'{"type":"points","count":300}'],
     ['hincha-fiel','Hincha Fiel','700 puntos — lector comprometido','🏅',700,'{"type":"points","count":700}'],
     ['millonario','Millonario','1500 puntos — sos de los nuestros','💎',1500,'{"type":"points","count":1500}'],
     ['leyenda','Leyenda del Millo','3000 puntos — la elite','👑',3000,'{"type":"points","count":3000}'],
     ['racha-7','Racha de 7','7 días seguidos leyendo','🔥',0,'{"type":"streak","days":7}'],
     ['analista','Analista','Leíste 10 análisis tácticos','📊',0,'{"type":"category_reads","category":"analisis","count":10}'],
     ['historiador','Historiador','Leíste 10 notas históricas','📜',0,'{"type":"category_reads","category":"historia","count":10}']
    ].forEach(b => ins.run(...b));
  }
  // Seed admin user from env vars — runs async after init
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPass  = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPass) {
    const existing = sqlite.prepare("SELECT id FROM users WHERE email=? OR role='admin'").get(adminEmail);
    if (!existing) {
      // Use bcrypt via dynamic import to avoid circular deps
      import('../lib/auth.js').then(async ({ hashPassword }) => {
        const { v4: uuidv4 } = await import('uuid');
        const hash = await hashPassword(adminPass);
        sqlite.prepare(
          "INSERT OR IGNORE INTO users (id,email,username,password_hash,role,email_verified,total_points) VALUES (?,?,?,?,'admin',1,0)"
        ).run(uuidv4(), adminEmail, 'admin', hash);
        console.log(`✅ Admin creado: ${adminEmail}`);
      }).catch(console.error);
    }
  }

  console.log('✅ Base de datos inicializada');
}
