import { safeFetch, safeFetchJson, type SafeFetchDeps } from '../lib/safe-fetch.js';
import { extractAllXmlBlocks, extractXmlTag, htmlToPlainText } from '../lib/xml.js';

/** Supported public remote job feeds. */
export const REMOTE_JOB_SOURCES = [
  'remotive',
  'jobicy',
  'himalayas',
  'remoteok',
  'weworkremotely',
] as const;

export type RemoteJobSource = (typeof REMOTE_JOB_SOURCES)[number];

/** Normalized remote job posting aggregated across feeds. */
export interface RemoteJobListing {
  id: string;
  source: RemoteJobSource;
  title: string;
  company: string;
  location: string;
  tags: string[];
  salary?: string;
  publishedAt?: string;
  url: string;
  snippet: string;
}

/** Per-feed status report so partial failures stay transparent. */
export interface RemoteFeedStatus {
  source: RemoteJobSource;
  ok: boolean;
  fetchedCount: number;
  error?: string;
}

/** Input options for `searchRemoteJobs`. */
export interface SearchRemoteJobsInput {
  keywords?: string;
  sources?: RemoteJobSource[];
  maxJobs?: number;
  timeoutMs?: number;
  deps?: SafeFetchDeps;
}

/** Aggregated output returned by `searchRemoteJobs`. */
export interface SearchRemoteJobsResult {
  keywords?: string;
  sourcesQueried: RemoteJobSource[];
  feedStatuses: RemoteFeedStatus[];
  totalBeforeDedup: number;
  matchedCount: number;
  jobs: RemoteJobListing[];
}

async function fetchRemotive(timeoutMs: number, deps?: SafeFetchDeps): Promise<RemoteJobListing[]> {
  interface RemotivePayload {
    jobs?: Array<{
      id?: number | string;
      url?: string;
      title?: string;
      company_name?: string;
      category?: string;
      tags?: string[];
      candidate_required_location?: string;
      publication_date?: string;
      salary?: string;
      description?: string;
    }>;
  }

  const data = await safeFetchJson<RemotivePayload>(
    'https://remotive.com/api/remote-jobs?limit=60',
    { timeoutMs, maxBytes: 4 * 1024 * 1024, deps },
  );

  return (data.jobs ?? []).map((j) => ({
    id: `remotive-${j.id ?? ''}`,
    source: 'remotive',
    title: j.title?.trim() || 'Untitled Role',
    company: j.company_name?.trim() || 'Unknown Company',
    location: j.candidate_required_location?.trim() || 'Remote',
    tags: [j.category, ...(j.tags ?? [])].filter((t): t is string => Boolean(t)),
    ...(j.salary?.trim() ? { salary: j.salary.trim() } : {}),
    ...(j.publication_date ? { publishedAt: j.publication_date } : {}),
    url: j.url ?? 'https://remotive.com',
    snippet: htmlToPlainText(j.description ?? '', 300),
  }));
}

async function fetchJobicy(timeoutMs: number, deps?: SafeFetchDeps): Promise<RemoteJobListing[]> {
  interface JobicyPayload {
    jobs?: Array<{
      id?: number | string;
      url?: string;
      jobTitle?: string;
      companyName?: string;
      jobGeo?: string;
      jobIndustry?: string[];
      jobType?: string[];
      pubDate?: string;
      annualSalaryMin?: number | string;
      annualSalaryMax?: number | string;
      salaryCurrency?: string;
      jobExcerpt?: string;
      jobDescription?: string;
    }>;
  }

  const data = await safeFetchJson<JobicyPayload>(
    'https://jobicy.com/api/v2/remote-jobs?count=50',
    { timeoutMs, maxBytes: 4 * 1024 * 1024, deps },
  );

  return (data.jobs ?? []).map((j) => {
    const salary =
      j.annualSalaryMin && j.annualSalaryMax
        ? `${j.salaryCurrency ?? 'USD'} ${j.annualSalaryMin}-${j.annualSalaryMax}`
        : undefined;
    return {
      id: `jobicy-${j.id ?? ''}`,
      source: 'jobicy',
      title: htmlToPlainText(j.jobTitle ?? '', 180) || 'Untitled Role',
      company: htmlToPlainText(j.companyName ?? '', 120) || 'Unknown Company',
      location: j.jobGeo?.trim() || 'Remote',
      tags: [...(j.jobIndustry ?? []), ...(j.jobType ?? [])].map((t) => htmlToPlainText(t, 60)),
      ...(salary ? { salary } : {}),
      ...(j.pubDate ? { publishedAt: j.pubDate } : {}),
      url: j.url ?? 'https://jobicy.com',
      snippet: htmlToPlainText(j.jobExcerpt || j.jobDescription || '', 300),
    };
  });
}

