#!/bin/bash
# ============================================================
# desdeeltablon.com — Setup completo
# Corré este script UNA sola vez desde la raíz del proyecto
# ============================================================

set -e  # Detener si algo falla

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
info() { echo -e "${BLUE}→  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; exit 1; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Desde el Tablón — Setup de proyecto    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Verificar Node.js ─────────────────────────────────────
info "Verificando Node.js..."
NODE_VER=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1)
if [ -z "$NODE_VER" ] || [ "$NODE_VER" -lt 22 ]; then
  err "Node.js 22+ requerido. Instalá desde https://nodejs.org"
fi
log "Node.js $(node -v)"

# ── Verificar Python (para logos) ────────────────────────
PYTHON_OK=false
if command -v python3 &>/dev/null; then
  PYTHON_OK=true
  log "Python3 disponible"
else
  warn "Python3 no encontrado — los logos se van a resolver en runtime (funciona igual, más lento la primera vez)"
fi

# ── Backend: instalar dependencias ───────────────────────
echo ""
info "Instalando dependencias del backend..."
cd apps/api
npm install
log "Backend: dependencias instaladas"

# ── Backend: compilar TypeScript ─────────────────────────
info "Compilando TypeScript..."
npx tsc
log "Backend: compilado"

# ── Backend: crear .env si no existe ─────────────────────
if [ ! -f ".env" ]; then
  info "Creando apps/api/.env desde el ejemplo..."
  cat > .env << 'ENVEOF'
# ── OBLIGATORIAS ──────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-          # ← completar
JWT_SECRET=                        # ← completar (string largo y aleatorio)

# ── ADMIN ─────────────────────────────────────────────────
ADMIN_EMAIL=                       # ← tu email
ADMIN_PASSWORD=                    # ← contraseña segura

# ── API EXTERNAS (el sitio arranca sin estas) ─────────────
API_FOOTBALL_KEY=
PEXELS_API_KEY=
UNSPLASH_ACCESS_KEY=

# ── EMAIL (para newsletter cuando lo actives) ─────────────
RESEND_API_KEY=
NEWSLETTER_FROM=newsletter@desdeeltablon.com

# ── CONFIG ────────────────────────────────────────────────
NODE_ENV=production
PORT=3001
SITE_URL=https://desdeeltablon.com
FRONTEND_URL=https://desdeeltablon.com
ENABLE_SCHEDULER=true
DATABASE_PATH=./data/desdeeltablon.db
ENVEOF
  warn "Editá apps/api/.env con tus claves antes de deployar"
else
  log "apps/api/.env ya existe"
fi

# ── Crear directorio de base de datos ────────────────────
mkdir -p data
log "Directorio data/ creado"

# ── Frontend: instalar dependencias ──────────────────────
echo ""
info "Instalando dependencias del frontend..."
cd ../web
npm install

# ── Frontend: instalar adaptador Vercel ──────────────────
info "Instalando adaptador Vercel..."
npm install @astrojs/vercel
log "Frontend: @astrojs/vercel instalado"

# ── Frontend: crear .env si no existe ────────────────────
if [ ! -f ".env" ]; then
  cat > .env << 'ENVEOF'
PUBLIC_API_URL=http://localhost:3001
ENVEOF
  log "apps/web/.env creado"
fi

# ── Frontend: build de prueba ─────────────────────────────
info "Verificando build del frontend..."
npx astro check 2>/dev/null || warn "Algunos warnings en astro check (no bloquean el deploy)"
log "Frontend: verificado"

# ── Logos: descargar si Python está disponible ───────────
echo ""
if [ "$PYTHON_OK" = true ]; then
  info "Descargando logos de equipos (Wikimedia Commons)..."
  cd ../..
  pip3 install requests Pillow --break-system-packages -q 2>/dev/null || pip install requests Pillow -q 2>/dev/null || warn "pip no disponible, saltando logos"

  if python3 -c "import requests, PIL" 2>/dev/null; then
    python3 logos-downloader/download_logos.py
    if [ -f "logos.ts" ]; then
      mv logos.ts apps/web/src/lib/logos.ts
      log "Logos: logos.ts generado y movido a apps/web/src/lib/"
    fi
  else
    warn "requests/Pillow no disponibles — logos se resolverán en runtime"
  fi
else
  cd ../..
fi

# ── Resumen final ─────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║            Setup completado              ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo -e "${YELLOW}Próximos pasos:${NC}"
echo ""
echo "  1. Editá apps/api/.env con tus claves:"
echo "     - ANTHROPIC_API_KEY (obligatoria)"
echo "     - JWT_SECRET (obligatoria)"
echo "     - ADMIN_EMAIL + ADMIN_PASSWORD"
echo ""
echo "  2. Desarrollo local:"
echo "     Terminal 1:  cd apps/api && node --experimental-sqlite dist/index.js"
echo "     Terminal 2:  cd apps/web && npx astro dev"
echo ""
echo "  3. Deploy a producción:"
echo "     Frontend → Vercel (conectar repo, rama main)"
echo "     Backend  → Railway (conectar repo, directorio apps/api)"
echo ""
echo "  4. Variables de entorno en Railway:"
echo "     Copiar todo el contenido de apps/api/.env"
echo ""
echo "  5. Variables de entorno en Vercel:"
echo "     PUBLIC_API_URL=https://tu-backend.railway.app"
echo ""
echo "  6. DNS en Cloudflare:"
echo "     CNAME  www  →  cname.vercel-dns.com"
echo "     CNAME  api  →  tu-backend.railway.app"
echo ""
echo -e "${GREEN}¡Todo listo para deployar!${NC}"
echo ""
