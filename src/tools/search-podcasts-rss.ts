import { assertPublicUrl, safeFetch, safeFetchJson, type SafeFetchDeps } from '../lib/safe-fetch.js';
import {
  extractAllXmlBlocks,
  extractXmlAttributes,
  extractXmlTag,
  htmlToPlainText,
} from '../lib/xml.js';

/** Episode item extracted from a podcast RSS feed. */
export interface PodcastEpisodeItem {
  title: string;
  publishedAt?: string;
  duration?: string;
  episodeUrl?: string;
  audioUrl?: string;
  summary: string;
}

/** Enriched podcast show metadata combining directory and RSS XML details. */
export interface PodcastShowIntel {
  title: string;
  author?: string;
  feedUrl: string;
  websiteUrl?: string;
  ownerName?: string;
  ownerEmail?: string;
  language?: string;
  categories: string[];
  artworkUrl?: string;
  description: string;
  totalEpisodesInFeed: number;
  rssFetched: boolean;
  rssError?: string;
  recentEpisodes: PodcastEpisodeItem[];
}

/** Input options for `searchPodcastsRss`. */
export interface SearchPodcastsRssInput {
  query: string;
  maxShows?: number;
  maxEpisodesPerShow?: number;
  country?: string;
  timeoutMs?: number;
  deps?: SafeFetchDeps;
}

/** Output returned by `searchPodcastsRss`. */
export interface SearchPodcastsRssResult {
  query: string;
  mode: 'direct-rss' | 'itunes-search';
  showsReturned: number;
  shows: PodcastShowIntel[];
}

interface ApplePodcastSearchResponse {
  resultCount?: number;
  results?: Array<{
    collectionName?: string;
    artistName?: string;
    feedUrl?: string;
    collectionViewUrl?: string;
    artworkUrl600?: string;
    primaryGenreName?: string;
    genres?: string[];
    trackCount?: number;
  }>;
}

function extractEmailCandidate(text?: string): string | undefined {
  if (!text) return undefined;
  const match = /\b[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,190}\.[a-zA-Z]{2,24}\b/.exec(text);
  return match?.[0]?.toLowerCase();
}

function parsePodcastRssXml(
  xml: string,
  feedUrl: string,
  maxEpisodes: number,
  fallbackMeta?: Partial<PodcastShowIntel>,
): PodcastShowIntel {
  // Isolate channel-level metadata prior to the first <item> so episode tags do not shadow show tags
  const firstItemIdx = xml.search(/<item\b/i);
  const channelHeader = firstItemIdx !== -1 ? xml.slice(0, firstItemIdx) : xml;

  const title = extractXmlTag(channelHeader, 'title') || fallbackMeta?.title || 'Untitled Podcast';
  const author =
    extractXmlTag(channelHeader, 'itunes:author') ||
    extractXmlTag(channelHeader, 'author') ||
    fallbackMeta?.author;
  const websiteUrl = extractXmlTag(channelHeader, 'link') || fallbackMeta?.websiteUrl;
  const language = extractXmlTag(channelHeader, 'language');
  const rawDesc =
    extractXmlTag(channelHeader, 'description') ||
    extractXmlTag(channelHeader, 'itunes:summary') ||
    '';

  const ownerBlock = extractAllXmlBlocks(channelHeader, 'itunes:owner')[0] ?? '';
  const ownerName = extractXmlTag(ownerBlock, 'itunes:name') || extractXmlTag(ownerBlock, 'name');
  const ownerEmail =
    extractEmailCandidate(extractXmlTag(ownerBlock, 'itunes:email')) ||
    extractEmailCandidate(extractXmlTag(channelHeader, 'itunes:email')) ||
    extractEmailCandidate(extractXmlTag(channelHeader, 'googleplay:email')) ||
    extractEmailCandidate(extractXmlTag(channelHeader, 'managingEditor'));

  const categoryAttrs = extractXmlAttributes(channelHeader, 'itunes:category', 'text');
  const categories = [
    ...new Set([...categoryAttrs, ...(fallbackMeta?.categories ?? [])].filter(Boolean)),
  ];

  const itunesImages = extractXmlAttributes(channelHeader, 'itunes:image', 'href');
  const artworkUrl = itunesImages[0] ?? fallbackMeta?.artworkUrl;

  const itemBlocks = extractAllXmlBlocks(xml, 'item');
  const recentEpisodes: PodcastEpisodeItem[] = itemBlocks.slice(0, maxEpisodes).map((item) => {
    const epTitle = extractXmlTag(item, 'title') ?? 'Untitled Episode';
    const publishedAt = extractXmlTag(item, 'pubDate');
    const duration = extractXmlTag(item, 'itunes:duration');
    const episodeUrl = extractXmlTag(item, 'link');
    const enclosures = extractXmlAttributes(item, 'enclosure', 'url');
    const audioUrl = enclosures[0];
    const epDesc =
      extractXmlTag(item, 'itunes:summary') ||
      extractXmlTag(item, 'description') ||
      extractXmlTag(item, 'content:encoded') ||
      '';

    return {
      title: epTitle,
      ...(publishedAt ? { publishedAt } : {}),
      ...(duration ? { duration } : {}),
      ...(episodeUrl ? { episodeUrl } : {}),
      ...(audioUrl ? { audioUrl } : {}),
      summary: htmlToPlainText(epDesc, 280),
    };
  });

  return {
    title,
    ...(author ? { author } : {}),
    feedUrl,
    ...(websiteUrl ? { websiteUrl } : {}),
    ...(ownerName ? { ownerName } : {}),
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(language ? { language } : {}),
    categories,
    ...(artworkUrl ? { artworkUrl } : {}),
    description: htmlToPlainText(rawDesc, 450),
    totalEpisodesInFeed: itemBlocks.length || fallbackMeta?.totalEpisodesInFeed || 0,
    rssFetched: true,
    recentEpisodes,
  };
}

