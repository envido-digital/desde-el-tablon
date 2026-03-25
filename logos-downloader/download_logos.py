# -*- coding: utf-8 -*-
"""
desdeeltablon.com - Logo Downloader v3
Descarga escudos desde lahistoriariver.com (82 equipos)
Fuente: https://lahistoriariver.com/escudos/
"""
import requests, base64, time, sys, io, re
from pathlib import Path
from io import BytesIO

if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

try:
    from PIL import Image
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False
    print("Instala Pillow para optimizar: pip install Pillow")

BASE = 'https://lahistoriariver.com'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://lahistoriariver.com/',
}
TARGET_SIZE = (48, 48)

# Mapeo nombre Promiedos -> nombre lahistoriariver
# Clave = nombre exacto que devuelve Promiedos en /api/sports/standings
# Valor = path del escudo en lahistoriariver.com
TEAMS = {
    # ── Liga Profesional / Zona B actual ─────────────────────────
    "River Plate":                "/escudos/river-plate.png",
    "Independiente Rivadavia":    "/escudos/independienteriv.png",
    "Belgrano":                   "/escudos/belgrano.png",
    "Racing Club":                "/escudos/racing-club.png",
    "Rosario Central":            "/escudos/rosariocentral.png",
    "Tigre":                      "/escudos/tigre.png",
    "Barracas Central":           "/escudos/barracas.png",
    "Argentinos Juniors":         "/escudos/argentinos.png",
    "Huracán":                    "/escudos/huracan.png",
    "Gimnasia La Plata":          "/escudos/gimnasia-y-esgrima-la-plata.png",
    "Banfield":                   "/escudos/banfield.png",
    "Sarmiento Junín":            "/escudos/sarmiento.png",
    "Atlético Tucumán":           "/escudos/atleticotucuman.png",
    "Aldosivi":                   "/escudos/aldosivi.png",
    "Estudiantes RC":             "/escudos/estudiantesrc.png",
    # ── Zona A ──────────────────────────────────────────────────
    "Boca Juniors":               "/escudos/boca.png",
    "Vélez Sarsfield":            "/escudos/velez.png",
    "Independiente":              "/escudos/independiente.png",
    "San Lorenzo de Almagro":     "/escudos/sanlorenzo.png",
    "San Lorenzo":                "/escudos/sanlorenzo.png",
    "Estudiantes de La Plata":    "/escudos/estudiantes.png",
    "Estudiantes":                "/escudos/estudiantes.png",
    "Talleres de Córdoba":        "/escudos/talleres.png",
    "Talleres":                   "/escudos/talleres.png",
    "Defensa y Justicia":         "/escudos/defensayjusticia.png",
    "Instituto":                  "/escudos/instituto.png",
    "Colón de Santa Fe":          "/escudos/colon.png",
    "Colón":                      "/escudos/colon.png",
    "Platense":                   "/escudos/platense.png",
    "Patronato":                  "/escudos/patronato.png",
    "Godoy Cruz":                 "/escudos/godoycruz.png",
    "Newell's Old Boys":          "/escudos/newells.png",
    "Lanús":                      "/escudos/lanus.png",
    "Unión de Santa Fe":          "/escudos/union.png",
    "Unión":                      "/escudos/union.png",
    "Central Córdoba SdE":        "/escudos/centralcordoba.png",
    "Gimnasia de Mendoza":        "/escudos/gimnasiamendoza.png",
    "Deportivo Riestra":          "/escudos/riestra.png",
    # ── Copa Libertadores frecuentes ────────────────────────────
    "Fluminense":                 "/escudos/fluminense.png",
    "Palmeiras":                  "/escudos/palmeiras.png",
    "Flamengo":                   "/escudos/flamengo.png",
    "Atlético Mineiro":           "/escudos/atlmineiro.png",
    "Internacional":              "/escudos/internacional.png",
    "Gremio":                     "/escudos/gremio.png",
    "Sao Paulo":                  "/escudos/saopaulo.png",
    "Atlético Paranaense":        "/escudos/atlparanaense.png",
    "Cruzeiro":                   "/escudos/cruzeiro.png",
    "Nacional":                   "/escudos/nacional.png",
    "Cerro Porteño":              "/escudos/cerroporteno.png",
    "Olimpia":                    "/escudos/olimpia.png",
    "Colo Colo":                  "/escudos/colocolo.png",
    "LDU Quito":                  "/escudos/ligadequito.png",
    "Independiente del Valle":    "/escudos/independientedv.png",
    "Emelec":                     "/escudos/emelec.png",
    "Alianza Lima":               "/escudos/alianzalima.png",
    "Sporting Cristal":           "/escudos/sportingcristal.png",
    "The Strongest":              "/escudos/the_strongest.png",
    "Melgar":                     "/escudos/melgar.png",
    "Jorge Wilstermann":          "/escudos/jorge_wilstermann.png",
    "Junior":                     "/escudos/junior.png",
    "Atletico Nacional":          "/escudos/atletico_nacional.png",
    "Guarani":                    "/escudos/guarani.png",
    "Palestino":                  "/escudos/palestino.png",
    "Fortaleza":                  "/escudos/fortaleza.png",
}

def download_logo(path):
    url = BASE + path
    r = requests.get(url, headers=HEADERS, timeout=10)
    if r.status_code != 200 or len(r.content) < 200:
        raise Exception(f"HTTP {r.status_code} ({len(r.content)}B)")
    raw = r.content
    if HAS_PILLOW:
        try:
            img = Image.open(BytesIO(raw)).convert("RGBA")
            img.thumbnail(TARGET_SIZE, Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="PNG", optimize=True)
            raw = buf.getvalue()
        except Exception:
            pass
    return base64.b64encode(raw).decode()

print(f"Descargando {len(TEAMS)} logos desde lahistoriariver.com...\n")
results = {}
failed = []

for i, (name, path) in enumerate(TEAMS.items(), 1):
    try:
        b64 = download_logo(path)
        results[name] = f"data:image/png;base64,{b64}"
        kb = len(b64) * 3 / 4 / 1024
        print(f"  OK [{i:2d}/{len(TEAMS)}] {name} ({kb:.1f}KB)")
    except Exception as e:
        failed.append((name, str(e)))
        print(f"  FAIL [{i:2d}/{len(TEAMS)}] {name} - {e}")
    sys.stdout.flush()
    time.sleep(0.1)

print(f"\nDescargados: {len(results)}/{len(TEAMS)}")
if failed:
    print(f"Fallidos ({len(failed)}):")
    for n, e in failed:
        print(f"  - {n}: {e}")

lines = [
    "// logos.ts - Escudos desde lahistoriariver.com",
    f"// Equipos: {len(results)}",
    "",
    "export const LOGOS: Record<string, string> = {",
]
for name, data_url in results.items():
    lines.append(f'  "{name.replace(chr(34), chr(92)+chr(34))}": "{data_url}",')
lines += [
    "};",
    "",
    "export function getLogo(team: string): string | undefined {",
    "  return LOGOS[team];",
    "}",
]

Path("logos.ts").write_text("\n".join(lines), encoding="utf-8")
print(f"\nGenerado: logos.ts ({Path('logos.ts').stat().st_size // 1024}KB)")
print("Siguiente: mv logos.ts apps/web/src/lib/logos.ts")
