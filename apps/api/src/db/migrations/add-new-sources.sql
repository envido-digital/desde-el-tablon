-- Migración: agregar nuevas fuentes de noticias
-- Ejecutar si la DB ya está inicializada (el seed solo corre la primera vez)
-- Uso: sqlite3 data/desdeeltablon.db < migrations/add-new-sources.sql

-- Medios nacionales generalistas
INSERT OR IGNORE INTO news_sources (id, name, url, level, active, scrape_count, error_count)
VALUES
  ('clarin',   'Clarín Deportes',   'https://www.clarin.com/deportes/',   2, 1, 0, 0),
  ('la-nacion','La Nación Deportes','https://www.lanacion.com.ar/deportes/', 2, 1, 0, 0);

-- Fan sites especializados en River
INSERT OR IGNORE INTO news_sources (id, name, url, level, active, scrape_count, error_count)
VALUES
  ('lapaginamillonaria',  'La Página Millonaria',   'https://lapaginamillonaria.com',        3, 1, 0, 0),
  ('riverdesdelatribuna', 'River desde la Tribuna', 'https://riverdesdelatribuna.com.ar',    3, 1, 0, 0),
  ('rivernoticias',       'River Noticias',         'https://www.rivernoticias.com',         3, 1, 0, 0);
