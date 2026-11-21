import { resolveMx as nodeResolveMx, resolveTxt as nodeResolveTxt } from 'node:dns/promises';
import type { MxRecord } from 'node:dns';
import { assertPublicUrl, safeFetch, type SafeFetchDeps } from '../lib/safe-fetch.js';
import {
  decodeEntities,
  extractFirstTagInner,
  MAX_HTML_INPUT_CHARS,
  stripMarkupTagsLinear,
} from '../lib/xml.js';

/** Injectable DNS record resolvers for offline testing. */
export interface DnsIntelDeps {
  resolveMx?: (hostname: string) => Promise<MxRecord[]>;
  resolveTxt?: (hostname: string) => Promise<string[][]>;
}

/** Input options for `enrichDomainIntel`. */
export interface EnrichDomainIntelInput {
  domainOrUrl: string;
  checkContactPage?: boolean;
  timeoutMs?: number;
  deps?: SafeFetchDeps;
  dnsDeps?: DnsIntelDeps;
}

/** Social links keyed by platform name. */
export type SocialLinksMap = Partial<
  Record<
    | 'github'
    | 'linkedin'
    | 'x'
    | 'youtube'
    | 'instagram'
    | 'facebook'
    | 'discord'
    | 'tiktok'
    | 'threads'
    | 'bluesky',
    string[]
  >
>;

/** Structured domain intelligence output. */
export interface EnrichDomainIntelResult {
  domain: string;
  normalizedUrl: string;
  title?: string;
  description?: string;
  emails: string[];
  socialLinks: SocialLinksMap;
  llmsTxt: {
    found: boolean;
    url: string;
    preview?: string;
  };
  dns: {
    mxRecords: Array<{ exchange: string; priority: number }>;
    mailProvider?: string;
    spfRecord?: string;
    dmarcRecord?: string;
    dmarcPolicy?: string;
    txtVerifications: string[];
  };
  techStack: string[];
}

function normalizeTargetInput(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

function toApexCandidates(hostname: string): string[] {
  const clean = hostname.toLowerCase().replace(/^www\./, '');
  const parts = clean.split('.');
  if (parts.length > 2) {
    const lastTwo = parts.slice(-2).join('.');
    return [clean, lastTwo];
  }
  return [clean];
}

const NOISE_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'domain.com',
  'yourdomain.com',
  'email.com',
  'sentry.io',
  'sentry-next.wixpress.com',
  'wixpress.com',
]);

const ASSET_EXTENSION_REGEX = /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|mjs|woff2?|ttf|eot|map)$/i;

function extractEmailsFromHtml(html: string): string[] {
  const found = new Map<string, string>();

  // 1. Explicit mailto: hrefs
  const mailtoRegex = /href\s*=\s*["']mailto:([^"'?#\s>]+)/gi;
  let mm: RegExpExecArray | null;
  while ((mm = mailtoRegex.exec(html)) !== null) {
    try {
      const candidate = decodeURIComponent(decodeEntities(mm[1] ?? '')).trim();
      addValidEmail(candidate, found);
    } catch {
      // Ignore malformed URI encoding
    }
  }

  // 2. Visible text emails
  const plain = decodeEntities(stripMarkupTagsLinear(html, ' '));
  const emailRegex = /\b[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,190}\.[a-zA-Z]{2,24}\b/g;
  let em: RegExpExecArray | null;
  while ((em = emailRegex.exec(plain)) !== null) {
    addValidEmail(em[0], found);
  }

  return [...found.values()].slice(0, 25);
}

const EMAIL_EDGE_PUNCTUATION = new Set(['.', ',', ';', ':', '(', ')', '<', '>', '[', ']', '"', "'"]);

function trimEdgeSet(input: string, charSet: ReadonlySet<string>): string {
  let start = 0;
  let end = input.length;
  while (start < end && charSet.has(input[start]!)) start += 1;
  while (end > start && charSet.has(input[end - 1]!)) end -= 1;
  return start === 0 && end === input.length ? input : input.slice(start, end);
}

function trimTrailingSlashes(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47) end -= 1;
  return end === input.length ? input : input.slice(0, end);
}

function addValidEmail(raw: string, map: Map<string, string>): void {
  const cleaned = trimEdgeSet(raw, EMAIL_EDGE_PUNCTUATION).trim();
  const lower = cleaned.toLowerCase();
  if (!lower.includes('@')) return;
  if (ASSET_EXTENSION_REGEX.test(lower)) return;
  const [local, domain] = lower.split('@');
  if (!local || !domain || !domain.includes('.')) return;
  if (NOISE_EMAIL_DOMAINS.has(domain)) return;
  if (/^(?:noreply|no-reply|donotreply|example|user|name|yourname|email)$/.test(local)) return;
  if (!map.has(lower)) {
    map.set(lower, lower);
  }
}

