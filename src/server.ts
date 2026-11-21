import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { crawlSitemap } from './tools/crawl-sitemap.js';
import { enrichDomainIntel, type DnsIntelDeps } from './tools/enrich-domain-intel.js';
import { fetchMarkdown } from './tools/fetch-markdown.js';
import { inspectEcommerceStore } from './tools/inspect-ecommerce-store.js';
import { ATS_PROVIDERS, searchAtsJobs } from './tools/search-ats-jobs.js';
import { searchPodcastsRss } from './tools/search-podcasts-rss.js';
import { REMOTE_JOB_SOURCES, searchRemoteJobs } from './tools/search-remote-jobs.js';
import type { SafeFetchDeps } from './lib/safe-fetch.js';

/** Package version reported during MCP initialization. */
export const SERVER_VERSION = '1.0.0';

/** Package name reported during MCP initialization. */
export const SERVER_NAME = 'open-web-intel-mcp';

/** Optional dependency overrides passed to `createMcpServer` during tests. */
export interface CreateMcpServerOptions {
  deps?: SafeFetchDeps;
  dnsDeps?: DnsIntelDeps;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function formatToolSuccess(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function formatToolFailure(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: message }, null, 2),
      },
    ],
  };
}

/**
 * Creates a configured `McpServer` instance registering all 7 SSRF-safe web intelligence tools.
 */
export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    'fetch_markdown',
    {
      description:
        'Fetches a public web page, strips boilerplate and scripts, and converts content to clean Markdown.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        url: z.string().url().describe('Public web page URL to fetch.'),
        includeLlmsTxt: z
          .boolean()
          .default(false)
          .describe('Also check the site root for an llms.txt summary file.'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(200000)
          .default(30000)
          .describe('Maximum Markdown character length returned.'),
      },
    },
    async (args) => {
      try {
        const result = await fetchMarkdown({
          url: args.url,
          includeLlmsTxt: args.includeLlmsTxt,
          maxChars: args.maxChars,
          deps: options.deps,
        });
        return formatToolSuccess(result);
      } catch (err) {
        return formatToolFailure(err);
      }
    },
  );

  server.registerTool(
    'crawl_sitemap',
    {
      description:
        'Reads robots.txt and XML sitemaps with bounded recursion and returns structured page URLs.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        url: z.string().url().describe('Website root URL or direct XML sitemap URL.'),
        maxUrls: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(200)
          .describe('Maximum URLs to collect.'),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(4)
          .default(2)
          .describe('Maximum nested sitemap index depth.'),
        pathFilter: z
          .string()
          .optional()
          .describe('Optional case-insensitive URL substring filter.'),
      },
    },
    async (args) => {
      try {
        const result = await crawlSitemap({
          url: args.url,
          maxUrls: args.maxUrls,
          maxDepth: args.maxDepth,
          pathFilter: args.pathFilter,
          deps: options.deps,
        });
        return formatToolSuccess(result);
      } catch (err) {
        return formatToolFailure(err);
      }
    },
  );

  server.registerTool(
    'search_ats_jobs',
    {
      description:
        'Queries public Greenhouse, Lever, Ashby, Workable, Personio, or Recruitee job boards by company slug.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        provider: z.enum(ATS_PROVIDERS).describe('ATS platform identifier.'),
        company: z.string().min(1).max(100).describe('Company board slug on the chosen ATS.'),
        keywords: z
          .string()
          .optional()
          .describe('Optional space-separated keywords matched against role and summary.'),
        location: z
          .string()
          .optional()
          .describe('Optional case-insensitive location filter.'),
        remoteOnly: z
          .boolean()
          .default(false)
          .describe('Return only remote-eligible job listings.'),
        leverRegion: z
          .enum(['us', 'eu', 'auto'])
          .default('us')
          .describe('Lever API region when provider is lever.'),
        maxJobs: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(30)
          .describe('Maximum matching jobs returned.'),
      },
    },
    async (args) => {
      try {
        const result = await searchAtsJobs({
          provider: args.provider,
          company: args.company,
          keywords: args.keywords,
          location: args.location,
          remoteOnly: args.remoteOnly,
          leverRegion: args.leverRegion,
          maxJobs: args.maxJobs,
          deps: options.deps,
        });
        return formatToolSuccess(result);
      } catch (err) {
        return formatToolFailure(err);
      }
    },
  );

  server.registerTool(
    'search_remote_jobs',
    {
      description:
        'Aggregates and deduplicates remote tech listings across Remotive, Jobicy, Himalayas, RemoteOK, and WeWorkRemotely.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        keywords: z
          .string()
          .optional()
          .describe('Optional keywords matched across job title, company, and tags.'),
        sources: z
          .array(z.enum(REMOTE_JOB_SOURCES))
          .optional()
          .describe('Optional subset of remote job feeds to query.'),
        maxJobs: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(30)
          .describe('Maximum deduplicated listings returned.'),
      },
    },
    async (args) => {
      try {
        const result = await searchRemoteJobs({
          keywords: args.keywords,
          sources: args.sources,
          maxJobs: args.maxJobs,
          deps: options.deps,
        });
        return formatToolSuccess(result);
      } catch (err) {
        return formatToolFailure(err);
      }
    },
  );

  server.registerTool(
    'inspect_ecommerce_store',
    {
      description:
        'Inspects public Shopify and WooCommerce catalog endpoints plus storefront platform and app signals.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        url: z.string().url().describe('Public ecommerce storefront URL.'),
        maxProducts: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(15)
          .describe('Maximum sample products returned.'),
      },
    },
    async (args) => {
      try {
        const result = await inspectEcommerceStore({
          url: args.url,
          maxProducts: args.maxProducts,
          deps: options.deps,
        });
        return formatToolSuccess(result);
      } catch (err) {
        return formatToolFailure(err);
      }
    },
  );

  server.registerTool(
    'enrich_domain_intel',
    {
      description:
        'Extracts public contact emails, social profiles, llms.txt status, DNS MX/SPF/DMARC records, and tech stack signals.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        domainOrUrl: z
          .string()
          .min(1)
          .describe('Public domain name or full website URL.'),
        checkContactPage: z
          .boolean()
          .default(true)
          .describe('Follow one same-origin contact or about link if homepage has no emails.'),
      },
    },
    async (args) => {
      try {
        const result = await enrichDomainIntel({
          domainOrUrl: args.domainOrUrl,
          checkContactPage: args.checkContactPage,
          deps: options.deps,
          dnsDeps: options.dnsDeps,
        });
        return formatToolSuccess(result);
      } catch (err) {
        return formatToolFailure(err);
      }
    },
  );

  server.registerTool(
    'search_podcasts_rss',
    {
      description:
        'Searches podcasts via Apple Podcasts directory and parses RSS feeds for owner email, metadata, and recent episodes.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Search keywords or direct public podcast RSS feed URL.'),
        maxShows: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe('Maximum podcast shows to inspect.'),
        maxEpisodesPerShow: z
          .number()
          .int()
          .min(0)
          .max(20)
          .default(3)
          .describe('Maximum recent episodes parsed per RSS feed.'),
        country: z
          .string()
          .length(2)
          .default('US')
          .describe('Two-letter ISO country code for directory search.'),
      },
    },
    async (args) => {
      try {
        const result = await searchPodcastsRss({
          query: args.query,
          maxShows: args.maxShows,
          maxEpisodesPerShow: args.maxEpisodesPerShow,
          country: args.country,
          deps: options.deps,
        });
        return formatToolSuccess(result);
      } catch (err) {
        return formatToolFailure(err);
      }
    },
  );

  return server;
}
