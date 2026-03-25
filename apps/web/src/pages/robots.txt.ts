import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const apiBase = import.meta.env.PUBLIC_API_URL || 'http://localhost:3001';
  try {
    const res = await fetch(`${apiBase}/robots.txt`);
    const text = await res.text();
    return new Response(text, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    const base = 'https://desdeeltablon.com';
    return new Response(
      `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /mi-cuenta\nDisallow: /api/\n\nSitemap: ${base}/sitemap.xml\n`,
      { headers: { 'Content-Type': 'text/plain' } }
    );
  }
};
