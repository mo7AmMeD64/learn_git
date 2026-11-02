/**
 * Cinema Box — Stremio addon for Cloudflare Workers (single file, no dependencies)
 *
 * Port of CinemaBoxProvider.kt (CloudStream).
 *
 * Stremio routes handled:
 *   /manifest.json
 *   /catalog/{type}/{id}[/{extra}].json
 *   /meta/{type}/{id}.json
 *   /stream/{type}/{id}.json
 *
 * ID scheme:
 *   cinemabox:{showId}      -> a movie or a series
 *   cinemabox:ep:{episode}  -> one episode of a series (player id)
 */

const API = "https://cinema.albox.co/api/v4";
const USER_AGENT = "Dalvik/2.1.0 (Linux; U; Android 14; 23043RP34G Build/UKQ1.240624.001)";
const PAGE_SIZE = 25;
const MAX_SEARCH_PAGES = 3;
const MAX_SEASONS = 20; // keeps one meta request under the 50 subrequest limit of the free plan
const PREFIX = "cinemabox:";
const EP_PREFIX = PREFIX + "ep:";

const CATEGORY_CATALOGS = [
  { id: "cb-movies", type: "movie", name: "أفلام", category: "18" },
  { id: "cb-series", type: "series", name: "مسلسلات", category: "20" },
  { id: "cb-anime", type: "series", name: "أنمي", category: "8" },
  { id: "cb-tv", type: "series", name: "برامج تلفزيونية", category: "9" },
  { id: "cb-cartoon", type: "series", name: "كرتون", category: "39" },
  { id: "cb-ramadan", type: "series", name: "رمضان", category: "50" },
];

const MANIFEST = {
  id: "community.cinemabox.albox",
  version: "1.0.0",
  name: "Cinema Box",
  description: "Cinema Box (cinema.albox.co) - أفلام ومسلسلات وأنمي مترجمة",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: [PREFIX],
  catalogs: [
    ...CATEGORY_CATALOGS.map((c) => ({
      type: c.type,
      id: c.id,
      name: c.name,
      extra: [{ name: "skip" }],
    })),
    { type: "movie", id: "cb-search-movie", name: "Cinema Box", extra: [{ name: "search", isRequired: true }] },
    { type: "series", id: "cb-search-series", name: "Cinema Box", extra: [{ name: "search", isRequired: true }] },
  ],
  behaviorHints: { configurable: false },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// ---------------------------------------------------------------- small helpers

const s = (v) => (v === null || v === undefined || typeof v === "object" ? null : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const objs = (v) => arr(v).filter((x) => x && typeof x === "object" && !Array.isArray(x));
const toInt = (v) => (v !== null && v !== undefined && /^-?\d+$/.test(String(v).trim()) ? parseInt(v, 10) : null);
const firstNumber = (t) => {
  const m = /\d+/.exec(t || "");
  return m ? parseInt(m[0], 10) : null;
};
const safeDecode = (x) => {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};

function json(data, ttl = 0, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": ttl > 0 ? `public, max-age=${ttl}` : "no-store",
    },
  });
}

/** Cache a finished response at the Cloudflare edge so repeated requests cost no CPU and no subrequests. */
async function withCache(request, ctx, producer) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const res = await producer();
  if (cache && res.status === 200 && /max-age=\d+/.test(res.headers.get("Cache-Control") || "")) {
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return res;
}

let DEVICE_ID = null;
function deviceId() {
  if (!DEVICE_ID) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    DEVICE_ID = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return DEVICE_ID;
}

function apiHeaders() {
  return {
    "Accept-Language": "en",
    "Device-Id": deviceId(),
    "Device-Model": "Xiaomi 23043RP34G",
    "Device-OS-Version": "14",
    "Device-Store": "googleplay",
    "App-Version": "4.6.12",
    "X-Hide-Sensitive-Content": "true",
    "X-Local-Before": "true",
    "X-ISP-ID": "1",
    "User-Agent": USER_AGENT,
  };
}

