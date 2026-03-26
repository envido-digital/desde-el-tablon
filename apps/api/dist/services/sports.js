import { sqlite } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
// ─── Constantes ───────────────────────────────────────────────────────────────
const RIVER_ID = 435;
const LIGA_ID = 128;
const SUDAMERICANA_ID = 11;
const LIBERTADORES_ID = 13;
const SEASON = new Date().getFullYear(); // auto-actualiza cada año
const API_BASE = 'https://v3.football.api-sports.io';
// ─── Nombres canónicos por ID de equipo ───────────────────────────────────────
const TEAM_NAMES = {
    // River y grupo Copa Sudamericana 2026
    435: 'River Plate',
    3701: 'Blooming',
    2810: 'Carabobo',
    794: 'RB Bragantino',
    // Liga Profesional — nombres exactos
    463: 'Aldosivi',
    458: 'Argentinos Juniors',
    455: 'Atlético Tucumán',
    449: 'Banfield',
    2432: 'Barracas Central',
    440: 'Belgrano',
    451: 'Boca Juniors',
    790: 'Central Córdoba',
    1065: 'Central Córdoba',
    442: 'Defensa y Justicia',
    476: 'Deportivo Riestra',
    2424: 'Estudiantes de Río Cuarto',
    450: 'Estudiantes LP',
    434: 'Gimnasia LP',
    1066: 'Gimnasia de Mendoza',
    445: 'Huracán',
    453: 'Independiente',
    473: 'Independiente Rivadavia',
    478: 'Instituto',
    446: 'Lanús',
    457: "Newell's",
    1064: 'Platense',
    436: 'Racing Club',
    437: 'Rosario Central',
    460: 'San Lorenzo',
    474: 'Sarmiento',
    456: 'Talleres',
    452: 'Tigre',
    441: 'Unión',
    438: 'Vélez Sarsfield',
    // Otros
    439: 'Godoy Cruz',
    444: 'Patronato',
    448: 'Colón',
};
function normalizeTeamName(id, fallback) {
    return TEAM_NAMES[id] ?? fallback;
}
function getApiKey() {
    return process.env.API_FOOTBALL_KEY ?? '';
}
function apiFetch(path) {
    const key = getApiKey();
    if (!key)
        throw new Error('API_FOOTBALL_KEY no configurada');
    return fetch(`${API_BASE}${path}`, {
        headers: {
            'x-apisports-key': key,
            'Accept': 'application/json',
        },
    }).then(r => {
        if (!r.ok)
            throw new Error(`API-Football HTTP ${r.status}`);
        return r.json();
    });
}
// ─── Cache ────────────────────────────────────────────────────────────────────
function getCached(key, maxAgeMinutes) {
    const row = sqlite.prepare('SELECT data, cached_at FROM match_cache WHERE match_id = ?').get(key);
    if (!row)
        return null;
    const ageMinutes = (Date.now() - new Date(row.cached_at).getTime()) / 60000;
    if (ageMinutes > maxAgeMinutes)
        return null;
    return JSON.parse(row.data);
}
function setCache(key, data) {
    sqlite.prepare('INSERT OR REPLACE INTO match_cache (id, match_id, data, cached_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(uuidv4(), key, JSON.stringify(data));
}
// ─── Parsers ──────────────────────────────────────────────────────────────────
function parseStandingEntry(entry) {
    const isRiver = entry.team?.id === RIVER_ID;
    const form = (entry.form ?? '')
        .split('')
        .map((c) => c === 'W' ? 'W' : c === 'D' ? 'D' : 'L')
        .slice(-5);
    return {
        position: entry.rank ?? 0,
        team: normalizeTeamName(entry.team?.id, entry.team?.name ?? ''),
        teamLogo: entry.team?.logo ?? '',
        teamId: entry.team?.id ?? 0,
        played: entry.all?.played ?? 0,
        wins: entry.all?.win ?? 0,
        draws: entry.all?.draw ?? 0,
        losses: entry.all?.lose ?? 0,
        goalsFor: entry.all?.goals?.for ?? 0,
        goalsAgainst: entry.all?.goals?.against ?? 0,
        goalDiff: entry.goalsDiff ?? 0,
        points: entry.points ?? 0,
        form,
        isRiver,
    };
}
// ─── Traducción de competiciones ──────────────────────────────────────────────
function translateCompetition(league, round) {
    const leagueMap = {
        'Liga Profesional Argentina': 'Liga Profesional',
        'CONMEBOL Sudamericana': 'Copa Sudamericana',
        'CONMEBOL Libertadores': 'Copa Libertadores',
        'Copa Argentina': 'Copa Argentina',
        'Supercopa Argentina': 'Supercopa Argentina',
        'Recopa Sudamericana': 'Recopa Sudamericana',
    };
    const leagueEs = leagueMap[league] ?? league;
    if (!round)
        return leagueEs;
    const roundEs = round
        .replace(/Regular Season\s*-\s*(\d+)/i, 'Apertura · Fecha $1')
        .replace(/^Apertura\s*-\s*(\d+)$/i, 'Apertura · Fecha $1')
        .replace(/^Clausura\s*-\s*(\d+)$/i, 'Clausura · Fecha $1')
        .replace(/Group Stage\s*-\s*(\d+)/i, 'Fase de Grupos · Fecha $1')
        .replace(/Round of 128\s*-\s*\d+/i, '64avos de final')
        .replace(/Round of 64\s*-\s*\d+/i, '32avos de final')
        .replace(/Round of 32\s*-\s*\d+/i, '16avos de final')
        .replace(/Round of 16\s*-\s*\d+/i, 'Octavos de final')
        .replace(/Quarter-finals?\s*-\s*\d+/i, 'Cuartos de final')
        .replace(/Semi-finals?\s*-\s*\d+/i, 'Semifinal')
        .replace(/^Final\s*-\s*\d+$/i, 'Final')
        .replace(/1st Round\s*-\s*\d+/i, 'Primera ronda')
        .replace(/2nd Round\s*-\s*\d+/i, 'Segunda ronda')
        .replace(/3rd Round\s*-\s*\d+/i, 'Tercera ronda')
        .replace(/Playoff\s*-\s*\d+/i, 'Playoff');
    return `${leagueEs} · ${roundEs}`;
}
// ─── Normalización de venue ────────────────────────────────────────────────────
const MONUMENTAL = 'Estadio Mâs Monumental';
const VENUE_FIXES = {
    'Estadio Monumental': MONUMENTAL,
    'Estadio Monumental de Nunez': MONUMENTAL,
    'Estadio Antonio Vespucio Liberti': MONUMENTAL,
    'River Plate': MONUMENTAL,
    'Nabi Abi Chedid': 'Estadio Nabi Abi Chedid',
    'Estadio Monumental Jose Fierro': 'Estadio Monumental José Fierro',
};
// Fallback por ID del equipo local cuando la API no devuelve venue
const VENUE_BY_TEAM_ID = {
    436: 'Estadio Juan Domingo Perón', // Racing Club
    452: 'Estadio José Dellagiovanna', // Tigre
    794: 'Estadio Nabi Abi Chedid', // RB Bragantino
    434: 'Estadio Juan Carmelo Zerillo', // Gimnasia LP
    440: 'Estadio Julio César Villagra', // Belgrano
    438: 'Estadio José Amalfitani', // Vélez Sarsfield
    451: 'Estadio Alberto J. Armando', // Boca Juniors
    442: 'Estadio Norberto Tomaghello', // Defensa y Justicia
    446: 'Estadio Ciudad de Lanús', // Lanús
    460: 'Estadio Pedro Bidegain', // San Lorenzo
    445: 'Estadio Tomás A. Ducó', // Huracán
    449: 'Estadio Florencio Sola', // Banfield
    456: 'Estadio Mario Alberto Kempes', // Talleres
    437: 'Estadio Gigante de Arroyito', // Rosario Central
    457: 'Estadio Marcelo Bielsa', // Newell's
    450: 'Estadio Jorge Luis Hirschi', // Estudiantes LP
    458: 'Estadio Diego Armando Maradona', // Argentinos Juniors
    474: 'Estadio Eva Perón', // Sarmiento
    473: 'Estadio Bautista Gargantini', // Independiente Rivadavia
    1064: 'Estadio Ciudad de Vicente López', // Platense
    453: 'Estadio Libertadores de América', // Independiente
    476: 'Estadio Guillermo Laza', // Deportivo Riestra
    2432: 'Estadio Claudio Chiqui Tapia', // Barracas Central
    478: 'Estadio Juan Domingo Perón (Alta Córdoba)', // Instituto
    455: 'Estadio Monumental José Fierro', // Atlético Tucumán
    2810: 'Estadio Polideportivo Misael Delgado', // Carabobo
    3701: 'Estadio Ramón Tahuichi Aguilera', // Blooming
};
function normalizeVenue(venueName, isHome, homeTeamId) {
    if (isHome) {
        if (!venueName || VENUE_FIXES[venueName] === MONUMENTAL || venueName === 'River Plate') {
            return MONUMENTAL;
        }
        return VENUE_FIXES[venueName] ?? venueName;
    }
    // Visitante: usar fix si existe
    if (venueName && VENUE_FIXES[venueName])
        return VENUE_FIXES[venueName];
    // Usar venue de la API si está disponible y no es el nombre del equipo
    if (venueName && venueName !== 'River Plate')
        return venueName;
    // Fallback por ID del equipo local
    return VENUE_BY_TEAM_ID[homeTeamId] ?? '';
}
function parseFixture(fix) {
    const isHome = fix.teams?.home?.id === RIVER_ID;
    const homeTeam = normalizeTeamName(fix.teams?.home?.id, fix.teams?.home?.name ?? '');
    const awayTeam = normalizeTeamName(fix.teams?.away?.id, fix.teams?.away?.name ?? '');
    const hScore = fix.goals?.home;
    const aScore = fix.goals?.away;
    const statusShort = fix.fixture?.status?.short ?? 'NS';
    const status = statusShort === 'FT' || statusShort === 'AET' || statusShort === 'PEN' ? 'FT' :
        statusShort === 'HT' ? 'HT' :
            statusShort === '1H' || statusShort === '2H' || statusShort === 'ET' || statusShort === 'BT' ? 'LIVE' :
                statusShort === 'TBD' ? 'TBD' : 'NS';
    const homeTeamId = fix.teams?.home?.id ?? 0;
    const rawVenue = fix.fixture?.venue?.name ?? '';
    const venue = normalizeVenue(rawVenue, isHome, homeTeamId);
    const competition = translateCompetition(fix.league?.name ?? 'Liga Profesional', fix.league?.round ?? '');
    return {
        id: String(fix.fixture?.id ?? Date.now()),
        homeTeam,
        homeTeamLogo: fix.teams?.home?.logo,
        awayTeam,
        awayTeamLogo: fix.teams?.away?.logo,
        homeScore: typeof hScore === 'number' ? hScore : null,
        awayScore: typeof aScore === 'number' ? aScore : null,
        status,
        minute: fix.fixture?.status?.elapsed ?? null,
        date: fix.fixture?.date ?? new Date().toISOString(),
        venue,
        competition,
    };
}
// Normaliza nombres de grupo de la API: "Apertura, Group B" → "Zona B", "Group H" → "Grupo H"
function normalizeGroupName(raw, isLeague = true) {
    if (!raw)
        return isLeague ? 'Zona' : 'Grupo';
    // Strip phase prefix like "Apertura, " or "Clausura, "
    const stripped = raw.replace(/^(apertura|clausura|torneo)[,\s]+/i, '').trim();
    // Translate "Group X" → "Zona X" (liga) or "Grupo X" (copa)
    const translated = stripped
        .replace(/^group\s+/i, isLeague ? 'Zona ' : 'Grupo ')
        .replace(/^zona\s+/i, 'Zona ')
        .replace(/^grupo\s+/i, 'Grupo ');
    return translated || raw;
}
async function fetchLigaStandings() {
    const data = await apiFetch(`/standings?league=${LIGA_ID}&season=${SEASON}`);
    const standings = data?.response?.[0]?.league?.standings ?? [];
    if (standings.length === 0)
        throw new Error('Sin standings en Liga Profesional');
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const zones = standings.map((zone, idx) => {
        const raw = zone[0]?.group?.trim() || '';
        const groupName = normalizeGroupName(raw, true) || `Zona ${LETTERS[idx]}`;
        const rows = zone.map(parseStandingEntry);
        return { groupName, rows };
    });
    const zonaAData = zones[0];
    const zonaA = {
        rows: zonaAData.rows,
        label: `${zonaAData.groupName} · Liga Profesional`,
        competition: 'Liga Profesional',
        group: zonaAData.groupName,
    };
    const riverZoneData = zones.find(z => z.rows.some(r => r.isRiver)) ?? zonaAData;
    const zonaRiver = {
        rows: riverZoneData.rows,
        label: `${riverZoneData.groupName} · Liga Profesional`,
        competition: 'Liga Profesional',
        group: riverZoneData.groupName,
    };
    return { zonaRiver, zonaA };
}
// ─── Copa CONMEBOL — standings calculados desde fixtures de la API ─────────────
// La API Pro tiene fixtures pero no standings para copas internacionales.
// Calculamos la tabla a partir de los resultados de los partidos.
async function fetchCopaStandings() {
    const copas = [
        { id: SUDAMERICANA_ID, name: 'Copa Sudamericana' },
        { id: LIBERTADORES_ID, name: 'Copa Libertadores' },
    ];
    const errors = [];
    for (const copa of copas) {
        try {
            // Paso 1: traer fixtures de River en esta copa
            const riverData = await apiFetch(`/fixtures?league=${copa.id}&season=${SEASON}&team=${RIVER_ID}`);
            if (riverData?.errors && Object.keys(riverData.errors).length > 0) {
                errors.push(`${copa.name}: ${JSON.stringify(riverData.errors)}`);
                continue;
            }
            const riverFixtures = riverData?.response ?? [];
            const groupFixtures = riverFixtures.filter((f) => (f.league?.round ?? '').toLowerCase().includes('group'));
            if (groupFixtures.length === 0) {
                errors.push(`${copa.name}: sin fixtures de fase de grupos para River`);
                continue;
            }
            // Paso 2: identificar los 4 equipos del grupo y sus logos
            const teamMap = new Map();
            teamMap.set(RIVER_ID, {
                name: normalizeTeamName(RIVER_ID, 'River Plate'),
                logo: `https://media.api-sports.io/football/teams/${RIVER_ID}.png`,
            });
            const opponentIds = new Set();
            for (const fix of groupFixtures) {
                const homeId = fix.teams?.home?.id;
                const awayId = fix.teams?.away?.id;
                if (homeId)
                    teamMap.set(homeId, {
                        name: normalizeTeamName(homeId, fix.teams.home.name),
                        logo: fix.teams.home.logo,
                    });
                if (awayId)
                    teamMap.set(awayId, {
                        name: normalizeTeamName(awayId, fix.teams.away.name),
                        logo: fix.teams.away.logo,
                    });
                if (homeId && homeId !== RIVER_ID)
                    opponentIds.add(homeId);
                if (awayId && awayId !== RIVER_ID)
                    opponentIds.add(awayId);
            }
            // Paso 3: traer fixtures de UN oponente para obtener partidos entre rivales
            // (ej: Blooming vs Bragantino, Blooming vs Carabobo)
            const allFixtures = [...groupFixtures];
            const seenIds = new Set(groupFixtures.map((f) => f.fixture?.id));
            const groupTeamIds = [RIVER_ID, ...opponentIds];
            if (opponentIds.size > 0) {
                const [firstOpp] = opponentIds;
                const oppData = await apiFetch(`/fixtures?league=${copa.id}&season=${SEASON}&team=${firstOpp}`);
                const oppFixtures = oppData?.response ?? [];
                for (const fix of oppFixtures) {
                    const fid = fix.fixture?.id;
                    const homeId = fix.teams?.home?.id;
                    const awayId = fix.teams?.away?.id;
                    // Solo agregar si es fase de grupos Y entre equipos del mismo grupo Y no duplicado
                    if (!seenIds.has(fid) &&
                        (fix.league?.round ?? '').toLowerCase().includes('group') &&
                        groupTeamIds.includes(homeId) &&
                        groupTeamIds.includes(awayId)) {
                        allFixtures.push(fix);
                        seenIds.add(fid);
                    }
                }
            }
            // Paso 4: calcular standings desde los resultados
            const standingsMap = new Map();
            for (const id of groupTeamIds) {
                const info = teamMap.get(id);
                standingsMap.set(id, {
                    position: 0,
                    team: info.name,
                    teamLogo: info.logo,
                    teamId: id,
                    played: 0, wins: 0, draws: 0, losses: 0,
                    goalsFor: 0, goalsAgainst: 0, goalDiff: 0,
                    points: 0, form: [],
                    isRiver: id === RIVER_ID,
                });
            }
            const formMap = new Map();
            for (const id of groupTeamIds)
                formMap.set(id, []);
            for (const fix of allFixtures) {
                const homeId = fix.teams?.home?.id;
                const awayId = fix.teams?.away?.id;
                const hGoals = fix.goals?.home;
                const aGoals = fix.goals?.away;
                const statusShort = fix.fixture?.status?.short ?? 'NS';
                const isFinished = ['FT', 'AET', 'PEN'].includes(statusShort);
                if (!isFinished || hGoals === null || aGoals === null)
                    continue;
                const home = standingsMap.get(homeId);
                const away = standingsMap.get(awayId);
                if (!home || !away)
                    continue;
                home.played++;
                away.played++;
                home.goalsFor += hGoals;
                home.goalsAgainst += aGoals;
                away.goalsFor += aGoals;
                away.goalsAgainst += hGoals;
                home.goalDiff = home.goalsFor - home.goalsAgainst;
                away.goalDiff = away.goalsFor - away.goalsAgainst;
                if (hGoals > aGoals) {
                    home.wins++;
                    home.points += 3;
                    formMap.get(homeId).push('W');
                    formMap.get(awayId).push('L');
                    away.losses++;
                }
                else if (aGoals > hGoals) {
                    away.wins++;
                    away.points += 3;
                    formMap.get(awayId).push('W');
                    formMap.get(homeId).push('L');
                    home.losses++;
                }
                else {
                    home.draws++;
                    home.points++;
                    away.draws++;
                    away.points++;
                    formMap.get(homeId).push('D');
                    formMap.get(awayId).push('D');
                }
            }
            // Asignar form y ordenar
            const rows = [...standingsMap.values()]
                .map(row => ({ ...row, form: (formMap.get(row.teamId) ?? []).slice(-5) }))
                .sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goalsFor - a.goalsFor)
                .map((row, idx) => ({ ...row, position: idx + 1 }));
            // Determinar nombre del grupo (contar cuántos grupos hay antes del de River)
            // La API no lo expone directamente; usamos la posición del grupo dentro de la copa
            // Para Sudamericana 2026: Grupo H (River en el 8vo grupo = H)
            const groupName = 'Grupo H'; // Se actualizará dinámicamente si la API lo provee en el futuro
            console.log(`✅ ${copa.name} | ${groupName} | ${rows.length} equipos (calculado desde fixtures)`);
            return {
                rows,
                label: `${groupName} · ${copa.name}`,
                competition: copa.name,
                group: groupName,
            };
        }
        catch (e) {
            errors.push(`${copa.name}: ${e.message}`);
        }
    }
    throw new Error(`River no está en ninguna Copa CONMEBOL. ${errors.join(' / ')}`);
}
// ─── Partidos de River ─────────────────────────────────────────────────────────
async function fetchRiverFixtures() {
    const [nextData, lastData] = await Promise.all([
        apiFetch(`/fixtures?team=${RIVER_ID}&season=${SEASON}&next=20`),
        apiFetch(`/fixtures?team=${RIVER_ID}&season=${SEASON}&last=20`),
    ]);
    const upcoming = (nextData?.response ?? [])
        .map(parseFixture)
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const results = (lastData?.response ?? [])
        .map(parseFixture)
        .filter((m) => m.status === 'FT')
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return { upcoming, results };
}
// ─── Exports públicos (con caché) ─────────────────────────────────────────────
export async function getZonaStandings() {
    const key = `standings-zona-river-${SEASON}`;
    const cached = getCached(key, 30);
    if (cached)
        return cached;
    try {
        const { zonaRiver } = await fetchLigaStandings();
        setCache(key, zonaRiver);
        return zonaRiver;
    }
    catch (err) {
        console.log('⚠️ Zona River falló:', err.message);
        return { rows: getMockStandings(), label: 'Zona B · Liga Profesional', competition: 'Liga Profesional', group: 'Zona B' };
    }
}
export async function getZonaAStandings() {
    const key = `standings-zona-a-${SEASON}`;
    const cached = getCached(key, 30);
    if (cached)
        return cached;
    try {
        const { zonaA } = await fetchLigaStandings();
        setCache(key, zonaA);
        return zonaA;
    }
    catch (err) {
        console.log('⚠️ Zona A falló:', err.message);
        return { rows: [], label: 'Zona A · Liga Profesional', competition: 'Liga Profesional', group: 'Zona A' };
    }
}
export async function getCopaStandings() {
    const key = `standings-copa-${SEASON}`;
    const cached = getCached(key, 60);
    if (cached)
        return cached;
    try {
        const result = await fetchCopaStandings();
        setCache(key, result);
        return result;
    }
    catch (err) {
        console.log('⚠️ Copa standings falló:', err.message);
        return null;
    }
}
// Backward compat: getStandings devuelve la zona de River
export async function getStandings() {
    const result = await getZonaStandings();
    return result.rows;
}
export async function getNextMatch() {
    const key = `next-match-${RIVER_ID}-${SEASON}`;
    const cached = getCached(key, 60);
    if (cached)
        return cached;
    try {
        const data = await apiFetch(`/fixtures?team=${RIVER_ID}&season=${SEASON}&next=1`);
        const fix = data?.response?.[0];
        if (!fix)
            return getMockNextMatch();
        const match = parseFixture(fix);
        setCache(key, match);
        return match;
    }
    catch (err) {
        console.log('⚠️ Next match falló:', err.message);
        return getMockNextMatch();
    }
}
export async function getLastResult() {
    const key = `last-result-${RIVER_ID}-${SEASON}`;
    const cached = getCached(key, 120);
    if (cached)
        return cached;
    try {
        const data = await apiFetch(`/fixtures?team=${RIVER_ID}&season=${SEASON}&last=1`);
        const fix = data?.response?.[0];
        if (!fix)
            return getMockLastResult();
        const match = parseFixture(fix);
        setCache(key, match);
        return match;
    }
    catch (err) {
        console.log('⚠️ Last result falló:', err.message);
        return getMockLastResult();
    }
}
export async function getAllMatches() {
    const key = `all-matches-${RIVER_ID}-${SEASON}`;
    const cached = getCached(key, 60);
    if (cached)
        return cached;
    try {
        const data = await fetchRiverFixtures();
        setCache(key, data);
        console.log(`✅ getAllMatches: ${data.upcoming.length} próximos, ${data.results.length} resultados`);
        return data;
    }
    catch (err) {
        console.log('⚠️ getAllMatches falló:', err.message);
        return { upcoming: [], results: [] };
    }
}
// ─── Mocks (fallback si la API falla) ─────────────────────────────────────────
function getMockStandings() {
    return [
        { position: 1, team: 'Ind. Rivadavia', teamLogo: '', teamId: 0, played: 11, wins: 7, draws: 2, losses: 2, goalsFor: 18, goalsAgainst: 12, goalDiff: 6, points: 23, form: ['W', 'D', 'L', 'L', 'W'], isRiver: false },
        { position: 2, team: 'River Plate', teamLogo: '', teamId: 435, played: 11, wins: 6, draws: 2, losses: 3, goalsFor: 14, goalsAgainst: 9, goalDiff: 5, points: 20, form: ['W', 'W', 'L', 'W', 'D'], isRiver: true },
        { position: 3, team: 'Belgrano', teamLogo: '', teamId: 0, played: 11, wins: 5, draws: 4, losses: 2, goalsFor: 12, goalsAgainst: 9, goalDiff: 3, points: 19, form: ['L', 'W', 'D', 'W', 'L'], isRiver: false },
    ];
}
function getMockNextMatch() {
    return {
        id: 'mock-next',
        homeTeam: 'River Plate',
        awayTeam: 'Belgrano',
        homeScore: null, awayScore: null,
        status: 'NS', minute: null,
        date: new Date('2026-04-05T17:00:00Z').toISOString(),
        venue: 'Estadio Mâs Monumental',
        competition: 'Liga Profesional · Fecha 13',
    };
}
function getMockLastResult() {
    return {
        id: 'mock-last',
        homeTeam: 'Estudiantes RC',
        awayTeam: 'River Plate',
        homeScore: 0, awayScore: 2,
        status: 'FT', minute: null,
        date: new Date('2026-03-22T20:45:00Z').toISOString(),
        venue: 'Estadio Jorge Luis Hirschi',
        competition: 'Liga Profesional · Fecha 12',
    };
}
