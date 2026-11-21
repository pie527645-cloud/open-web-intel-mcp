import { assertPublicUrl, safeFetch, type SafeFetchDeps } from '../lib/safe-fetch.js';
import { extractAllXmlBlocks, extractXmlTag } from '../lib/xml.js';

/** Single URL entry extracted from an XML sitemap. */
export interface SitemapUrlEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
}

/** Input parameters for `crawlSitemap`. */
export interface CrawlSitemapInput {
  url: string;
  maxUrls?: number;
  maxDepth?: number;
  pathFilter?: string;
  timeoutMs?: number;
  deps?: SafeFetchDeps;
}

/** Structured output returned by `crawlSitemap`. */
export interface CrawlSitemapResult {
  targetUrl: string;
  robotsTxtFound: boolean;
  robotsSitemaps: string[];
  disallowedPaths: string[];
  sitemapsVisited: string[];
  sitemapErrors: Array<{ url: string; error: string }>;
  totalCollected: number;
  truncated: boolean;
  entries: SitemapUrlEntry[];
}

const MAX_SITEMAP_FETCHES = 15;

interface ParsedRobots {
  sitemaps: string[];
  disallowed: string[];
}

function parseRobotsTxt(text: string, origin: string): ParsedRobots {
  const sitemaps = new Set<string>();
  const disallowed = new Set<string>();
  let appliesToWildcardOrAll = true;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (!value) continue;

    if (directive === 'user-agent') {
      appliesToWildcardOrAll = value === '*';
    } else if (directive === 'sitemap') {
      try {
        sitemaps.add(new URL(value, origin).toString());
      } catch {
        // Ignore malformed sitemap URL
      }
    } else if (directive === 'disallow' && appliesToWildcardOrAll) {
      if (disallowed.size < 30) {
        disallowed.add(value);
      }
    }
  }

  return {
    sitemaps: [...sitemaps],
    disallowed: [...disallowed],
  };
}

function isDirectSitemapUrl(parsed: URL): boolean {
  const lowerPath = parsed.pathname.toLowerCase();
  return lowerPath.endsWith('.xml') || lowerPath.includes('sitemap');
}

/**
 * Discovers sitemaps via `robots.txt` or direct XML endpoints and recursively collects
 * structured URLs using the SSRF-safe fetcher.
 */
export async function crawlSitemap(input: CrawlSitemapInput): Promise<CrawlSitemapResult> {
  const maxUrls = input.maxUrls ?? 200;
  const maxDepth = input.maxDepth ?? 2;
  const timeoutMs = input.timeoutMs ?? 12_000;
  const filterLower = input.pathFilter?.trim().toLowerCase();

  const parsedTarget = await assertPublicUrl(input.url, input.deps);
  const origin = parsedTarget.origin;

  let robotsTxtFound = false;
  let robotsSitemaps: string[] = [];
  let disallowedPaths: string[] = [];
  const queue: Array<{ url: string; depth: number }> = [];

  if (isDirectSitemapUrl(parsedTarget)) {
    queue.push({ url: parsedTarget.toString(), depth: 0 });
  } else {
    try {
      const robotsRes = await safeFetch(`${origin}/robots.txt`, {
        timeoutMs,
        maxBytes: 512 * 1024,
        deps: input.deps,
      });
      if (robotsRes.ok && !robotsRes.contentType.includes('html')) {
        robotsTxtFound = true;
        const parsed = parseRobotsTxt(robotsRes.text, origin);
        robotsSitemaps = parsed.sitemaps;
        disallowedPaths = parsed.disallowed;
      }
    } catch {
      // Proceed to standard fallback sitemap paths if robots.txt fails
    }

    if (robotsSitemaps.length > 0) {
      for (const sm of robotsSitemaps) {
        queue.push({ url: sm, depth: 0 });
      }
    } else {
      queue.push({ url: `${origin}/sitemap.xml`, depth: 0 });
      queue.push({ url: `${origin}/sitemap_index.xml`, depth: 0 });
    }
  }

  const visitedSitemaps = new Set<string>();
  const sitemapErrors: Array<{ url: string; error: string }> = [];
  const seenLocs = new Set<string>();
  const entries: SitemapUrlEntry[] = [];
  let truncated = false;

  while (
    queue.length > 0 &&
    visitedSitemaps.size < MAX_SITEMAP_FETCHES &&
    entries.length < maxUrls
  ) {
    const current = queue.shift()!;
    if (visitedSitemaps.has(current.url)) continue;
    visitedSitemaps.add(current.url);

    let xmlText: string;
    try {
      const res = await safeFetch(current.url, {
        timeoutMs,
        maxBytes: 5 * 1024 * 1024,
        deps: input.deps,
      });
      if (!res.ok) {
        if (visitedSitemaps.size > 1 || queue.length === 0) {
          sitemapErrors.push({ url: current.url, error: `HTTP ${res.status}` });
        }
        continue;
      }
      xmlText = res.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sitemapErrors.push({ url: current.url, error: msg });
      continue;
    }

    // Handle <sitemapindex> child sitemaps
    const childBlocks = extractAllXmlBlocks(xmlText, 'sitemap');
    if (childBlocks.length > 0 && current.depth < maxDepth) {
      for (const block of childBlocks) {
        const loc = extractXmlTag(block, 'loc');
        if (loc && !visitedSitemaps.has(loc)) {
          queue.push({ url: loc, depth: current.depth + 1 });
        }
      }
    }

    // Handle <urlset> <url> entries
    const urlBlocks = extractAllXmlBlocks(xmlText, 'url');
    for (const block of urlBlocks) {
      const loc = extractXmlTag(block, 'loc');
      if (!loc || seenLocs.has(loc)) continue;
      if (filterLower && !loc.toLowerCase().includes(filterLower)) continue;

      seenLocs.add(loc);
      if (entries.length >= maxUrls) {
        truncated = true;
        break;
      }

      const lastmod = extractXmlTag(block, 'lastmod');
      const changefreq = extractXmlTag(block, 'changefreq');
      const priority = extractXmlTag(block, 'priority');

      entries.push({
        loc,
        ...(lastmod ? { lastmod } : {}),
        ...(changefreq ? { changefreq } : {}),
        ...(priority ? { priority } : {}),
      });
    }

    // Plain-text sitemap support (one URL per line)
    if (childBlocks.length === 0 && urlBlocks.length === 0 && /^https?:\/\//m.test(xmlText)) {
      for (const line of xmlText.split(/\r?\n/)) {
        const candidate = line.trim();
        if (!/^https?:\/\/\S+$/.test(candidate) || seenLocs.has(candidate)) continue;
        if (filterLower && !candidate.toLowerCase().includes(filterLower)) continue;
        seenLocs.add(candidate);
        if (entries.length >= maxUrls) {
          truncated = true;
          break;
        }
        entries.push({ loc: candidate });
      }
    }
  }

  if (queue.length > 0 && entries.length >= maxUrls) {
    truncated = true;
  }

  return {
    targetUrl: input.url,
    robotsTxtFound,
    robotsSitemaps,
    disallowedPaths,
    sitemapsVisited: [...visitedSitemaps],
    sitemapErrors,
    totalCollected: entries.length,
    truncated,
    entries,
  };
}
