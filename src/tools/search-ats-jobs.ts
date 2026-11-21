import { safeFetch, safeFetchJson, type SafeFetchDeps } from '../lib/safe-fetch.js';
import { extractAllXmlBlocks, extractXmlTag, htmlToPlainText } from '../lib/xml.js';

/** Supported public ATS board providers. */
export const ATS_PROVIDERS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'personio',
  'recruitee',
] as const;

export type AtsProvider = (typeof ATS_PROVIDERS)[number];
export type LeverRegion = 'us' | 'eu' | 'auto';

/** Normalized ATS job listing. */
export interface AtsJobPosting {
  id: string;
  provider: AtsProvider;
  company: string;
  title: string;
  department?: string;
  location: string;
  remote: boolean;
  employmentType?: string;
  publishedAt?: string;
  salary?: string;
  url: string;
  snippet: string;
}

/** Input options for `searchAtsJobs`. */
export interface SearchAtsJobsInput {
  provider: AtsProvider;
  company: string;
  keywords?: string;
  location?: string;
  remoteOnly?: boolean;
  leverRegion?: LeverRegion;
  maxJobs?: number;
  timeoutMs?: number;
  deps?: SafeFetchDeps;
}

/** Structured result returned by `searchAtsJobs`. */
export interface SearchAtsJobsResult {
  provider: AtsProvider;
  company: string;
  endpointUrl: string;
  totalFetched: number;
  matchedCount: number;
  jobs: AtsJobPosting[];
}

const SLUG_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;

function validateSlug(company: string): string {
  const slug = company.trim();
  if (!SLUG_REGEX.test(slug)) {
    throw new Error(
      `Invalid company slug "${company}". Expected alphanumeric characters, hyphens, or underscores.`,
    );
  }
  return slug;
}

function inferRemote(location: string, explicitRemote?: boolean, workplaceType?: string): boolean {
  if (explicitRemote === true) return true;
  if (workplaceType && /remote/i.test(workplaceType)) return true;
  return /\b(?:remote|anywhere|distributed|work from home|wfh)\b/i.test(location);
}

interface GreenhouseResponse {
  jobs?: Array<{
    id?: number | string;
    title?: string;
    updated_at?: string;
    absolute_url?: string;
    content?: string;
    location?: { name?: string };
    departments?: Array<{ name?: string }>;
  }>;
}

async function fetchGreenhouse(
  slug: string,
  timeoutMs: number,
  deps?: SafeFetchDeps,
): Promise<{ endpointUrl: string; jobs: AtsJobPosting[] }> {
  const endpointUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const data = await safeFetchJson<GreenhouseResponse>(endpointUrl, {
    timeoutMs,
    maxBytes: 5 * 1024 * 1024,
    deps,
  });

  const jobs: AtsJobPosting[] = (data.jobs ?? []).map((item) => {
    const location = item.location?.name?.trim() || 'Unspecified';
    const department = item.departments?.map((d) => d.name).filter(Boolean).join(', ');
    return {
      id: String(item.id ?? ''),
      provider: 'greenhouse',
      company: slug,
      title: item.title?.trim() || 'Untitled Role',
      ...(department ? { department } : {}),
      location,
      remote: inferRemote(location),
      ...(item.updated_at ? { publishedAt: item.updated_at } : {}),
      url: item.absolute_url ?? `https://boards.greenhouse.io/${slug}`,
      snippet: htmlToPlainText(item.content ?? '', 360),
    };
  });

  return { endpointUrl, jobs };
}

interface LeverJobRaw {
  id?: string;
  text?: string;
  hostedUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  descriptionPlain?: string;
  description?: string;
  categories?: {
    location?: string;
    department?: string;
    team?: string;
    commitment?: string;
  };
  salaryRange?: {
    min?: number;
    max?: number;
    currency?: string;
    interval?: string;
  };
}

