# Logo Downloader — desdeeltablon.com

Descarga los escudos oficiales de los 55 equipos que aparecen en
`lahistoriariver.com` (Liga Profesional Argentina + rivales históricos
en Copa Libertadores e Intercontinental) y genera un archivo TypeScript
con todos los logos embebidos como base64.

## Prerequisitos

```bash
pip install requests Pillow
```

## Uso

```bash
python3 download_logos.py
```

El script genera `logos.ts` en el directorio donde se ejecuta.

## Mover al proyecto

```bash
mv logos.ts ../../apps/web/src/lib/logos.ts
```

## Importar en el código

```typescript
import { getLogo } from "@/lib/logos";

// En componentes:
<img src={getLogo("River Plate")} alt="River Plate" width={28} height={28} />
<img src={getLogo("Boca Juniors")} alt="Boca Juniors" width={28} height={28} />
<img src={getLogo("Flamengo")} alt="Flamengo" width={28} height={28} />
```

## Equipos incluidos (55)

### Liga Profesional Argentina (28)
River Plate, Boca Juniors, Racing Club, Independiente, San Lorenzo,
Estudiantes, Vélez, Lanús, Rosario Central, Newell's, Talleres,
Belgrano, Godoy Cruz, Huracán, Argentinos Juniors, Banfield, Colón,
Unión, Atlético Tucumán, Gimnasia LP, Platense, Tigre,
Defensa y Justicia, Instituto, Chacarita, Arsenal, Riestra, Barracas Central

### Copa Libertadores — Brasil (12)
Flamengo, Palmeiras, Fluminense, Grêmio, Cruzeiro, Atlético Mineiro,
Internacional, Athletico-PR, Corinthians, São Paulo, Santos, Vasco da Gama

### Copa Libertadores — Uruguay (2)
Nacional, Peñarol

### Copa Libertadores — Colombia (3)
América de Cali, Atlético Nacional, Millonarios

### Copa Libertadores — Chile (2)
Colo-Colo, Universidad de Chile

### Copa Libertadores — Paraguay (2)
Olimpia, Cerro Porteño

### Copa Libertadores — Ecuador (2)
LDU Quito, Barcelona SC

### Copa Libertadores — Perú (2)
Universitario, Alianza Lima

### Copa Libertadores — Bolivia (1)
Bolívar

### Intercontinental histórico (2)
Steaua București, Juventus

## Fuente de los logos

Todos los logos se descargan de **Wikimedia Commons** bajo licencias
de dominio público (CC0) o licencias libres. Cada escudo de fútbol
es una imagen de libre uso siempre que no se use para fines comerciales
que impliquen una afiliación falsa con el club.

## Notas técnicas

- Los logos se redimensionan a 48×48px con Pillow (mínimo necesario para
  visualización en la tabla y cards de partidos).
- El archivo `logos.ts` generado pesa aproximadamente 400-600KB.
- Al estar embebido como base64, no hay requests externos en runtime:
  cero latencia, cero dependencias, funciona offline.
- Si algún logo falla (URL rota en Wikimedia), el script lo reporta y
  continúa. El componente `TeamLogo` en el frontend tiene fallback con
  iniciales del equipo.
