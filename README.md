# desdeeltablon.com

Medio de noticias autónomo sobre River Plate. Pipeline completamente automático con Claude AI.

## Setup en un comando

```bash
bash setup.sh
```

## Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `ANTHROPIC_API_KEY` | **Obligatoria.** Claude API |
| `JWT_SECRET` | **Obligatoria.** String aleatorio largo |
| `ADMIN_EMAIL` | Email del admin |
| `ADMIN_PASSWORD` | Contraseña del admin (mín. 8 chars + número) |
| `API_FOOTBALL_KEY` | Tabla y fixture (plan gratuito suficiente) |
| `PEXELS_API_KEY` | Imágenes para artículos |

## Deploy

**Backend → Railway**
- Conectar repositorio, directorio: `apps/api`
- Start command: `node --experimental-sqlite dist/index.js`
- Copiar variables de `apps/api/.env.example`

**Frontend → Vercel**
- Conectar repositorio, directorio: `apps/web`
- Variable: `PUBLIC_API_URL=https://tu-backend.railway.app`

**DNS → Cloudflare**
- `CNAME @ → cname.vercel-dns.com` (o A record de Vercel)

## Estructura

```
apps/
├── api/          Node.js + Express + SQLite
└── web/          Astro + React + Tailwind
```

## Stack

- **IA**: Anthropic Claude (Opus para verificación, Sonnet para redacción, Haiku para utilidades)
- **Backend**: Node.js 22 + Express + SQLite nativo
- **Frontend**: Astro 4 + React Islands + Tailwind CSS
- **Hosting**: Railway (backend) + Vercel (frontend) + Cloudflare (DNS/CDN)
- **Email**: Resend (newsletter, cuando se active)

## Costos estimados (10 artículos/día)

| Concepto | Costo/mes |
|---|---|
| Railway (backend) | $5 |
| Vercel (frontend) | $0 |
| Claude API (modelo mixto) | ~$43 |
| Dominio | ~$1.25 |
| **Total** | **~$50** |

Break-even: ~15.000 visitas/mes con AdSense.