async function fetchLever(
  slug: string,
  region: LeverRegion,
  timeoutMs: number,
  deps?: SafeFetchDeps,
): Promise<{ endpointUrl: string; jobs: AtsJobPosting[] }> {
  const usUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const euUrl = `https://api.eu.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;

  let endpointUrl = region === 'eu' ? euUrl : usUrl;
  let list: LeverJobRaw[];

  if (region === 'auto') {
    const usRes = await safeFetch(usUrl, { timeoutMs, maxBytes: 4 * 1024 * 1024, deps });
    if (usRes.ok) {
      endpointUrl = usUrl;
      list = JSON.parse(usRes.text) as LeverJobRaw[];
    } else {
      endpointUrl = euUrl;
      list = await safeFetchJson<LeverJobRaw[]>(euUrl, { timeoutMs, maxBytes: 4 * 1024 * 1024, deps });
    }
  } else {
    list = await safeFetchJson<LeverJobRaw[]>(endpointUrl, { timeoutMs, maxBytes: 4 * 1024 * 1024, deps });
  }

  const jobs: AtsJobPosting[] = (Array.isArray(list) ? list : []).map((item) => {
    const location = item.categories?.location?.trim() || 'Unspecified';
    const department = item.categories?.department || item.categories?.team;
    const sr = item.salaryRange;
    const salary =
      sr?.min !== undefined && sr?.max !== undefined
        ? `${sr.currency ?? ''}${sr.min}-${sr.max}${sr.interval ? `/${sr.interval}` : ''}`.trim()
        : undefined;

    return {
      id: String(item.id ?? ''),
      provider: 'lever',
      company: slug,
      title: item.text?.trim() || 'Untitled Role',
      ...(department ? { department } : {}),
      location,
      remote: inferRemote(location, undefined, item.workplaceType),
      ...(item.categories?.commitment ? { employmentType: item.categories.commitment } : {}),
      ...(item.createdAt ? { publishedAt: new Date(item.createdAt).toISOString() } : {}),
      ...(salary ? { salary } : {}),
      url: item.hostedUrl ?? `https://jobs.lever.co/${slug}`,
      snippet: htmlToPlainText(item.descriptionPlain || item.description || '', 360),
    };
  });

  return { endpointUrl, jobs };
}

interface AshbyResponse {
  jobs?: Array<{
    id?: string;
    title?: string;
    department?: string;
    team?: string;
    employmentType?: string;
    location?: string;
    isRemote?: boolean;
    publishedAt?: string;
    jobUrl?: string;
    descriptionPlain?: string;
    descriptionHtml?: string;
    compensation?: {
      compensationTierSummary?: string;
    };
  }>;
}

async function fetchAshby(
  slug: string,
  timeoutMs: number,
  deps?: SafeFetchDeps,
): Promise<{ endpointUrl: string; jobs: AtsJobPosting[] }> {
  const endpointUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
  const data = await safeFetchJson<AshbyResponse>(endpointUrl, {
    timeoutMs,
    maxBytes: 5 * 1024 * 1024,
    deps,
  });

  const jobs: AtsJobPosting[] = (data.jobs ?? []).map((item) => {
    const location = item.location?.trim() || 'Unspecified';
    const department = item.department || item.team;
    const salary = item.compensation?.compensationTierSummary;
    return {
      id: String(item.id ?? ''),
      provider: 'ashby',
      company: slug,
      title: item.title?.trim() || 'Untitled Role',
      ...(department ? { department } : {}),
      location,
      remote: inferRemote(location, item.isRemote),
      ...(item.employmentType ? { employmentType: item.employmentType } : {}),
      ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
      ...(salary ? { salary } : {}),
      url: item.jobUrl ?? `https://jobs.ashbyhq.com/${slug}`,
      snippet: htmlToPlainText(item.descriptionPlain || item.descriptionHtml || '', 360),
    };
  });

  return { endpointUrl, jobs };
}

interface WorkableV3Response {
  results?: Array<{
    id?: number | string;
    shortcode?: string;
    title?: string;
    remote?: boolean;
    department?: string[];
    worktype?: string;
    published?: string;
    location?: {
      city?: string;
      region?: string;
      country?: string;
    };
  }>;
}

interface WorkableV1Response {
  jobs?: Array<{
    shortcode?: string;
    title?: string;
    url?: string;
    telecommuting?: boolean;
    department?: string;
    city?: string;
    country?: string;
    published_on?: string;
    description?: string;
  }>;
}

