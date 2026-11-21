export {
  assertPublicIp,
  assertPublicUrl,
  createSafeConnectLookup,
  isPublicIpAddress,
  resetDefaultSafeFetchDeps,
  ResponseTooLargeError,
  safeFetch,
  safeFetchJson,
  setDefaultSafeFetchDeps,
  SsrfError,
  type DnsLookupAllFn,
  type ResolvedHostAddress,
  type SafeFetchDeps,
  type SafeFetchOptions,
  type SafeFetchResponse,
} from './lib/safe-fetch.js';

export {
  convertHtmlToMarkdown,
  estimateTokens,
  MAX_HTML_INPUT_CHARS,
  type MarkdownConversionResult,
} from './lib/html-to-markdown.js';

export {
  decodeEntities,
  extractAllXmlBlocks,
  extractFirstTagInner,
  extractXmlAttributes,
  extractXmlTag,
  htmlToPlainText,
  replaceTagBlocks,
  stripHtmlComments,
  stripMarkupTagsLinear,
  stripTagBlocks,
  unwrapCdata,
} from './lib/xml.js';

export {
  fetchMarkdown,
  type FetchMarkdownInput,
  type FetchMarkdownResult,
} from './tools/fetch-markdown.js';

export {
  crawlSitemap,
  type CrawlSitemapInput,
  type CrawlSitemapResult,
  type SitemapUrlEntry,
} from './tools/crawl-sitemap.js';

export {
  ATS_PROVIDERS,
  searchAtsJobs,
  type AtsJobPosting,
  type AtsProvider,
  type LeverRegion,
  type SearchAtsJobsInput,
  type SearchAtsJobsResult,
} from './tools/search-ats-jobs.js';

export {
  REMOTE_JOB_SOURCES,
  searchRemoteJobs,
  type RemoteFeedStatus,
  type RemoteJobListing,
  type RemoteJobSource,
  type SearchRemoteJobsInput,
  type SearchRemoteJobsResult,
} from './tools/search-remote-jobs.js';

export {
  inspectEcommerceStore,
  type EcommercePlatform,
  type EcommerceProductSample,
  type InspectEcommerceStoreInput,
  type InspectEcommerceStoreResult,
} from './tools/inspect-ecommerce-store.js';

export {
  enrichDomainIntel,
  type DnsIntelDeps,
  type EnrichDomainIntelInput,
  type EnrichDomainIntelResult,
  type SocialLinksMap,
} from './tools/enrich-domain-intel.js';

export {
  searchPodcastsRss,
  type PodcastEpisodeItem,
  type PodcastShowIntel,
  type SearchPodcastsRssInput,
  type SearchPodcastsRssResult,
} from './tools/search-podcasts-rss.js';

export {
  createMcpServer,
  SERVER_NAME,
  SERVER_VERSION,
  type CreateMcpServerOptions,
} from './server.js';
