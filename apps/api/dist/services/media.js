// Search Pexels for relevant sports images
async function searchPexels(query) {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey)
        return null;
    try {
        const encodedQuery = encodeURIComponent(`${query} football soccer argentina`);
        const res = await fetch(`https://api.pexels.com/v1/search?query=${encodedQuery}&per_page=3&orientation=landscape`, {
            headers: { Authorization: apiKey },
        });
        if (!res.ok)
            return null;
        const data = await res.json();
        if (!data.photos || data.photos.length === 0)
            return null;
        const photo = data.photos[0];
        return {
            url: photo.src.large,
            alt: photo.alt || query,
            source: 'Pexels',
            sourceUrl: photo.url,
            author: photo.photographer,
            license: 'Pexels License',
        };
    }
    catch {
        return null;
    }
}
// Search Unsplash for relevant images
async function searchUnsplash(query) {
    const accessKey = process.env.UNSPLASH_ACCESS_KEY;
    if (!accessKey)
        return null;
    try {
        const encodedQuery = encodeURIComponent(`${query} football`);
        const res = await fetch(`https://api.unsplash.com/search/photos?query=${encodedQuery}&per_page=3&orientation=landscape`, { headers: { Authorization: `Client-ID ${accessKey}` } });
        if (!res.ok)
            return null;
        const data = await res.json();
        if (!data.results || data.results.length === 0)
            return null;
        const photo = data.results[0];
        return {
            url: photo.urls.regular,
            alt: photo.alt_description || query,
            source: 'Unsplash',
            sourceUrl: photo.links.html,
            author: photo.user.name,
            license: 'Unsplash License',
        };
    }
    catch {
        return null;
    }
}
// Default River Plate related images (Wikimedia Commons CC0)
const DEFAULT_RIVER_IMAGES = [
    {
        url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Estadio_Monumental.jpg/1200px-Estadio_Monumental.jpg',
        alt: 'Estadio Monumental de River Plate',
        source: 'Wikimedia Commons',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Estadio_Monumental.jpg',
        license: 'CC BY-SA 4.0',
    },
    {
        url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2e/River_Plate_escudo.svg/480px-River_Plate_escudo.svg.png',
        alt: 'Club Atlético River Plate',
        source: 'Wikimedia Commons',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:River_Plate_escudo.svg',
        license: 'Public Domain',
    },
];
export async function findFeaturedImage(keywords) {
    const query = keywords.slice(0, 3).join(' ');
    // Try Pexels first
    const pexels = await searchPexels(query);
    if (pexels)
        return pexels;
    // Try Unsplash
    const unsplash = await searchUnsplash(query);
    if (unsplash)
        return unsplash;
    // Fall back to default River images
    const idx = Math.floor(Math.random() * DEFAULT_RIVER_IMAGES.length);
    return DEFAULT_RIVER_IMAGES[idx];
}
