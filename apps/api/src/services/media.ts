export interface MediaAsset {
  url: string;
  alt: string;
  source: string;       // nombre del medio, ej: "Clarín"
  sourceUrl: string;    // URL del artículo fuente
  author?: string;
  license: string;
  caption?: string;     // epígrafe para mostrar al pie de la imagen
}

// Extrae og:image del HTML de una URL fuente — primer intento siempre
async function fetchOgImage(articleUrl: string): Promise<MediaAsset | null> {
  if (!articleUrl) return null;
  try {
    const res = await fetch(articleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    // Solo leer los primeros 15KB — los meta tags siempre están en el <head>
    const reader = res.body?.getReader();
    if (!reader) return null;
    let html = '';
    while (html.length < 15000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel();

    // Extraer og:image
    const imageMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!imageMatch?.[1]) return null;
    const imageUrl = imageMatch[1];
    if (!imageUrl.startsWith('http')) return null;

    // Extraer alt desde og:image:alt u og:title
    const altMatch =
      html.match(/<meta[^>]+property=["']og:image:alt["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const alt = altMatch?.[1]?.substring(0, 120) || 'Imagen del artículo';

    // Extraer nombre del sitio para el epígrafe
    const siteMatch =
      html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
    const siteName = siteMatch?.[1] || new URL(articleUrl).hostname.replace('www.', '');

    console.log(`🖼️  og:image obtenida de ${siteName}: ${imageUrl.substring(0, 60)}...`);

    return {
      url: imageUrl,
      alt,
      source: siteName,
      sourceUrl: articleUrl,
      license: 'all-rights-reserved',
      caption: `Imagen: ${siteName}`,
    };
  } catch {
    return null;
  }
}

// Search Pexels for relevant sports images
async function searchPexels(query: string): Promise<MediaAsset | null> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return null;

  try {
    const encodedQuery = encodeURIComponent(`${query} football soccer argentina`);
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodedQuery}&per_page=3&orientation=landscape`, {
      headers: { Authorization: apiKey },
    });

    if (!res.ok) return null;
    const data = await res.json() as { photos?: Array<{ src: { large: string }; alt: string; photographer: string; url: string }> };

    if (!data.photos || data.photos.length === 0) return null;

    const photo = data.photos[0];
    return {
      url: photo.src.large,
      alt: photo.alt || query,
      source: 'Pexels',
      sourceUrl: photo.url,
      author: photo.photographer,
      license: 'Pexels License',
    };
  } catch {
    return null;
  }
}

// Search Unsplash for relevant images
async function searchUnsplash(query: string): Promise<MediaAsset | null> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) return null;

  try {
    const encodedQuery = encodeURIComponent(`${query} football`);
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodedQuery}&per_page=3&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${accessKey}` } }
    );

    if (!res.ok) return null;
    const data = await res.json() as { results?: Array<{ urls: { regular: string }; alt_description: string; user: { name: string; links: { html: string } }; links: { html: string } }> };

    if (!data.results || data.results.length === 0) return null;

    const photo = data.results[0];
    return {
      url: photo.urls.regular,
      alt: photo.alt_description || query,
      source: 'Unsplash',
      sourceUrl: photo.links.html,
      author: photo.user.name,
      license: 'Unsplash License',
    };
  } catch {
    return null;
  }
}

// Default River Plate related images (Wikimedia Commons CC0)
const DEFAULT_RIVER_IMAGES: MediaAsset[] = [
  {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Estadio_Monumental.jpg/1200px-Estadio_Monumental.jpg',
    alt: 'Estadio Monumental de River Plate',
    source: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Estadio_Monumental.jpg',
    license: 'CC BY-SA 4.0',
  },
  {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Estadio_Monumental.jpg/1200px-Estadio_Monumental.jpg',
    alt: 'Estadio Monumental de River Plate',
    source: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Estadio_Monumental.jpg',
    license: 'CC BY-SA 4.0',
  },
];

export async function findFeaturedImage(keywords: string[], sourceUrl?: string): Promise<MediaAsset | null> {
  // 1. Intentar og:image del artículo fuente — mejor imagen, con epígrafe automático
  if (sourceUrl) {
    const ogImage = await fetchOgImage(sourceUrl);
    if (ogImage) return ogImage;
  }

  const query = keywords.slice(0, 3).join(' ');

  // Try Pexels first
  const pexels = await searchPexels(query);
  if (pexels) return pexels;

  // Try Unsplash
  const unsplash = await searchUnsplash(query);
  if (unsplash) return unsplash;

  // Fall back to default River images
  const idx = Math.floor(Math.random() * DEFAULT_RIVER_IMAGES.length);
  return DEFAULT_RIVER_IMAGES[idx];
}