/**
 * Searches podcasts via the public Apple Podcasts directory API (or inspects a direct RSS URL)
 * and parses each show's RSS XML feed for contact email, metadata, and recent episodes.
 */
export async function searchPodcastsRss(
  input: SearchPodcastsRssInput,
): Promise<SearchPodcastsRssResult> {
  const query = input.query.trim();
  if (!query) {
    throw new Error('Podcast search query or RSS URL must not be empty');
  }

  const maxShows = input.maxShows ?? 5;
  const maxEpisodes = input.maxEpisodesPerShow ?? 3;
  const country = (input.country ?? 'US').trim().toUpperCase();
  const timeoutMs = input.timeoutMs ?? 12_000;

  if (/^https?:\/\//i.test(query)) {
    const validated = await assertPublicUrl(query, input.deps);
    const rssRes = await safeFetch(validated.toString(), {
      timeoutMs,
      maxBytes: 5 * 1024 * 1024,
      deps: input.deps,
    });
    if (!rssRes.ok) {
      throw new Error(`HTTP ${rssRes.status} fetching podcast RSS feed ${rssRes.finalUrl}`);
    }
    const show = parsePodcastRssXml(rssRes.text, rssRes.finalUrl, maxEpisodes);
    return {
      query,
      mode: 'direct-rss',
      showsReturned: 1,
      shows: [show],
    };
  }

  const searchUrl =
    `https://itunes.apple.com/search?media=podcast&entity=podcast` +
    `&term=${encodeURIComponent(query)}&country=${encodeURIComponent(country)}&limit=${maxShows}`;

  const directoryData = await safeFetchJson<ApplePodcastSearchResponse>(searchUrl, {
    timeoutMs,
    maxBytes: 2 * 1024 * 1024,
    deps: input.deps,
  });

  const candidates = (directoryData.results ?? [])
    .filter((r): r is NonNullable<typeof r> & { feedUrl: string } => Boolean(r?.feedUrl))
    .slice(0, maxShows);

  const shows = await Promise.all(
    candidates.map(async (item): Promise<PodcastShowIntel> => {
      const fallback: PodcastShowIntel = {
        title: item.collectionName?.trim() || 'Untitled Podcast',
        ...(item.artistName ? { author: item.artistName } : {}),
        feedUrl: item.feedUrl,
        ...(item.collectionViewUrl ? { websiteUrl: item.collectionViewUrl } : {}),
        categories: (item.genres ?? (item.primaryGenreName ? [item.primaryGenreName] : [])).filter(Boolean),
        ...(item.artworkUrl600 ? { artworkUrl: item.artworkUrl600 } : {}),
        description: '',
        totalEpisodesInFeed: item.trackCount ?? 0,
        rssFetched: false,
        recentEpisodes: [],
      };

      try {
        const rssRes = await safeFetch(item.feedUrl, {
          timeoutMs,
          maxBytes: 5 * 1024 * 1024,
          deps: input.deps,
        });
        if (!rssRes.ok) {
          return { ...fallback, rssError: `HTTP ${rssRes.status}` };
        }
        return parsePodcastRssXml(rssRes.text, rssRes.finalUrl, maxEpisodes, fallback);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...fallback, rssError: msg };
      }
    }),
  );

  return {
    query,
    mode: 'itunes-search',
    showsReturned: shows.length,
    shows,
  };
}