async function fetchWorkable(
  slug: string,
  timeoutMs: number,
  deps?: SafeFetchDeps,
): Promise<{ endpointUrl: string; jobs: AtsJobPosting[] }> {
  const v3Url = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`;
  const v3Res = await safeFetch(v3Url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ query: '', location: [], department: [], worktype: [], remote: [] }),
    timeoutMs,
    maxBytes: 4 * 1024 * 1024,
    deps,
  });

  if (v3Res.ok) {
    const data = JSON.parse(v3Res.text) as WorkableV3Response;
    const jobs: AtsJobPosting[] = (data.results ?? []).map((item) => {
      const locParts = [item.location?.city, item.location?.region, item.location?.country].filter(Boolean);
      const location = locParts.join(', ') || (item.remote ? 'Remote' : 'Unspecified');
      const code = item.shortcode ?? String(item.id ?? '');
      const dept = Array.isArray(item.department) ? item.department.join(', ') : undefined;
      return {
        id: code,
        provider: 'workable',
        company: slug,
        title: item.title?.trim() || 'Untitled Role',
        ...(dept ? { department: dept } : {}),
        location,
        remote: inferRemote(location, item.remote),
        ...(item.worktype ? { employmentType: item.worktype } : {}),
        ...(item.published ? { publishedAt: item.published } : {}),
        url: `https://apply.workable.com/${slug}/j/${code}/`,
        snippet: `${item.title ?? ''} (${location})`.trim(),
      };
    });
    return { endpointUrl: v3Url, jobs };
  }

  const v1Url = `https://www.workable.com/api/accounts/${encodeURIComponent(slug)}?details=true`;
  const v1Data = await safeFetchJson<WorkableV1Response>(v1Url, {
    timeoutMs,
    maxBytes: 4 * 1024 * 1024,
    deps,
  });
  const jobs: AtsJobPosting[] = (v1Data.jobs ?? []).map((item) => {
    const locParts = [item.city, item.country].filter(Boolean);
    const location = locParts.join(', ') || (item.telecommuting ? 'Remote' : 'Unspecified');
    const code = item.shortcode ?? '';
    return {
      id: code,
      provider: 'workable',
      company: slug,
      title: item.title?.trim() || 'Untitled Role',
      ...(item.department ? { department: item.department } : {}),
      location,
      remote: inferRemote(location, item.telecommuting),
      ...(item.published_on ? { publishedAt: item.published_on } : {}),
      url: item.url ?? `https://apply.workable.com/${slug}/j/${code}/`,
      snippet: htmlToPlainText(item.description ?? '', 360),
    };
  });
  return { endpointUrl: v1Url, jobs };
}

async function fetchPersonio(
  slug: string,
  timeoutMs: number,
  deps?: SafeFetchDeps,
): Promise<{ endpointUrl: string; jobs: AtsJobPosting[] }> {
  const deUrl = `https://${slug}.jobs.personio.de/xml?language=en`;
  const comUrl = `https://${slug}.jobs.personio.com/xml?language=en`;

  let endpointUrl = deUrl;
  let res = await safeFetch(deUrl, { timeoutMs, maxBytes: 5 * 1024 * 1024, deps });
  if (!res.ok) {
    const fallback = await safeFetch(comUrl, { timeoutMs, maxBytes: 5 * 1024 * 1024, deps });
    if (fallback.ok) {
      endpointUrl = comUrl;
      res = fallback;
    } else {
      throw new Error(`HTTP ${res.status} fetching Personio XML feed for "${slug}"`);
    }
  }

  const hostOrigin = new URL(endpointUrl).origin;
  const positions = extractAllXmlBlocks(res.text, 'position');
  const jobs: AtsJobPosting[] = positions.map((block) => {
    const id = extractXmlTag(block, 'id') ?? '';
    const title = extractXmlTag(block, 'name') ?? 'Untitled Role';
    const office = extractXmlTag(block, 'office') ?? 'Unspecified';
    const department = extractXmlTag(block, 'department') || extractXmlTag(block, 'recruitingCategory');
    const employmentType = extractXmlTag(block, 'schedule') || extractXmlTag(block, 'employmentType');
    const createdAt = extractXmlTag(block, 'createdAt');
    const descBlocks = extractAllXmlBlocks(block, 'jobDescription');
    const combinedDesc = descBlocks
      .map((db) => extractXmlTag(db, 'value') ?? '')
      .filter(Boolean)
      .join(' ');

    return {
      id,
      provider: 'personio',
      company: slug,
      title,
      ...(department ? { department } : {}),
      location: office,
      remote: inferRemote(office),
      ...(employmentType ? { employmentType } : {}),
      ...(createdAt ? { publishedAt: createdAt } : {}),
      url: id ? `${hostOrigin}/job/${encodeURIComponent(id)}` : hostOrigin,
      snippet: htmlToPlainText(combinedDesc, 360),
    };
  });

  return { endpointUrl, jobs };
}

