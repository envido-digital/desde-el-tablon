const API_BASE = import.meta.env.PUBLIC_API_URL || 'http://localhost:3001';

export interface Article {
  id: string;
  titulo: string;
  bajada: string;
  cuerpo?: string;
  slug: string;
  categoria: string;
  tags: string[];
  published_at: string;
  tiempo_lectura: number;
  featuredImage: { url: string; alt: string; source: string; author?: string; license: string } | null;
  views: number;
  importance_score?: number;
}

export interface StandingsRow {
  position: number;
  team: string;
  teamLogo: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
  form: string[];
  isRiver: boolean;
}

export interface StandingsResult {
  rows: StandingsRow[];
  label: string;
  competition: string;
  group: string;
}

export interface MatchData {
  id: string;
  homeTeam: string;
  homeTeamLogo?: string;
  awayTeam: string;
  awayTeamLogo?: string;
  homeScore: number | null;
  awayScore: number | null;
  status: 'NS' | 'LIVE' | 'FT' | 'HT' | 'TBD';
  minute: number | null;
  date: string;
  venue: string;
  competition: string;
}

async function apiFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

export async function getArticles(params?: {
  page?: number;
  limit?: number;
  categoria?: string;
  search?: string;
}): Promise<{ articles: Article[]; pagination: { page: number; limit: number; total: number; pages: number } } | null> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.categoria) qs.set('categoria', params.categoria);
  if (params?.search) qs.set('search', params.search);
  return apiFetch(`/api/articles?${qs}`);
}

export async function getArticleBySlug(slug: string): Promise<(Article & { sources?: unknown[]; embeds?: unknown[] }) | null> {
  return apiFetch(`/api/articles/slug/${slug}`);
}

export async function getFeaturedArticles(): Promise<Article[] | null> {
  return apiFetch('/api/articles/featured');
}

export async function getRelatedArticles(slug: string): Promise<Article[] | null> {
  return apiFetch(`/api/articles/related/${slug}`);
}

export async function getStandings(): Promise<StandingsRow[] | null> {
  return apiFetch('/api/sports/standings');
}

export async function getZonaStandings(): Promise<StandingsResult | null> {
  return apiFetch('/api/sports/standings-zona');
}

export async function getZonaAStandings(): Promise<StandingsResult | null> {
  return apiFetch('/api/sports/standings-zona-a');
}

export async function getCopaStandings(): Promise<StandingsResult | null> {
  return apiFetch('/api/sports/standings-copa');
}

export async function getNextMatch(): Promise<MatchData | null> {
  return apiFetch('/api/sports/next-match');
}

export async function getLastResult(): Promise<MatchData | null> {
  return apiFetch('/api/sports/last-result');
}

export async function getAdminStats(): Promise<{
  published: number;
  pending: number;
  rejected: number;
  todayPublished: number;
  totalViews: number;
  categories: Array<{ categoria: string; count: number }>;
} | null> {
  return apiFetch('/api/articles/admin/stats');
}

export async function getAdminQueue(): Promise<Article[] | null> {
  return apiFetch('/api/articles/admin/queue');
}

// Client-side: award reading points
export async function trackArticleRead(articleId: string, scrollPercentage: number, token: string) {
  try {
    const res = await fetch(`${API_BASE}/api/users/read-article`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ articleId, scrollPercentage }),
    });
    return res.json();
  } catch {
    return null;
  }
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 60) return `Hace ${minutes} min`;
  if (hours < 24) return `Hace ${hours}h`;
  if (days < 7) return `Hace ${days} días`;
  return date.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function getCategoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    actualidad: 'Actualidad',
    analisis: 'Análisis',
    historia: 'Historia',
    mercado: 'Mercado',
    inferiores: 'Inferiores',
    opinion: 'Opinión',
  };
  return labels[cat] || cat;
}

export function getCategoryColor(cat: string): string {
  const colors: Record<string, string> = {
    actualidad: 'bg-red-600 text-white',
    analisis: 'bg-blue-700 text-white',
    historia: 'bg-amber-700 text-white',
    mercado: 'bg-green-700 text-white',
    inferiores: 'bg-purple-700 text-white',
    opinion: 'bg-gray-700 text-white',
  };
  return colors[cat] || 'bg-gray-600 text-white';
}

// ─── Player API ───────────────────────────────────────────────────────────────
export interface PlayerProfile {
  id: string;
  slug: string;
  name: string;
  position: string | null;
  number: number | null;
  age: number | null;
  nationality: string | null;
  bio: string | null;
  comparison: string | null;
  stats: Array<[string, string]>;
  titles: string[];
  hist_link: string | null;
  status: string;
  transfer_status: string | null;
  transfer_note: string | null;
  enriched: number;
  articles: Article[];
}

export async function getPlayer(slug: string): Promise<PlayerProfile | null> {
  return apiFetch<PlayerProfile>(`/api/players/${encodeURIComponent(slug)}`);
}

export async function getAllPlayers(): Promise<PlayerProfile[] | null> {
  return apiFetch<PlayerProfile[]>('/api/players');
}

export async function getAllMatches(): Promise<{ upcoming: MatchData[]; results: MatchData[] } | null> {
  return apiFetch('/api/sports/all-matches');
}