const SOCIAL_PATTERNS: Array<[keyof SocialLinksMap, RegExp]> = [
  ['github', /^https?:\/\/(?:www\.)?github\.com\/(?!features|pricing|login|signup|about|orgs\/?$)[a-zA-Z0-9_.-]+\/?$/i],
  ['linkedin', /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in|school)\/[a-zA-Z0-9_%-]+\/?$/i],
  ['x', /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?!intent|share|home|search|explore|i\/)[a-zA-Z0-9_]{1,30}\/?$/i],
  ['youtube', /^https?:\/\/(?:www\.)?youtube\.com\/(?:@[a-zA-Z0-9_.-]+|channel\/[a-zA-Z0-9_-]+|c\/[a-zA-Z0-9_.-]+)\/?$/i],
  ['instagram', /^https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|explore\/)[a-zA-Z0-9_.]+\/?$/i],
  ['facebook', /^https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|share\.php|dialog)[a-zA-Z0-9_.-]+\/?$/i],
  ['discord', /^https?:\/\/(?:www\.)?(?:discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9-]+\/?$/i],
  ['tiktok', /^https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9_.]+\/?$/i],
  ['threads', /^https?:\/\/(?:www\.)?threads\.net\/@[a-zA-Z0-9_.]+\/?$/i],
  ['bluesky', /^https?:\/\/(?:www\.)?bsky\.app\/profile\/[a-zA-Z0-9_.-]+\/?$/i],
];

function extractSocialLinks(html: string, baseUrl: string): SocialLinksMap {
  const result: SocialLinksMap = {};
  const hrefRegex = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefRegex.exec(html)) !== null) {
    const rawHref = decodeEntities(match[1] ?? match[2] ?? '').trim();
    if (!rawHref) continue;
    let resolved: URL;
    try {
      resolved = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }
    resolved.hash = '';
    resolved.search = '';
    const clean = trimTrailingSlashes(resolved.toString());

    for (const [platform, regex] of SOCIAL_PATTERNS) {
      if (regex.test(clean)) {
        const list = result[platform] ?? [];
        if (!list.some((u) => u.toLowerCase() === clean.toLowerCase()) && list.length < 5) {
          list.push(clean);
          result[platform] = list;
        }
      }
    }
  }

  return result;
}

function findInternalContactUrl(html: string, origin: string): string | undefined {
  const hrefRegex = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const rawHref = decodeEntities(match[1] ?? match[2] ?? '').trim();
    if (!rawHref) continue;
    try {
      const resolved = new URL(rawHref, origin);
      if (resolved.origin !== origin) continue;
      if (/^\/(?:contact|contact-us|about|about-us|impressum|support)\/?$/i.test(resolved.pathname)) {
        return resolved.toString();
      }
    } catch {
      // Ignore invalid href
    }
  }
  return undefined;
}