interface RecruiteeResponse {
  offers?: Array<{
    id?: number | string;
    slug?: string;
    title?: string;
    department?: string;
    location?: string;
    city?: string;
    country?: string;
    remote?: boolean;
    careers_url?: string;
    published_at?: string;
    created_at?: string;
    employment_type_code?: string;
    description?: string;
  }>;
}

async function fetchRecruitee(
  slug: string,
  timeoutMs: number,
  deps?: SafeFetchDeps,
): Promise<{ endpointUrl: string; jobs: AtsJobPosting[] }> {
  const endpointUrl = `https://${slug}.recruitee.com/api/offers/`;
  const data = await safeFetchJson<RecruiteeResponse>(endpointUrl, {
    timeoutMs,
    maxBytes: 5 * 1024 * 1024,
    deps,
  });

  const jobs: AtsJobPosting[] = (data.offers ?? []).map((offer) => {
    const locParts = [offer.city, offer.country].filter(Boolean);
    const location = offer.location?.trim() || locParts.join(', ') || 'Unspecified';
    return {
      id: String(offer.id ?? offer.slug ?? ''),
      provider: 'recruitee',
      company: slug,
      title: offer.title?.trim() || 'Untitled Role',
      ...(offer.department ? { department: offer.department } : {}),
      location,
      remote: inferRemote(location, offer.remote),
      ...(offer.employment_type_code ? { employmentType: offer.employment_type_code } : {}),
      ...((offer.published_at || offer.created_at)
        ? { publishedAt: offer.published_at ?? offer.created_at }
        : {}),
      url: offer.careers_url ?? `https://${slug}.recruitee.com/o/${offer.slug ?? ''}`,
      snippet: htmlToPlainText(offer.description ?? '', 360),
    };
  });

  return { endpointUrl, jobs };
}

function matchesKeywordFilter(job: AtsJobPosting, keywords?: string): boolean {
  if (!keywords?.trim()) return true;
  const terms = keywords
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${job.title} ${job.department ?? ''} ${job.location} ${job.snippet}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Queries public JSON/XML ATS job boards directly by company slug without browsers or proxies.
 */
export async function searchAtsJobs(input: SearchAtsJobsInput): Promise<SearchAtsJobsResult> {
  const slug = validateSlug(input.company);
  const timeoutMs = input.timeoutMs ?? 15_000;
  const maxJobs = input.maxJobs ?? 30;
  const leverRegion = input.leverRegion ?? 'us';

  let fetched: { endpointUrl: string; jobs: AtsJobPosting[] };
  switch (input.provider) {
    case 'greenhouse':
      fetched = await fetchGreenhouse(slug, timeoutMs, input.deps);
      break;
    case 'lever':
      fetched = await fetchLever(slug, leverRegion, timeoutMs, input.deps);
      break;
    case 'ashby':
      fetched = await fetchAshby(slug, timeoutMs, input.deps);
      break;
    case 'workable':
      fetched = await fetchWorkable(slug, timeoutMs, input.deps);
      break;
    case 'personio':
      fetched = await fetchPersonio(slug, timeoutMs, input.deps);
      break;
    case 'recruitee':
      fetched = await fetchRecruitee(slug, timeoutMs, input.deps);
      break;
  }

  const locFilter = input.location?.trim().toLowerCase();
  const filtered = fetched.jobs.filter((job) => {
    if (input.remoteOnly && !job.remote) return false;
    if (locFilter && !job.location.toLowerCase().includes(locFilter)) return false;
    return matchesKeywordFilter(job, input.keywords);
  });

  return {
    provider: input.provider,
    company: slug,
    endpointUrl: fetched.endpointUrl,
    totalFetched: fetched.jobs.length,
    matchedCount: filtered.length,
    jobs: filtered.slice(0, maxJobs),
  };
}