async function fetchHimalayas(timeoutMs: number, deps?: SafeFetchDeps): Promise<RemoteJobListing[]> {
  interface HimalayasPayload {
    jobs?: Array<{
      guid?: string;
      title?: string;
      companyName?: string;
      locationRestrictions?: string[];
      categories?: string[];
      employmentType?: string;
      minSalary?: number;
      maxSalary?: number;
      currency?: string;
      pubDate?: number | string;
      applicationLink?: string;
      excerpt?: string;
      description?: string;
    }>;
  }

  const data = await safeFetchJson<HimalayasPayload>(
    'https://himalayas.app/jobs/api?limit=50',
    { timeoutMs, maxBytes: 4 * 1024 * 1024, deps },
  );

  return (data.jobs ?? []).map((j, idx) => {
    const salary =
      j.minSalary !== undefined && j.maxSalary !== undefined
        ? `${j.currency ?? 'USD'} ${j.minSalary}-${j.maxSalary}`
        : undefined;
    const publishedAt =
      typeof j.pubDate === 'number'
        ? new Date(j.pubDate * 1000).toISOString()
        : j.pubDate;
    return {
      id: `himalayas-${j.guid ?? idx}`,
      source: 'himalayas',
      title: j.title?.trim() || 'Untitled Role',
      company: j.companyName?.trim() || 'Unknown Company',
      location: j.locationRestrictions?.join(', ') || 'Remote Worldwide',
      tags: [...(j.categories ?? []), ...(j.employmentType ? [j.employmentType] : [])],
      ...(salary ? { salary } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      url: j.applicationLink ?? j.guid ?? 'https://himalayas.app/jobs',
      snippet: htmlToPlainText(j.excerpt || j.description || '', 300),
    };
  });
}

async function fetchRemoteOk(timeoutMs: number, deps?: SafeFetchDeps): Promise<RemoteJobListing[]> {
  interface RemoteOkEntry {
    id?: string | number;
    position?: string;
    company?: string;
    location?: string;
    tags?: string[];
    salary_min?: number;
    salary_max?: number;
    date?: string;
    url?: string;
    apply_url?: string;
    description?: string;
  }

  const rows = await safeFetchJson<RemoteOkEntry[]>('https://remoteok.com/api', {
    timeoutMs,
    maxBytes: 5 * 1024 * 1024,
    deps,
  });

  if (!Array.isArray(rows)) return [];

  // Element 0 on RemoteOK is a legal attribution object without `position`
  return rows
    .filter((r) => Boolean(r && r.position))
    .slice(0, 60)
    .map((r) => {
      const salary =
        r.salary_min && r.salary_max ? `USD ${r.salary_min}-${r.salary_max}` : undefined;
      return {
        id: `remoteok-${r.id ?? ''}`,
        source: 'remoteok',
        title: r.position!.trim(),
        company: r.company?.trim() || 'Unknown Company',
        location: r.location?.trim() || 'Remote',
        tags: Array.isArray(r.tags) ? r.tags : [],
        ...(salary ? { salary } : {}),
        ...(r.date ? { publishedAt: r.date } : {}),
        url: r.url || r.apply_url || 'https://remoteok.com',
        snippet: htmlToPlainText(r.description ?? '', 300),
      };
    });
}

async function fetchWeWorkRemotely(timeoutMs: number, deps?: SafeFetchDeps): Promise<RemoteJobListing[]> {
  const res = await safeFetch('https://weworkremotely.com/remote-jobs.rss', {
    timeoutMs,
    maxBytes: 4 * 1024 * 1024,
    deps,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching WeWorkRemotely RSS`);
  }

  const items = extractAllXmlBlocks(res.text, 'item');
  return items.slice(0, 60).map((item, idx) => {
    const rawTitle = extractXmlTag(item, 'title') ?? 'Untitled Role';
    const colonIdx = rawTitle.indexOf(':');
    const company = colonIdx > 0 ? rawTitle.slice(0, colonIdx).trim() : 'Unknown Company';
    const title = colonIdx > 0 ? rawTitle.slice(colonIdx + 1).trim() : rawTitle.trim();
    const link = extractXmlTag(item, 'link') || extractXmlTag(item, 'guid') || 'https://weworkremotely.com';
    const region = extractXmlTag(item, 'region') || 'Remote';
    const category = extractXmlTag(item, 'category');
    const pubDate = extractXmlTag(item, 'pubDate');
    const description = extractXmlTag(item, 'description') ?? '';

    return {
      id: `wwr-${idx}-${link.slice(-24)}`,
      source: 'weworkremotely',
      title,
      company,
      location: region,
      tags: category ? [category] : [],
      ...(pubDate ? { publishedAt: pubDate } : {}),
      url: link,
      snippet: htmlToPlainText(description, 300),
    };
  });
}

function normalizeDedupKey(company: string, title: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${norm(company)}::${norm(title)}`;
}

function normalizeCanonicalUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) {
        u.searchParams.delete(key);
      }
    }
    const rawStr = u.toString();
    let end = rawStr.length;
    while (end > 0 && rawStr.charCodeAt(end - 1) === 47) {
      end -= 1;
    }
    return rawStr.slice(0, end).toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function matchesKeywords(job: RemoteJobListing, keywords?: string): boolean {
  if (!keywords?.trim()) return true;
  const terms = keywords
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${job.title} ${job.company} ${job.location} ${job.tags.join(' ')} ${job.snippet}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

function toTimestamp(isoOrDate?: string): number {
  if (!isoOrDate) return 0;
  const parsed = Date.parse(isoOrDate);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Aggregates, filters, and deduplicates remote tech listings across 5 public JSON/RSS feeds,
 * degrading gracefully if individual feeds fail or time out.
 */
export async function searchRemoteJobs(
  input: SearchRemoteJobsInput = {},
): Promise<SearchRemoteJobsResult> {
  const sources: RemoteJobSource[] =
    input.sources && input.sources.length > 0 ? [...new Set(input.sources)] : [...REMOTE_JOB_SOURCES];
  const maxJobs = input.maxJobs ?? 30;
  const timeoutMs = input.timeoutMs ?? 12_000;

  const fetchers: Record<RemoteJobSource, () => Promise<RemoteJobListing[]>> = {
    remotive: () => fetchRemotive(timeoutMs, input.deps),
    jobicy: () => fetchJobicy(timeoutMs, input.deps),
    himalayas: () => fetchHimalayas(timeoutMs, input.deps),
    remoteok: () => fetchRemoteOk(timeoutMs, input.deps),
    weworkremotely: () => fetchWeWorkRemotely(timeoutMs, input.deps),
  };

  const settled = await Promise.allSettled(sources.map((src) => fetchers[src]()));
  const feedStatuses: RemoteFeedStatus[] = [];
  const allJobs: RemoteJobListing[] = [];

  settled.forEach((outcome, index) => {
    const src = sources[index]!;
    if (outcome.status === 'fulfilled') {
      feedStatuses.push({ source: src, ok: true, fetchedCount: outcome.value.length });
      allJobs.push(...outcome.value);
    } else {
      const errText =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      feedStatuses.push({ source: src, ok: false, fetchedCount: 0, error: errText });
    }
  });

  const seenKeys = new Set<string>();
  const seenUrls = new Set<string>();
  const deduplicated: RemoteJobListing[] = [];

  for (const job of allJobs) {
    if (!matchesKeywords(job, input.keywords)) continue;
    const key = normalizeDedupKey(job.company, job.title);
    const canonUrl = normalizeCanonicalUrl(job.url);
    if (seenKeys.has(key) || seenUrls.has(canonUrl)) continue;
    seenKeys.add(key);
    seenUrls.add(canonUrl);
    deduplicated.push(job);
  }

  deduplicated.sort((a, b) => toTimestamp(b.publishedAt) - toTimestamp(a.publishedAt));

  return {
    ...(input.keywords ? { keywords: input.keywords } : {}),
    sourcesQueried: sources,
    feedStatuses,
    totalBeforeDedup: allJobs.length,
    matchedCount: deduplicated.length,
    jobs: deduplicated.slice(0, maxJobs),
  };
}
