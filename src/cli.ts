#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SERVER_VERSION } from './server.js';
import { crawlSitemap } from './tools/crawl-sitemap.js';
import { enrichDomainIntel } from './tools/enrich-domain-intel.js';
import { fetchMarkdown } from './tools/fetch-markdown.js';
import { inspectEcommerceStore } from './tools/inspect-ecommerce-store.js';
import { ATS_PROVIDERS, type AtsProvider, type LeverRegion, searchAtsJobs } from './tools/search-ats-jobs.js';
import { searchPodcastsRss } from './tools/search-podcasts-rss.js';
import { REMOTE_JOB_SOURCES, type RemoteJobSource, searchRemoteJobs } from './tools/search-remote-jobs.js';

const HELP_TEXT = `open-web-intel v${SERVER_VERSION}
Zero-proxy, zero-browser SSRF-safe web intelligence CLI.

Usage:
  open-web-intel <subcommand> [arguments] [options]

Subcommands:
  fetch <url>                   Fetch a public URL and convert HTML to clean Markdown
  sitemap <url>                 Discover robots.txt and crawl XML sitemaps
  ats <provider> <company>      Query Greenhouse, Lever, Ashby, Workable, Personio, or Recruitee jobs
  remote                        Aggregate & deduplicate remote jobs from 5 public feeds
  store <url>                   Inspect Shopify / WooCommerce storefront catalog & tech signals
  enrich <domain-or-url>        Extract emails, socials, llms.txt, DNS MX/SPF/DMARC, and tech stack
  podcasts <query-or-rss-url>   Search Apple Podcasts + parse RSS feeds for email & episodes

Common Options:
  --json                        Emit machine-readable JSON output
  --help, -h                    Display help for CLI or subcommand
  --version, -v                 Display CLI version

Subcommand Options:
  fetch:
    --llms-txt                  Also probe <origin>/llms.txt
    --max-chars <n>             Maximum Markdown characters (default: 30000)
  sitemap:
    --max-urls <n>              Maximum URLs collected (default: 200)
    --max-depth <n>             Maximum sitemap index depth (default: 2)
    --filter <substr>           Case-insensitive URL substring filter
  ats:
    --keywords <text>           Filter jobs by keywords
    --location <text>           Filter jobs by location substring
    --remote-only               Return only remote roles
    --region <us|eu|auto>       Lever region (default: us)
    --max-jobs <n>              Maximum jobs returned (default: 30)
  remote:
    --keywords <text>           Filter remote jobs by keywords
    --sources <csv>             Comma-separated feeds (remotive,jobicy,himalayas,remoteok,weworkremotely)
    --max-jobs <n>              Maximum jobs returned (default: 30)
  store:
    --max-products <n>          Maximum sample products returned (default: 15)
  enrich:
    --no-contact-page           Skip following same-origin /contact or /about fallback link
  podcasts:
    --max-shows <n>             Maximum podcast shows inspected (default: 5)
    --max-episodes <n>          Maximum recent episodes parsed per show (default: 3)
    --country <cc>              Two-letter ISO country code (default: US)
`;

function parseIntFlag(raw: string | undefined, flagName: string, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new Error(`Invalid ${flagName} "${raw}" (expected integer between ${min} and ${max})`);
  }
  return num;
}

/**
 * Executes the CLI against `argv` (e.g. `process.argv.slice(2)`), returning an exit code.
 */