const TECH_HTML_PATTERNS: Array<[string, RegExp]> = [
  ['nextjs', /\/_next\/static\/|__NEXT_DATA__/i],
  ['nuxt', /\/_nuxt\/|__NUXT__/i],
  ['astro', /astro-island|\/_astro\//i],
  ['sveltekit', /__sveltekit/i],
  ['remix', /__remixContext/i],
  ['gatsby', /___gatsby/i],
  ['wordpress', /\/wp-content\/|\/wp-includes\//i],
  ['webflow', /data-wf-site|website-files\.com/i],
  ['framer', /framerusercontent\.com/i],
  ['ghost', /ghost-sdk|content\/themes\//i],
  ['shopify', /cdn\.shopify\.com|Shopify\.shop/i],
  ['woocommerce', /woocommerce/i],
  ['tailwind-css', /tailwindcss/i],
  ['cloudflare-insights', /static\.cloudflareinsights\.com/i],
  ['plausible', /plausible\.io\/js\//i],
  ['posthog', /posthog\.com|app\.posthog\.com/i],
  ['segment', /cdn\.segment\.com/i],
  ['google-analytics', /google-analytics\.com|gtag\(['"]config['"]/i],
  ['google-tag-manager', /googletagmanager\.com\/gtm\.js/i],
  ['hubspot', /js\.hs-scripts\.com|hsforms\.net/i],
  ['intercom', /widget\.intercom\.io/i],
  ['crisp', /client\.crisp\.chat/i],
  ['sentry', /browser\.sentry-cdn\.com/i],
  ['stripe', /js\.stripe\.com/i],
];

function detectTechStack(html: string, headers: Record<string, string>): string[] {
  const detected = new Set<string>();

  const server = headers['server'] ?? '';
  const poweredBy = headers['x-powered-by'] ?? '';
  if (/cloudflare/i.test(server) || headers['cf-ray']) detected.add('cloudflare');
  if (/vercel/i.test(server) || headers['x-vercel-id']) detected.add('vercel');
  if (/netlify/i.test(server) || headers['x-nf-request-id']) detected.add('netlify');
  if (headers['x-amz-cf-id'] || /cloudfront/i.test(headers['via'] ?? '')) detected.add('aws-cloudfront');
  if (headers['fly-request-id'] || /fly\.io/i.test(server)) detected.add('fly-io');
  if (/nginx/i.test(server)) detected.add('nginx');
  if (/express/i.test(poweredBy)) detected.add('express');
  if (/next\.js/i.test(poweredBy)) detected.add('nextjs');
  if (/php/i.test(poweredBy)) detected.add('php');

  for (const [name, regex] of TECH_HTML_PATTERNS) {
    if (regex.test(html)) {
      detected.add(name);
    }
  }

  return [...detected];
}

function inferMailProvider(mxRecords: Array<{ exchange: string; priority: number }>): string | undefined {
  const joined = mxRecords.map((r) => r.exchange.toLowerCase()).join(' ');
  if (!joined) return undefined;
  if (/google\.com|googlemail\.com/.test(joined)) return 'google-workspace';
  if (/protection\.outlook\.com|mail\.eo\.outlook\.com/.test(joined)) return 'microsoft-365';
  if (/protonmail\.ch|proton\.me/.test(joined)) return 'proton-mail';
  if (/messagingengine\.com|fastmail\.com/.test(joined)) return 'fastmail';
  if (/zoho\.com|zoho\.eu/.test(joined)) return 'zoho-mail';
  if (/route\d*\.mx\.cloudflare\.net/.test(joined)) return 'cloudflare-email-routing';
  if (/amazonaws\.com/.test(joined)) return 'amazon-ses';
  if (/mimecast\.com/.test(joined)) return 'mimecast';
  if (/pphosted\.com/.test(joined)) return 'proofpoint';
  if (/yahoodns\.net/.test(joined)) return 'yahoo-business';
  return 'custom-mx';
}

async function queryDomainDns(
  hostname: string,
  dnsDeps?: DnsIntelDeps,
): Promise<EnrichDomainIntelResult['dns']> {
  const resolveMxFn = dnsDeps?.resolveMx ?? nodeResolveMx;
  const resolveTxtFn = dnsDeps?.resolveTxt ?? nodeResolveTxt;
  const candidates = toApexCandidates(hostname);

  let mxRecords: Array<{ exchange: string; priority: number }> = [];
  for (const host of candidates) {
    try {
      const mx = await resolveMxFn(host);
      if (mx.length > 0) {
        mxRecords = mx
          .map((r) => ({ exchange: r.exchange.replace(/\.$/, ''), priority: r.priority }))
          .sort((a, b) => a.priority - b.priority);
        break;
      }
    } catch {
      // Try next candidate
    }
  }

  let spfRecord: string | undefined;
  const txtVerifications = new Set<string>();
  for (const host of candidates) {
    try {
      const chunksList = await resolveTxtFn(host);
      for (const chunks of chunksList) {
        const record = chunks.join('').trim();
        if (/^v=spf1\b/i.test(record) && !spfRecord) {
          spfRecord = record;
        } else if (/^[a-z0-9_-]+-(?:site-)?verification=/i.test(record)) {
          const prefix = record.split('=')[0];
          if (prefix) txtVerifications.add(prefix.toLowerCase());
        }
      }
      if (spfRecord) break;
    } catch {
      // Ignore NXDOMAIN/NODATA
    }
  }

  let dmarcRecord: string | undefined;
  let dmarcPolicy: string | undefined;
  for (const host of candidates) {
    try {
      const dmarcChunks = await resolveTxtFn(`_dmarc.${host}`);
      for (const chunks of dmarcChunks) {
        const record = chunks.join('').trim();
        if (/^v=DMARC1\b/i.test(record)) {
          dmarcRecord = record;
          const pMatch = /\bp\s*=\s*([a-zA-Z]+)/i.exec(record);
          if (pMatch?.[1]) {
            dmarcPolicy = pMatch[1].toLowerCase();
          }
          break;
        }
      }
      if (dmarcRecord) break;
    } catch {
      // Ignore NXDOMAIN/NODATA
    }
  }

  const mailProvider = inferMailProvider(mxRecords);

  return {
    mxRecords,
    ...(mailProvider ? { mailProvider } : {}),
    ...(spfRecord ? { spfRecord } : {}),
    ...(dmarcRecord ? { dmarcRecord } : {}),
    ...(dmarcPolicy ? { dmarcPolicy } : {}),
    txtVerifications: [...txtVerifications],
  };
}

/**
 * Enriches a public domain or URL with contact emails, social links, `llms.txt` discovery,
 * DNS `MX`/`SPF`/`DMARC` posture, and technology stack fingerprints.
 */
export async function enrichDomainIntel(
  input: EnrichDomainIntelInput,
): Promise<EnrichDomainIntelResult> {
  const timeoutMs = input.timeoutMs ?? 12_000;
  const checkContactPage = input.checkContactPage ?? true;

  const targetUrlStr = normalizeTargetInput(input.domainOrUrl);
  const validatedUrl = await assertPublicUrl(targetUrlStr, input.deps);
  const origin = validatedUrl.origin;
  const domain = validatedUrl.hostname.toLowerCase();
  const llmsUrl = `${origin}/llms.txt`;

  const [homeSettled, llmsSettled, dnsInfo] = await Promise.allSettled([
    safeFetch(validatedUrl.toString(), { timeoutMs, maxBytes: 2 * 1024 * 1024, deps: input.deps }),
    safeFetch(llmsUrl, { timeoutMs: Math.min(timeoutMs, 8_000), maxBytes: 256 * 1024, deps: input.deps }),
    queryDomainDns(domain, input.dnsDeps),
  ]);

  const homeRes = homeSettled.status === 'fulfilled' && homeSettled.value.ok ? homeSettled.value : undefined;
  const rawHomeHtml = homeRes?.text ?? '';
  const homeHtml =
    rawHomeHtml.length > MAX_HTML_INPUT_CHARS
      ? rawHomeHtml.slice(0, MAX_HTML_INPUT_CHARS)
      : rawHomeHtml;
  const homeHeaders = homeRes?.headers ?? {};

  const titleInner = extractFirstTagInner(homeHtml, 'title');
  const title = titleInner
    ? decodeEntities(stripMarkupTagsLinear(titleInner, ' ')).replace(/\s+/g, ' ').trim()
    : undefined;
  const descMatch = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']*)["']/i.exec(
    homeHtml,
  );
  const description = descMatch?.[1] ? decodeEntities(descMatch[1]).trim() : undefined;

  const emailSet = new Set<string>(extractEmailsFromHtml(homeHtml));
  const socialLinks = extractSocialLinks(homeHtml, validatedUrl.toString());

  // Optionally follow one discovered /contact or /about page if homepage lacks emails
  if (checkContactPage && emailSet.size === 0 && homeHtml) {
    const contactUrl = findInternalContactUrl(homeHtml, origin);
    if (contactUrl) {
      try {
        const contactRes = await safeFetch(contactUrl, {
          timeoutMs: Math.min(timeoutMs, 8_000),
          maxBytes: 1024 * 1024,
          deps: input.deps,
        });
        if (contactRes.ok) {
          for (const em of extractEmailsFromHtml(contactRes.text)) {
            emailSet.add(em);
          }
        }
      } catch {
        // Ignore secondary contact page failure
      }
    }
  }

  let llmsTxt: EnrichDomainIntelResult['llmsTxt'] = { found: false, url: llmsUrl };
  if (
    llmsSettled.status === 'fulfilled' &&
    llmsSettled.value.ok &&
    !llmsSettled.value.contentType.includes('html') &&
    !/^\s*<!doctype\s+html/i.test(llmsSettled.value.text)
  ) {
    const preview = llmsSettled.value.text.trim().slice(0, 1_000);
    if (preview) {
      llmsTxt = { found: true, url: llmsSettled.value.finalUrl, preview };
    }
  }

  const resolvedDns: EnrichDomainIntelResult['dns'] =
    dnsInfo.status === 'fulfilled'
      ? dnsInfo.value
      : { mxRecords: [], txtVerifications: [] };

  return {
    domain,
    normalizedUrl: homeRes?.finalUrl ?? validatedUrl.toString(),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    emails: [...emailSet],
    socialLinks,
    llmsTxt,
    dns: resolvedDns,
    techStack: detectTechStack(homeHtml, homeHeaders),
  };
}
