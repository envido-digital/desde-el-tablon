/**
 * TeamLogo — Smart logo component
 * =================================
 * Resolución en tres capas:
 *
 *   1. LOCAL MAP  → logos descargados por download_logos.py (< 1ms, sin red)
 *   2. API FETCH  → /api/logo/:teamName → Wikimedia Commons (1-3s, se cachea)
 *   3. INITIALS   → fallback generado en canvas (instantáneo, siempre funciona)
 *
 * La segunda vez que se muestra el mismo equipo (aunque sea en otro partido),
 * ya está cacheado en el backend y vuelve inmediato.
 */

import { useState, useEffect, useRef } from "react";

import { LOGOS } from "../lib/logos";

const API_BASE = typeof window !== "undefined"
  ? (import.meta.env?.PUBLIC_API_URL || "http://localhost:3001")
  : "http://localhost:3001";

// ─── In-memory runtime cache (per browser session) ───────────────────────────
const runtimeCache = new Map<string, string | null>();
const pendingFetches = new Map<string, Promise<string | null>>();

async function fetchLogo(teamName: string): Promise<string | null> {
  // Check runtime cache first
  if (runtimeCache.has(teamName)) {
    return runtimeCache.get(teamName)!;
  }

  // Deduplicate concurrent requests for the same team
  if (pendingFetches.has(teamName)) {
    return pendingFetches.get(teamName)!;
  }

  const promise = (async () => {
    try {
      const res = await fetch(
        `${API_BASE}/api/logo/${encodeURIComponent(teamName)}`,
        { signal: AbortSignal.timeout(8000) }
      );

      if (!res.ok) {
        runtimeCache.set(teamName, null);
        return null;
      }

      // Response is the actual image binary
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });

      runtimeCache.set(teamName, dataUrl);
      return dataUrl;
    } catch {
      runtimeCache.set(teamName, null);
      return null;
    } finally {
      pendingFetches.delete(teamName);
    }
  })();

  pendingFetches.set(teamName, promise);
  return promise;
}

// ─── Initials fallback generator ─────────────────────────────────────────────
function generateInitials(teamName: string, size: number): string {
  const initials = teamName
    .split(" ")
    .filter(w => !["de", "del", "el", "la", "los", "las", "y", "e", "FC", "SC", "CA", "CD"].includes(w))
    .map(w => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  // Generate on canvas
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Background
  const hue = teamName.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  ctx.fillStyle = `hsl(${hue}, 45%, 22%)`;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.15);
  ctx.fill();

  // Text
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = `700 ${size * 0.36}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials, size / 2, size / 2);

  return canvas.toDataURL("image/png");
}

// ─── Component ────────────────────────────────────────────────────────────────
interface TeamLogoProps {
  team: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  logoUrl?: string; // Direct URL from API (e.g. API-Football) — skips all lookups
}

type LogoState =
  | { status: "loading" }
  | { status: "local";    src: string }
  | { status: "remote";   src: string }
  | { status: "initials"; src: string };

export function TeamLogo({ team, size = 28, className, style, logoUrl }: TeamLogoProps) {
  const [state, setState] = useState<LogoState>(() => {
    // If a direct URL is provided, use it immediately — no lookup needed
    if (logoUrl) return { status: "remote", src: logoUrl };
    // Synchronous check: local map first
    if (LOGOS[team]) return { status: "local", src: LOGOS[team] };
    // Check runtime cache
    if (runtimeCache.has(team)) {
      const cached = runtimeCache.get(team);
      if (cached) return { status: "remote", src: cached };
    }
    return { status: "loading" };
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    // Already resolved synchronously
    if (state.status !== "loading") return;

    let cancelled = false;

    (async () => {
      // Try remote fetch
      const src = await fetchLogo(team);

      if (cancelled || !mountedRef.current) return;

      if (src) {
        setState({ status: "remote", src });
      } else {
        // Generate initials fallback
        const initialsUrl = generateInitials(team, size * 2); // 2x for retina
        setState({ status: "initials", src: initialsUrl });
      }
    })();

    return () => { cancelled = true; };
  }, [team, size, state.status]);

  // During loading, show a subtle placeholder
  if (state.status === "loading") {
    return (
      <div
        className={className}
        style={{
          width: size,
          height: size,
          borderRadius: 4,
          background: "rgba(255,255,255,0.05)",
          flexShrink: 0,
          animation: "pulse 1.5s ease-in-out infinite",
          ...style,
        }}
      />
    );
  }

  return (
    <img
      src={state.src}
      alt={team}
      title={team}
      width={size}
      height={size}
      className={className}
      style={{
        objectFit: "contain",
        flexShrink: 0,
        imageRendering: state.status === "initials" ? "crisp-edges" : "auto",
        ...style,
      }}
    />
  );
}

// ─── Preloader — call this on app startup to warm the cache ──────────────────
/**
 * Preload logos for teams currently on screen.
 * Call this in Home and Tabla components with the list of teams visible.
 *
 * Usage:
 *   useEffect(() => {
 *     preloadLogos(standings.map(r => r.team));
 *   }, [standings]);
 */
export async function preloadLogos(teamNames: string[]): Promise<void> {
  const unknown = teamNames.filter(
    t => !LOGOS[t] && !runtimeCache.has(t)
  );

  if (unknown.length === 0) return;

  // Batch request to backend
  try {
    const res = await fetch(`${API_BASE}/api/logo/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teams: unknown }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return;

    const data = await res.json() as { logos: Record<string, string | null> };

    // Populate runtime cache
    for (const [team, dataUrl] of Object.entries(data.logos)) {
      runtimeCache.set(team, dataUrl);
    }
  } catch {
    // Non-critical — individual fetches will handle it
  }
}