export async function runCli(
  argv: string[],
  io: { stdout: (s: string) => void; stderr: (s: string) => void } = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  },
): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    io.stdout(HELP_TEXT);
    return 0;
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    io.stdout(`${SERVER_VERSION}\n`);
    return 0;
  }

  const subcommand = argv[0]!;
  const rest = argv.slice(1);

  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        json: { type: 'boolean', default: false },
        'llms-txt': { type: 'boolean', default: false },
        'max-chars': { type: 'string' },
        'max-urls': { type: 'string' },
        'max-depth': { type: 'string' },
        filter: { type: 'string' },
        keywords: { type: 'string' },
        location: { type: 'string' },
        'remote-only': { type: 'boolean', default: false },
        region: { type: 'string' },
        'max-jobs': { type: 'string' },
        sources: { type: 'string' },
        'max-products': { type: 'string' },
        'no-contact-page': { type: 'boolean', default: false },
        'max-shows': { type: 'string' },
        'max-episodes': { type: 'string' },
        country: { type: 'string' },
      },
    });

    if (parsed.values.help) {
      io.stdout(HELP_TEXT);
      return 0;
    }

    const wantJson = Boolean(parsed.values.json);
    const pos = parsed.positionals;

    switch (subcommand) {
      case 'fetch': {
        const url = pos[0];
        if (!url) throw new Error('Missing <url> for "fetch" subcommand');
        const res = await fetchMarkdown({
          url,
          includeLlmsTxt: Boolean(parsed.values['llms-txt']),
          maxChars: parseIntFlag(parsed.values['max-chars'], '--max-chars', 500, 200000),
        });
        if (wantJson) {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
        } else {
          io.stdout(`Title: ${res.title}\nURL: ${res.finalUrl}\nApprox Tokens: ${res.approxTokens}\n\n${res.markdown}\n`);
        }
        return 0;
      }

      case 'sitemap': {
        const url = pos[0];
        if (!url) throw new Error('Missing <url> for "sitemap" subcommand');
        const res = await crawlSitemap({
          url,
          maxUrls: parseIntFlag(parsed.values['max-urls'], '--max-urls', 1, 5000),
          maxDepth: parseIntFlag(parsed.values['max-depth'], '--max-depth', 0, 4),
          pathFilter: parsed.values.filter,
        });
        if (wantJson) {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
        } else {
          io.stdout(
            `Target: ${res.targetUrl}\nSitemaps Visited: ${res.sitemapsVisited.length}\nURLs Collected: ${res.totalCollected}\n\n` +
              res.entries.map((e) => `- ${e.loc}${e.lastmod ? ` (${e.lastmod})` : ''}`).join('\n') +
              '\n',
          );
        }
        return 0;
      }

      case 'ats': {
        const providerRaw = pos[0]?.toLowerCase();
        const company = pos[1];
        if (!providerRaw || !company) {
          throw new Error('Usage: open-web-intel ats <provider> <company> [options]');
        }
        if (!(ATS_PROVIDERS as readonly string[]).includes(providerRaw)) {
          throw new Error(`Unsupported ATS provider "${providerRaw}". Choose one of: ${ATS_PROVIDERS.join(', ')}`);
        }
        const regionRaw = (parsed.values.region ?? 'us').toLowerCase();
        if (!['us', 'eu', 'auto'].includes(regionRaw)) {
          throw new Error(`Invalid --region "${regionRaw}". Choose us, eu, or auto.`);
        }
        const res = await searchAtsJobs({
          provider: providerRaw as AtsProvider,
          company,
          keywords: parsed.values.keywords,
          location: parsed.values.location,
          remoteOnly: Boolean(parsed.values['remote-only']),
          leverRegion: regionRaw as LeverRegion,
          maxJobs: parseIntFlag(parsed.values['max-jobs'], '--max-jobs', 1, 200),
        });
        if (wantJson) {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
        } else {
          io.stdout(
            `ATS: ${res.provider} (${res.company}) — ${res.matchedCount}/${res.totalFetched} matched\n\n` +
              res.jobs
                .map((j) => `- ${j.title} | ${j.location}${j.remote ? ' [Remote]' : ''}\n  ${j.url}`)
                .join('\n') +
              '\n',
          );
        }
        return 0;
      }

      case 'remote': {
        let sources: RemoteJobSource[] | undefined;
        if (parsed.values.sources) {
          const split = parsed.values.sources
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          for (const s of split) {
            if (!(REMOTE_JOB_SOURCES as readonly string[]).includes(s)) {
              throw new Error(`Unknown remote job source "${s}". Valid: ${REMOTE_JOB_SOURCES.join(', ')}`);
            }
          }
          sources = split as RemoteJobSource[];
        }
        const res = await searchRemoteJobs({
          keywords: parsed.values.keywords ?? pos[0],
          sources,
          maxJobs: parseIntFlag(parsed.values['max-jobs'], '--max-jobs', 1, 200),
        });
        if (wantJson) {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
        } else {
          io.stdout(
            `Remote Jobs Matched: ${res.matchedCount} (queried ${res.sourcesQueried.join(', ')})\n\n` +
              res.jobs
                .map((j) => `- [${j.source}] ${j.title} @ ${j.company} (${j.location})\n  ${j.url}`)
                .join('\n') +
              '\n',
          );
        }
        return 0;
      }

      case 'store': {
        const url = pos[0];
        if (!url) throw new Error('Missing <url> for "store" subcommand');
        const res = await inspectEcommerceStore({
          url,
          maxProducts: parseIntFlag(parsed.values['max-products'], '--max-products', 1, 100),
        });
        if (wantJson) {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
        } else {
          io.stdout(
            `Store: ${res.storeMeta.name ?? res.origin}\nPlatform: ${res.platform}\n` +
              `Signals: ${res.techSignals.join(', ') || 'none'}\n` +
              `Sample Products (${res.products.length}):\n` +
              res.products
                .map(
                  (p) =>
                    `- ${p.title}${p.priceMin !== undefined ? ` (${p.currency ?? ''}${p.priceMin})` : ''} — ${p.url}`,
                )
                .join('\n') +
              '\n',
          );
        }
        return 0;
      }

      case 'enrich': {
        const domainOrUrl = pos[0];
        if (!domainOrUrl) throw new Error('Missing <domain-or-url> for "enrich" subcommand');
        const res = await enrichDomainIntel({
          domainOrUrl,
          checkContactPage: !parsed.values['no-contact-page'],
        });
        if (wantJson) {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
        } else {
          io.stdout(
            `Domain: ${res.domain}\nTitle: ${res.title ?? 'N/A'}\n` +
              `Emails: ${res.emails.join(', ') || 'none'}\n` +
              `Mail Provider: ${res.dns.mailProvider ?? 'none'} (DMARC: ${res.dns.dmarcPolicy ?? 'none'})\n` +
              `llms.txt: ${res.llmsTxt.found ? res.llmsTxt.url : 'not found'}\n` +
              `Tech Stack: ${res.techStack.join(', ') || 'none'}\n`,
          );
        }
        return 0;
      }

      case 'podcasts': {
        const query = pos.join(' ').trim();
        if (!query) throw new Error('Missing <query-or-rss-url> for "podcasts" subcommand');
        const country = parsed.values.country ?? 'US';
        if (country.trim().length !== 2) {
          throw new Error('Invalid --country (expected 2-letter ISO country code, e.g. US)');
        }
        const res = await searchPodcastsRss({
          query,
          maxShows: parseIntFlag(parsed.values['max-shows'], '--max-shows', 1, 20),
          maxEpisodesPerShow: parseIntFlag(parsed.values['max-episodes'], '--max-episodes', 0, 20),
          country,
        });
        if (wantJson) {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
        } else {
          io.stdout(
            `Podcasts (${res.mode}): ${res.showsReturned} show(s)\n\n` +
              res.shows
                .map(
                  (s) =>
                    `- ${s.title}${s.author ? ` by ${s.author}` : ''}\n` +
                    `  Feed: ${s.feedUrl}\n` +
                    `  Email: ${s.ownerEmail ?? 'not listed'} | Episodes: ${s.totalEpisodesInFeed}`,
                )
                .join('\n') +
              '\n',
          );
        }
        return 0;
      }

      default:
        throw new Error(`Unknown subcommand "${subcommand}". Run "open-web-intel --help" for usage.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${message}\n`);
    return 1;
  }
}

function isMainCliModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return entry.endsWith('cli.js') || entry.endsWith('open-web-intel');
  }
}

if (isMainCliModule()) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
