// Schema documentation (actual tables created in db/index.ts via raw SQL)
// This file serves as type reference only

export interface Article {
  id: string;
  titulo: string;
  bajada: string | null;
  cuerpo: string;
  slug: string;
  meta_description: string | null;
  categoria: string;
  tags: string | null;
  keywords: string | null;
  status: string;
  importance_score: number;
  tiempo_lectura: number | null;
  featured_image: string | null;
  embeds: string | null;
  sources: string | null;
  author_id: string;
  requires_review: number;
  review_reason: string | null;
  published_at: string | null;
  updated_at: string;
  created_at: string;
  views: number;
}

export interface NewsSource {
  id: string; name: string; url: string; level: number;
  active: number; last_scraped: string | null;
  scrape_count: number; error_count: number; config: string | null;
}

export interface User {
  id: string; email: string; username: string; password_hash: string;
  avatar_url: string | null; level: number; total_points: number;
  email_verified: number; role: string; created_at: string;
}

export interface Badge {
  id: string; name: string; description: string | null;
  icon: string | null; points_required: number; condition: string | null;
}
