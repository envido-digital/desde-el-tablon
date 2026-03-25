import { sqlite } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';

const RIVER_PLATE_ID = 26;
const ARGENTINA_LEAGUE_ID = 128;
const PROMIEDOS_LIGA = 'https://www.promiedos.com.ar/league/liga-profesional/hc';
const PROMIEDOS_RIVER = 'https://www.promiedos.com.ar/team/river-plate/igi';
const PROMIEDOS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'es-AR,es;q=0.9',
};

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

export interface StandingsRow {
  position: number;
  team: string;
  teamLogo: string;
  teamId: number;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getVal(values: Array<{key: string; value: any}>, key: string): string {
  return values.find(v => v.key === key)?.value ?? '0';
}

function trendToForm(trend: number[]): string[] {
  // Promiedos: 0=derrota, 1=victoria, 2=empate
  return trend.slice(-5).map(t => t === 1 ? 'W' : t === 2 ? 'D' : 'L');
}

function getCached(key: string, maxAgeMinutes: number): unknown | null {
  const row = sqlite.prepare(
    'SELECT data, cached_at FROM match_cache WHERE match_id = ?'
  ).get(key) as { data: string; cached_at: string } | undefined;
  if (!row) return null;
  const ageMinutes = (Date.now() - new Date(row.cached_at).getTime()) / 60000;
  if (ageMinutes > maxAgeMinutes) return null;
  return JSON.parse(row.data);
}

function setCache(key: string, data: unknown) {
  sqlite.prepare(
    'INSERT OR REPLACE INTO match_cache (id, match_id, data, cached_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'
  ).run(uuidv4(), key, JSON.stringify(data));
}

// Extraer __NEXT_DATA__ JSON del HTML de Promiedos
function extractNextData(html: string): any {
  const start = html.indexOf('"__NEXT_DATA__"');
  if (start === -1) throw new Error('__NEXT_DATA__ no encontrado');
  const jsonStart = html.indexOf('>', start) + 1;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

// ─── Promiedos: tabla de posiciones ──────────────────────────────────────────
async function scrapePromiedosStandings(): Promise<StandingsRow[]> {
  const res = await fetch(PROMIEDOS_LIGA, { headers: PROMIEDOS_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Usar regex para extraer bloques de equipos (más robusto que __NEXT_DATA__ en la página de liga)
  const teamBlocks: any[] = [];
  const teamRegex = /\{"num":(\d+),"values":(\[.*?\]),"entity":\{"type":1,"object":\{"name":"([^"]+)"/g;
  let m;
  while ((m = teamRegex.exec(html)) !== null) {
    try {
      teamBlocks.push({ num: parseInt(m[1]), values: JSON.parse(m[2]), name: m[3] });
    } catch { /* ignorar */ }
  }

  if (teamBlocks.length === 0) throw new Error('Sin equipos en Promiedos');

  const riverBlock = teamBlocks.find(b => b.name.toLowerCase().includes('river plate') || b.name.toLowerCase() === 'river');
  if (!riverBlock) throw new Error('River no encontrado');

  const riverIdx = teamBlocks.indexOf(riverBlock);
  let groupStart = riverIdx;
  for (let i = riverIdx; i >= 0; i--) {
    if (teamBlocks[i].num === 1) { groupStart = i; break; }
  }
  let groupEnd = teamBlocks.length;
  for (let i = riverIdx + 1; i < teamBlocks.length; i++) {
    if (teamBlocks[i].num === 1) { groupEnd = i; break; }
  }

  const group = teamBlocks.slice(groupStart, groupEnd);

  return group.map(block => {
    const vals = block.values as Array<{key: string; value: any}>;
    const goals = (getVal(vals, 'Goals') || '0:0').split(':');
    const gf = parseInt(goals[0]) || 0;
    const gc = parseInt(goals[1]) || 0;
    const trend = vals.find(v => v.key === '{trend}')?.value ?? [];
    const isRiver = block.name.toLowerCase().includes('river');
    return {
      position: block.num, team: block.name, teamLogo: '',
      teamId: isRiver ? RIVER_PLATE_ID : 0,
      played: parseInt(getVal(vals, 'GamePlayed')) || 0,
      wins: parseInt(getVal(vals, 'GamesWon')) || 0,
      draws: parseInt(getVal(vals, 'GamesEven')) || 0,
      losses: parseInt(getVal(vals, 'GamesLost')) || 0,
      goalsFor: gf, goalsAgainst: gc, goalDiff: gf - gc,
      points: parseInt(getVal(vals, 'Points')) || 0,
      form: trendToForm(Array.isArray(trend) ? trend : []),
      isRiver,
    };
  }).sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff);
}

// ─── Promiedos: partidos de River via __NEXT_DATA__ ───────────────────────────
async function scrapePromiedosMatches(): Promise<{ next: MatchData | null; last: MatchData | null }> {
  const res = await fetch(PROMIEDOS_RIVER, { headers: PROMIEDOS_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const nextData = extractNextData(html);
  const games = nextData?.props?.pageProps?.data?.games;
  if (!games) throw new Error('No se encontró games en __NEXT_DATA__');

  function buildMatch(row: any, isHomeOverride?: boolean): MatchData | null {
    const game = row.game;
    if (!game) return null;

    const vals = row.values as Array<{key: string; value: any}>;
    const homeAway = getVal(vals, 'home_away');
    const isHome = isHomeOverride !== undefined ? isHomeOverride : homeAway === 'L';

    // teams[0] = local real, teams[1] = visitante real
    const teams = game.teams || [];
    if (teams.length < 2) return null;

    const riverInPos0 = teams[0]?.id === 'igi' || teams[0]?.name?.toLowerCase().includes('river');
    const opponent = riverInPos0 ? teams[1] : teams[0];

    const homeTeam = isHome ? 'River Plate' : opponent.name;
    const awayTeam = isHome ? opponent.name : 'River Plate';

    // Score
    let homeScore: number | null = null;
    let awayScore: number | null = null;
    if (game.scores && Array.isArray(game.scores) && game.scores.length >= 2) {
      if (riverInPos0) {
        // River es local real → scores[0]=River, scores[1]=rival
        homeScore = isHome ? game.scores[0] : game.scores[1];
        awayScore = isHome ? game.scores[1] : game.scores[0];
      } else {
        // River es visitante real → scores[0]=rival, scores[1]=River
        homeScore = isHome ? game.scores[1] : game.scores[0];
        awayScore = isHome ? game.scores[0] : game.scores[1];
      }
    }

    // Fecha: "05-04-2026 14:00" → ISO
    let dateStr = new Date().toISOString();
    try {
      const [datePart, timePart] = (game.start_time || '').split(' ');
      const [d, mo, y] = datePart.split('-');
      dateStr = new Date(`${y}-${mo}-${d}T${timePart}:00-03:00`).toISOString();
    } catch { /* usar fecha actual */ }

    const isPlayed = game.winner !== -1 && game.winner !== undefined;

    return {
      id: game.id || `promiedos-${Date.now()}`,
      homeTeam,
      awayTeam,
      homeScore: isPlayed ? homeScore : null,
      awayScore: isPlayed ? awayScore : null,
      status: isPlayed ? 'FT' : 'NS',
      minute: null,
      date: dateStr,
      venue: isHome ? 'Estadio Monumental' : (opponent.name || ''),
      competition: game.stage_round_name || 'Liga Profesional',
    };
  }

  // Próximo partido — primer row de games.next
  let nextMatch: MatchData | null = null;
  const nextRows = games.next?.rows || [];
  for (const row of nextRows) {
    const m = buildMatch(row);
    if (m) { nextMatch = m; break; }
  }

  // Último resultado — último row de games.last con winner !== -1
  let lastMatch: MatchData | null = null;
  const lastRows = (games.last?.rows || []) as any[];

  // Filtrar solo Liga Profesional y ordenar por fecha descendente
  const playedRows = lastRows.filter((row: any) => {
    const game = row.game;
    return game && game.winner !== -1 && game.winner !== undefined;
  });

  // Ordenar por fecha — más reciente primero
  playedRows.sort((a: any, b: any) => {
    const parseDate = (r: any) => {
      try {
        const [datePart, timePart] = (r.game?.start_time || '').split(' ');
        const [d, mo, y] = datePart.split('-');
        return new Date(`${y}-${mo}-${d}T${timePart || '00:00'}:00`).getTime();
      } catch { return 0; }
    };
    return parseDate(b) - parseDate(a);
  });

  if (playedRows.length > 0) {
    lastMatch = buildMatch(playedRows[0]);
  }

  return { next: nextMatch, last: lastMatch };
}

// ─── getStandings ─────────────────────────────────────────────────────────────
export async function getStandings(): Promise<StandingsRow[]> {
  const cacheKey = `standings-${ARGENTINA_LEAGUE_ID}`;
  const cached = getCached(cacheKey, 30) as StandingsRow[] | null;
  if (cached) return cached;

  try {
    const standings = await scrapePromiedosStandings();
    console.log('✅ Tabla Promiedos:', standings.length, 'equipos. River pos', standings.find(r => r.isRiver)?.position, 'pts', standings.find(r => r.isRiver)?.points);
    setCache(cacheKey, standings);
    return standings;
  } catch (err) {
    console.log('⚠️ Promiedos tabla falló:', (err as Error).message);
  }

  return getMockStandings();
}

// ─── getNextMatch ─────────────────────────────────────────────────────────────
export async function getNextMatch(): Promise<MatchData | null> {
  const cacheKey = `next-match-${RIVER_PLATE_ID}`;
  const cached = getCached(cacheKey, 60) as MatchData | null;
  if (cached) return cached;

  try {
    const { next } = await scrapePromiedosMatches();
    if (next) {
      console.log('✅ Próximo partido:', next.homeTeam, 'vs', next.awayTeam, next.date);
      setCache(cacheKey, next);
      return next;
    }
  } catch (err) {
    console.log('⚠️ Próximo partido falló:', (err as Error).message);
  }

  return getMockNextMatch();
}

// ─── getLastResult ────────────────────────────────────────────────────────────
export async function getLastResult(): Promise<MatchData | null> {
  const cacheKey = `last-result-${RIVER_PLATE_ID}`;
  const cached = getCached(cacheKey, 120) as MatchData | null;
  if (cached) return cached;

  try {
    const { last } = await scrapePromiedosMatches();
    if (last) {
      console.log('✅ Último resultado:', last.homeTeam, last.homeScore, '-', last.awayScore, last.awayTeam, '|', last.date);
      setCache(cacheKey, last);
      return last;
    }
  } catch (err) {
    console.log('⚠️ Último resultado falló:', (err as Error).message);
  }

  return getMockLastResult();
}


// ─── getAllMatches — todos los próximos y resultados ──────────────────────────
export async function getAllMatches(): Promise<{
  upcoming: MatchData[];
  results: MatchData[];
}> {
  const cacheKey = `all-matches-${RIVER_PLATE_ID}`;
  const cached = getCached(cacheKey, 60) as { upcoming: MatchData[]; results: MatchData[] } | null;
  if (cached) return cached;

  try {
    const res = await fetch(PROMIEDOS_RIVER, { headers: PROMIEDOS_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const nextData = extractNextData(html);
    const games = nextData?.props?.pageProps?.data?.games;
    if (!games) throw new Error('No games data');

    function buildRow(row: any): MatchData | null {
      const game = row.game;
      if (!game) return null;
      const vals = row.values as Array<{key: string; value: any}>;
      const homeAway = (vals.find((v: any) => v.key === 'home_away')?.value) || 'L';
      const isHome = homeAway === 'L';
      const teams = game.teams || [];
      if (teams.length < 2) return null;
      const riverInPos0 = teams[0]?.id === 'igi' || teams[0]?.name?.toLowerCase().includes('river');
      const opponent = riverInPos0 ? teams[1] : teams[0];
      const homeTeam = isHome ? 'River Plate' : opponent.name;
      const awayTeam = isHome ? opponent.name : 'River Plate';
      let homeScore: number | null = null;
      let awayScore: number | null = null;
      if (game.scores && Array.isArray(game.scores) && game.scores.length >= 2) {
        if (riverInPos0) {
          homeScore = isHome ? game.scores[0] : game.scores[1];
          awayScore = isHome ? game.scores[1] : game.scores[0];
        } else {
          homeScore = isHome ? game.scores[1] : game.scores[0];
          awayScore = isHome ? game.scores[0] : game.scores[1];
        }
      }
      let dateStr = new Date().toISOString();
      try {
        const [datePart, timePart] = (game.start_time || '').split(' ');
        const [d, mo, y] = datePart.split('-');
        dateStr = new Date(`${y}-${mo}-${d}T${timePart}:00-03:00`).toISOString();
      } catch { /* use current */ }
      const isPlayed = game.winner !== -1 && game.winner !== undefined;
      return {
        id: game.id || `promiedos-${Date.now()}`,
        homeTeam, awayTeam,
        homeScore: isPlayed ? homeScore : null,
        awayScore: isPlayed ? awayScore : null,
        status: isPlayed ? 'FT' : 'NS',
        minute: null, date: dateStr,
        venue: isHome ? 'Estadio Monumental' : opponent.name,
        competition: game.stage_round_name || 'Liga Profesional',
      };
    }

    const upcoming: MatchData[] = (games.next?.rows || []).map(buildRow).filter(Boolean) as MatchData[];

    const resultRows = [...(games.last?.rows || [])].filter((r: any) =>
      r.game?.winner !== -1 && r.game?.winner !== undefined
    );
    resultRows.sort((a: any, b: any) => {
      const parseDate = (r: any) => {
        try {
          const [dp, tp] = (r.game?.start_time || '').split(' ');
          const [d, mo, y] = dp.split('-');
          return new Date(`${y}-${mo}-${d}T${tp || '00:00'}:00`).getTime();
        } catch { return 0; }
      };
      return parseDate(b) - parseDate(a);
    });
    const results: MatchData[] = resultRows.map(buildRow).filter(Boolean) as MatchData[];

    const data = { upcoming, results };
    setCache(cacheKey, data);
    console.log(`✅ getAllMatches: ${upcoming.length} próximos, ${results.length} resultados`);
    return data;
  } catch (err) {
    console.log('⚠️ getAllMatches falló:', (err as Error).message);
    return { upcoming: [], results: [] };
  }
}

// ─── Mocks ────────────────────────────────────────────────────────────────────
function getMockStandings(): StandingsRow[] {
  return [
    { position:1,team:'Independiente Rivadavia',teamLogo:'',teamId:0,played:11,wins:7,draws:2,losses:2,goalsFor:18,goalsAgainst:12,goalDiff:6,points:23,form:['W','D','L','L','W'],isRiver:false },
    { position:2,team:'River Plate',teamLogo:'',teamId:26,played:11,wins:6,draws:2,losses:3,goalsFor:14,goalsAgainst:9,goalDiff:5,points:20,form:['W','W','L','W','D'],isRiver:true },
    { position:3,team:'Belgrano',teamLogo:'',teamId:0,played:11,wins:5,draws:4,losses:2,goalsFor:12,goalsAgainst:9,goalDiff:3,points:19,form:['L','W','D','W','L'],isRiver:false },
  ];
}

function getMockNextMatch(): MatchData {
  const d = new Date('2026-04-05T14:00:00-03:00');
  return { id:'mock-next',homeTeam:'River Plate',awayTeam:'Belgrano',homeScore:null,awayScore:null,status:'NS',minute:null,date:d.toISOString(),venue:'Estadio Monumental',competition:'Liga Profesional Fecha 13' };
}

function getMockLastResult(): MatchData {
  return { id:'mock-last',homeTeam:'Estudiantes RC',awayTeam:'River Plate',homeScore:0,awayScore:2,status:'FT',minute:null,date:new Date('2026-03-22T17:45:00-03:00').toISOString(),venue:'',competition:'Liga Profesional' };
}