async function apiGet(path, ttl = 300) {
  try {
    const init = { headers: apiHeaders(), signal: AbortSignal.timeout(10000) };
    if (ttl > 0) init.cf = { cacheTtl: ttl, cacheEverything: true };
    const res = await fetch(`${API}/${path}`, init);
    if (!res.ok) return null;
    const data = JSON.parse(await res.text());
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- catalog

/** API card -> Stremio meta preview. Only MOVIE / SERIES cards are kept. */
function toPreview(card) {
  const id = s(card.id);
  const title = s(card.title)?.trim();
  const kind = (s(card.type) || "").toUpperCase();
  if (!id || !title || (kind !== "MOVIE" && kind !== "SERIES")) return null;
  const poster = s(card.style?.image);
  return {
    id: PREFIX + id,
    type: kind === "MOVIE" ? "movie" : "series",
    name: title,
    poster: poster || undefined,
  };
}

async function searchPage(term, page, categoryId) {
  const q = encodeURIComponent(term);
  const cat = categoryId ? `&category_id=${categoryId}` : "";
  const res = await apiGet(`search?page_size=${PAGE_SIZE}&page_number=${page}&term=${q}${cat}`, 300);
  if (!res) return { items: [], totalPages: 0 };
  const items = objs(res.results).map(toPreview).filter(Boolean);
  const totalPages = toInt(s(res.pagination?.total_pages)) ?? 1;
  return { items, totalPages };
}

async function searchAll(term) {
  const first = await searchPage(term, 1, null);
  let items = first.items;
  const last = Math.min(first.totalPages, MAX_SEARCH_PAGES);
  if (last > 1) {
    const rest = await Promise.all(
      Array.from({ length: last - 1 }, (_, i) => searchPage(term, i + 2, null))
    );
    for (const r of rest) items = items.concat(r.items);
  }
  return items;
}

function dedupe(metas) {
  const seen = new Set();
  return metas.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

async function getCatalog(catalogId, extra) {
  const skip = toInt(extra.skip) || 0;
  const search = (extra.search || "").trim();

  if (catalogId === "cb-search-movie" || catalogId === "cb-search-series") {
    if (!search) return [];
    const wanted = catalogId === "cb-search-movie" ? "movie" : "series";
    return dedupe((await searchAll(search)).filter((m) => m.type === wanted));
  }

  const cat = CATEGORY_CATALOGS.find((c) => c.id === catalogId);
  if (!cat) return [];
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const { items } = await searchPage("", page, cat.category);
  return dedupe(items);
}

// ---------------------------------------------------------------- meta

async function getDetails(id) {
  const enc = encodeURIComponent(id);
  let res = await apiGet(`shows/shows/dynamic/${enc}`, 600);
  if (!res || !res.post_info) res = await apiGet(`shows/shows/dynamic/${enc}?season_id=0`, 600);
  return res && res.post_info ? res : null;
}

const seasonCards = (sections) =>
  sections
    .flatMap((sec) => objs(sec.data))
    .filter(
      (c) =>
        (s(c.type) || "").toLowerCase() === "season" ||
        (s(c.card_type) || "").toLowerCase() === "seasonposter"
    );

/** Cards of the "episodes" section -> episode list for one season. */
function episodesOf(sections, seasonNumber) {
  const sec = sections.find((x) => s(x.section_type) === "episodes");
  const cards = sec ? objs(sec.data) : [];
  return cards
    .map((ep, index) => {
      const id = s(ep.id);
      if (!id) return null;
      const number = toInt(s(ep.description)) ?? firstNumber(s(ep.title)) ?? index + 1;
      const length = toInt(s(ep.length));
      return {
        id,
        season: seasonNumber,
        episode: number,
        thumb: s(ep.style?.image) || undefined,
        runtime: length ? Math.floor(length / 60) : undefined,
      };
    })
    .filter(Boolean);
}

async function loadSeasonEpisodes(showId, seasonId, seasonNumber) {
  // The details endpoint with ?season_id= returns that season's episodes.
  const res = await apiGet(`shows/shows/dynamic/${encodeURIComponent(showId)}?season_id=${encodeURIComponent(seasonId)}`, 600);
  if (res && s(res.post_info?.current_season_id) === seasonId) {
    const eps = episodesOf(objs(res.sections), seasonNumber);
    if (eps.length) return eps;
  }
  // Fallback: the dedicated season endpoint.
  const fallback = await apiGet(`shows/seasons/player/${encodeURIComponent(seasonId)}`, 600);
  return objs(fallback?.episodes)
    .map((ep, index) => {
      const id = s(ep.id);
      if (!id) return null;
      const length = toInt(s(ep.length));
      return {
        id,
        season: seasonNumber,
        episode: toInt(s(ep.episode_number)) ?? index + 1,
        thumb: s(ep.image) || undefined,
        runtime: length ? Math.floor(length / 60) : undefined,
      };
    })
    .filter(Boolean);
}

function youtubeId(url) {
  const m = /(?:youtu\.be\/|[?&]v=|embed\/)([\w-]{11})/.exec(url || "");
  return m ? m[1] : null;
}

async function getMeta(showId) {
  const details = await getDetails(showId);
  if (!details) return null;
  const info = details.post_info;
  const title = s(info.title)?.trim();
  if (!title) return null;

  const releaseMs = toInt(s(info.release_date));
  const year = releaseMs ? new Date(releaseMs).getUTCFullYear() : null;
  const genres = arr(info.genres).map((g) => s(g)?.trim()).filter(Boolean);
  const rating = info.rating && typeof info.rating === "object" ? info.rating : {};
  const age = s(rating.age);
  const description = [age, s(info.description)?.trim()].filter(Boolean).join("\n\n") || undefined;
  const sections = objs(details.sections);
  const trailer = youtubeId(s(objs(sections.find((x) => s(x.section_type) === "trailer")?.data)[0]?.url));
  const imdb = s(rating.value);

  const meta = {
    id: PREFIX + showId,
    type: "series",
    name: title,
    poster: s(info.image) || undefined,
    background: s(info.background_image) || undefined,
    description,
    releaseInfo: year ? String(year) : undefined,
    genres: genres.length ? genres : undefined,
    imdbRating: imdb && !Number.isNaN(parseFloat(imdb)) ? String(parseFloat(imdb)) : undefined,
    trailers: trailer ? [{ source: trailer, type: "Trailer" }] : undefined,
  };

  if ((s(info.type) || "").toUpperCase() === "MOVIE") {
    meta.type = "movie";
    const length = toInt(s(info.length));
    if (length) meta.runtime = `${Math.floor(length / 60)} min`;
    return meta;
  }

  // ---- series: every season card -> (season number, season id)
  const currentSeasonId = s(info.current_season_id);
  const seasons = [];
  const used = new Set();
  seasonCards(sections).forEach((card, index) => {
    const sid = s(card.id);
    if (!sid || seasons.some((x) => x.id === sid)) return;
    let number = firstNumber(s(card.title)) ?? index + 1;
    if (used.has(number)) number = Math.max(...used) + 1;
    used.add(number);
    seasons.push({ number, id: sid });
  });
  if (currentSeasonId && !seasons.some((x) => x.id === currentSeasonId)) {
    seasons.push({ number: toInt(s(info.season_number)) ?? 1, id: currentSeasonId });
  }

  let episodes = [];
  const limited = seasons.slice(0, MAX_SEASONS);
  for (let i = 0; i < limited.length; i += 6) {
    const batch = limited.slice(i, i + 6);
    const got = await Promise.all(batch.map((x) => loadSeasonEpisodes(showId, x.id, x.number)));
    episodes = episodes.concat(got.flat());
  }
  // Last resort: the "episodes" section of the details response (current season only).
  if (!episodes.length) episodes = episodesOf(sections, toInt(s(info.season_number)) ?? 1);

  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const nowYear = new Date().getUTCFullYear();
  const released = `${Math.min(year || 2000, nowYear)}-01-01T00:00:00.000Z`;
  const seen = new Set();
  meta.videos = episodes
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .map((e) => ({
      id: EP_PREFIX + e.id,
      title: `الحلقة ${e.episode}`,
      season: e.season,
      episode: e.episode,
      thumbnail: e.thumb,
      released,
    }));
  return meta;
}

// ---------------------------------------------------------------- streams

const LANGS = { ar: "ara", en: "eng", fr: "fre", tr: "tur", es: "spa" };
const qualityNumber = (q) => parseInt(String(q || "").replace(/\D/g, ""), 10) || 0;

async function getStreams(rawId) {
  let playerId;
  if (rawId.startsWith(EP_PREFIX)) {
    playerId = rawId.slice(EP_PREFIX.length);
  } else {
    const showId = rawId.slice(PREFIX.length);
    const details = await getDetails(showId);
    playerId = s(details?.post_info?.episode_id) || showId; // movies: episode_id, else the show id
  }

  const res = await apiGet(`shows/episodes/player/${encodeURIComponent(playerId)}`, 0);
  if (!res) return [];

  const subtitles = objs(res.subtitles)
    .map((sub, i) => {
      const url = s(sub.vtt) || s(sub.srt);
      if (!url) return null;
      const code = (s(sub.language) || "ar").toLowerCase();
      return { id: String(i), url, lang: LANGS[code] || code };
    })
    .filter(Boolean);

  return objs(res.videos)
    .map((v) => ({ url: s(v.url), quality: s(v.quality) || "" }))
    .filter((v) => v.url)
    .sort((a, b) => qualityNumber(b.quality) - qualityNumber(a.quality))
    .map((v) => ({
      name: v.quality ? `Cinema Box\n${v.quality}` : "Cinema Box",
      title: v.quality || "Cinema Box",
      url: v.url,
      subtitles: subtitles.length ? subtitles : undefined,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: { request: { "User-Agent": USER_AGENT } },
      },
    }));
}

// ---------------------------------------------------------------- router

function parseRoute(pathname) {
  const parts = pathname.replace(/^\/+/, "").split("/");
  if (parts.length < 3 || parts.length > 4) return null;
  const last = parts[parts.length - 1];
  if (!last.endsWith(".json")) return null;
  parts[parts.length - 1] = last.slice(0, -5);
  let extra = {};
  if (parts[3]) {
    const raw = parts[3];
    extra = Object.fromEntries(new URLSearchParams(raw.includes("=") ? raw : safeDecode(raw)));
  }
  return { resource: parts[0], type: safeDecode(parts[1]), id: safeDecode(parts[2]), extra };
}

function landing(url) {
  const manifestUrl = `${url.origin}/manifest.json`;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cinema Box - Stremio</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;max-width:560px;margin:0 auto;padding:24px 16px}
a.btn{display:block;background:#7b5bf5;color:#fff;text-align:center;padding:14px;border-radius:10px;text-decoration:none;margin:12px 0}
code{display:block;direction:ltr;text-align:left;background:#222;padding:10px;border-radius:8px;word-break:break-all}</style></head>
<body><h1>Cinema Box</h1><p>إضافة ستريميو. اضغط للتثبيت:</p>
<a class="btn" href="stremio://${url.host}/manifest.json">تثبيت في Stremio</a>
<p>أو انسخ الرابط وألصقه في Stremio &rarr; Addons:</p><code>${manifestUrl}</code></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET" && request.method !== "HEAD") return json({ err: "method not allowed" }, 0, 405);

    const url = new URL(request.url);
    if (url.pathname === "/") return landing(url);
    if (url.pathname === "/manifest.json") return json(MANIFEST, 3600);

    const route = parseRoute(url.pathname);
    if (!route) return json({ err: "not found" }, 0, 404);

    try {
      if (route.resource === "catalog") {
        return await withCache(request, ctx, async () => {
          const metas = await getCatalog(route.id, route.extra);
          return json({ metas, cacheMaxAge: 600 }, metas.length ? 600 : 0);
        });
      }

      if (route.resource === "meta") {
        if (!route.id.startsWith(PREFIX)) return json({ meta: null }, 0, 404);
        return await withCache(request, ctx, async () => {
          const meta = await getMeta(route.id.slice(PREFIX.length));
          if (!meta) return json({ meta: null }, 0, 404);
          return json({ meta, cacheMaxAge: 3600 }, 3600);
        });
      }

      if (route.resource === "stream") {
        if (!route.id.startsWith(PREFIX)) return json({ streams: [] });
        const streams = await getStreams(route.id);
        return json({ streams });
      }

      return json({ err: "not found" }, 0, 404);
    } catch (e) {
      return json({ err: String((e && e.message) || e) }, 0, 500);
    }
  },
};
