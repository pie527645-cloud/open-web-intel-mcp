import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SafeFetchDeps } from '../src/lib/safe-fetch.js';
import { crawlSitemap } from '../src/tools/crawl-sitemap.js';
import { enrichDomainIntel } from '../src/tools/enrich-domain-intel.js';
import { fetchMarkdown } from '../src/tools/fetch-markdown.js';
import { inspectEcommerceStore } from '../src/tools/inspect-ecommerce-store.js';
import { searchAtsJobs } from '../src/tools/search-ats-jobs.js';
import { searchPodcastsRss } from '../src/tools/search-podcasts-rss.js';
import { searchRemoteJobs } from '../src/tools/search-remote-jobs.js';

function createMockDeps(routes: Record<string, { status?: number; contentType?: string; body: string; headers?: Record<string, string> }>): SafeFetchDeps {
  return {
    lookup: async (host) => {
      if (host === 'internal.bad') {
        return [{ address: '127.0.0.1', family: 4 }];
      }
      return [{ address: '93.184.216.34', family: 4 }];
    },
    fetchImpl: async (input) => {
      const url = String(input);
      const hit = routes[url];
      if (!hit) {
        return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(hit.body, {
        status: hit.status ?? 200,
        headers: {
          'content-type': hit.contentType ?? 'application/json',
          ...(hit.headers ?? {}),
        },
      });
    },
  };
}

describe('7 Web Intelligence Tools (Offline Mocked Fixtures)', () => {
  it('1. fetch_markdown strips scripts/styles/nav and probes llms.txt cleanly', async () => {
    const html = `<!doctype html>
      <html>
        <head>
          <title>Acme Docs &amp; Guides</title>
          <meta name="description" content="Developer reference for Acme." />
          <style>.hidden { display: none; }</style>
          <script>window.__SECRET_NOISE__ = true;</script>
        </head>
        <body>
          <nav><a href="/login">Sign In</a></nav>
          <main>
            <h1>Getting Started</h1>
            <p>Install the SDK and read the <a href="/guide">Quickstart Guide</a> for full details on streaming events and retries.</p>
            <pre><code class="language-ts">const client = createClient();</code></pre>
          </main>
          <footer>Copyright 2026</footer>
        </body>
      </html>`;

    const deps = createMockDeps({
      'https://docs.example.com/intro': { contentType: 'text/html; charset=utf-8', body: html },
      'https://docs.example.com/llms.txt': { contentType: 'text/plain', body: '# Acme LLM Index\n- /intro' },
    });

    const res = await fetchMarkdown({
      url: 'https://docs.example.com/intro',
      includeLlmsTxt: true,
      deps,
    });

    assert.equal(res.title, 'Acme Docs & Guides');
    assert.equal(res.description, 'Developer reference for Acme.');
    assert.ok(res.markdown.includes('# Getting Started'));
    assert.ok(res.markdown.includes('[Quickstart Guide](https://docs.example.com/guide)'));
    assert.ok(res.markdown.includes('```ts\nconst client = createClient();\n```'));
    assert.ok(!res.markdown.includes('__SECRET_NOISE__'));
    assert.ok(!res.markdown.includes('Sign In'));
    assert.ok(res.approxTokens > 10);
    assert.equal(res.llmsTxt?.found, true);
    assert.ok(res.llmsTxt?.content?.includes('Acme LLM Index'));
  });

  it('2. crawl_sitemap parses robots.txt, recurses sitemap indexes, and blocks SSRF child URLs', async () => {
    const deps = createMockDeps({
      'https://site.example.com/robots.txt': {
        contentType: 'text/plain',
        body: 'User-agent: *\nDisallow: /admin\nSitemap: https://site.example.com/sitemap_index.xml\n',
      },
      'https://site.example.com/sitemap_index.xml': {
        contentType: 'application/xml',
        body: `<?xml version="1.0" encoding="UTF-8"?>
          <sitemapindex>
            <sitemap><loc>https://site.example.com/sitemap-blog.xml</loc></sitemap>
            <sitemap><loc>http://internal.bad/private-sitemap.xml</loc></sitemap>
          </sitemapindex>`,
      },
      'https://site.example.com/sitemap-blog.xml': {
        contentType: 'application/xml',
        body: `<?xml version="1.0" encoding="UTF-8"?>
          <urlset>
            <url><loc>https://site.example.com/blog/post-1?ref=a&amp;b=2</loc><lastmod>2026-10-01</lastmod></url>
            <url><loc>https://site.example.com/pricing</loc></url>
          </urlset>`,
      },
    });

    const res = await crawlSitemap({
      url: 'https://site.example.com/',
      pathFilter: '/blog/',
      deps,
    });

    assert.equal(res.robotsTxtFound, true);
    assert.deepEqual(res.disallowedPaths, ['/admin']);
    assert.equal(res.totalCollected, 1);
    assert.equal(res.entries[0]?.loc, 'https://site.example.com/blog/post-1?ref=a&b=2');
    assert.equal(res.sitemapErrors.length, 1);
    assert.match(res.sitemapErrors[0]?.error ?? '', /Blocked non-public IP/i);
  });

  it('3. search_ats_jobs supports greenhouse (double-escaped HTML), lever EU, ashby, workable, personio XML, and recruitee', async () => {
    const deps = createMockDeps({
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true': {
        body: JSON.stringify({
          jobs: [
            {
              id: 101,
              title: 'Senior TypeScript Engineer',
              updated_at: '2026-11-01T00:00:00Z',
              location: { name: 'Remote - US' },
              absolute_url: 'https://boards.greenhouse.io/acme/jobs/101',
              content: '&amp;lt;div&amp;gt;&amp;lt;p&amp;gt;Build distributed systems &amp;amp; APIs.&amp;lt;/p&amp;gt;&amp;lt;/div&amp;gt;',
              departments: [{ name: 'Platform' }],
            },
          ],
        }),
      },
      'https://api.lever.co/v0/postings/eucompany?mode=json': { status: 404, body: 'Not found' },
      'https://api.eu.lever.co/v0/postings/eucompany?mode=json': {
        body: JSON.stringify([
          {
            id: 'lev-1',
            text: 'Backend Engineer',
            hostedUrl: 'https://jobs.eu.lever.co/eucompany/lev-1',
            workplaceType: 'remote',
            categories: { location: 'Berlin', department: 'Engineering', commitment: 'Full-time' },
            descriptionPlain: 'Go and Postgres microservices.',
          },
        ]),
      },
      'https://api.ashbyhq.com/posting-api/job-board/ashbyco?includeCompensation=true': {
        body: JSON.stringify({
          jobs: [
            {
              id: 'ash-1',
              title: 'AI Systems Engineer',
              department: 'Research',
              location: 'San Francisco',
              isRemote: true,
              jobUrl: 'https://jobs.ashbyhq.com/ashbyco/ash-1',
              descriptionPlain: 'TypeScript MCP tooling.',
              compensation: { compensationTierSummary: '$180K - $220K' },
            },
          ],
        }),
      },
      'https://apply.workable.com/api/v3/accounts/workco/jobs': {
        body: JSON.stringify({
          results: [
            {
              shortcode: 'WK99',
              title: 'DevOps Engineer',
              remote: true,
              department: ['Infrastructure'],
              location: { city: 'London', country: 'UK' },
            },
          ],
        }),
      },
      'https://persco.jobs.personio.de/xml?language=en': {
        contentType: 'application/xml',
        body: `<?xml version="1.0" encoding="UTF-8"?>
          <workzag-jobs>
            <position>
              <id>555</id>
              <name>Data Engineer (Remote)</name>
              <office>Remote - Germany</office>
              <department>Data</department>
              <schedule>full-time</schedule>
              <jobDescriptions>
                <jobDescription><value><![CDATA[<p>Python &amp; Spark pipelines.</p>]]></value></jobDescription>
              </jobDescriptions>
            </position>
          </workzag-jobs>`,
      },
      'https://recco.recruitee.com/api/offers/': {
        body: JSON.stringify({
          offers: [
            {
              id: 777,
              slug: 'product-designer',
              title: 'Product Designer',
              department: 'Design',
              location: 'Amsterdam',
              remote: true,
              careers_url: 'https://recco.recruitee.com/o/product-designer',
              description: '<p>Design clean developer interfaces.</p>',
            },
          ],
        }),
      },
    });

    const gh = await searchAtsJobs({ provider: 'greenhouse', company: 'acme', keywords: 'typescript', deps });
    assert.equal(gh.matchedCount, 1);
    assert.equal(gh.jobs[0]?.snippet, 'Build distributed systems & APIs.');
    assert.equal(gh.jobs[0]?.remote, true);

    const lv = await searchAtsJobs({ provider: 'lever', company: 'eucompany', leverRegion: 'auto', deps });
    assert.equal(lv.matchedCount, 1);
    assert.ok(lv.endpointUrl.includes('api.eu.lever.co'));

    const ash = await searchAtsJobs({ provider: 'ashby', company: 'ashbyco', deps });
    assert.equal(ash.jobs[0]?.salary, '$180K - $220K');

    const wk = await searchAtsJobs({ provider: 'workable', company: 'workco', deps });
    assert.equal(wk.jobs[0]?.url, 'https://apply.workable.com/workco/j/WK99/');

    const ps = await searchAtsJobs({ provider: 'personio', company: 'persco', remoteOnly: true, deps });
    assert.equal(ps.matchedCount, 1);
    assert.equal(ps.jobs[0]?.snippet, 'Python & Spark pipelines.');

    const rc = await searchAtsJobs({ provider: 'recruitee', company: 'recco', deps });
    assert.equal(rc.matchedCount, 1);

    await assert.rejects(() => searchAtsJobs({ provider: 'recruitee', company: '../bad.host', deps }));
  });

  it('4. search_remote_jobs aggregates, deduplicates, and survives partial feed failures', async () => {
    const deps = createMockDeps({
      'https://remotive.com/api/remote-jobs?limit=60': {
        body: JSON.stringify({
          jobs: [
            {
              id: 1,
              title: 'Platform Engineer',
              company_name: 'Orbit Labs',
              candidate_required_location: 'Worldwide',
              publication_date: '2026-11-15T10:00:00Z',
              url: 'https://orbit.example/jobs/platform',
              description: '<p>TypeScript and Kubernetes</p>',
            },
          ],
        }),
      },
      'https://jobicy.com/api/v2/remote-jobs?count=50': {
        status: 503,
        body: 'Service Unavailable',
      },
      'https://himalayas.app/jobs/api?limit=50': {
        body: JSON.stringify({
          jobs: [
            {
              guid: 'him-1',
              title: 'Platform Engineer',
              companyName: 'Orbit Labs',
              pubDate: 1763200000,
              applicationLink: 'https://orbit.example/jobs/platform?utm_source=himalayas',
              excerpt: 'Duplicate listing from another board.',
            },
          ],
        }),
      },
      'https://remoteok.com/api': {
        body: JSON.stringify([
          { legal: 'Attribution notice without position field' },
          {
            id: 99,
            position: 'Rust Systems Engineer',
            company: 'Ferris Corp',
            location: 'Remote',
            tags: ['rust', 'systems'],
            date: '2026-11-16T12:00:00Z',
            url: 'https://ferris.example/jobs/rust',
            description: 'Low-latency networking.',
          },
        ]),
      },
      'https://weworkremotely.com/remote-jobs.rss': {
        contentType: 'application/rss+xml',
        body: `<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0"><channel>
            <item>
              <title>Zephyr AI: Fullstack TypeScript Engineer</title>
              <link>https://weworkremotely.com/remote-jobs/zephyr-fullstack</link>
              <region>Anywhere in the World</region>
              <category>Programming</category>
              <pubDate>Tue, 17 Nov 2026 08:00:00 GMT</pubDate>
              <description><![CDATA[<p>Build TypeScript agent workflows.</p>]]></description>
            </item>
          </channel></rss>`,
      },
    });

    const res = await searchRemoteJobs({ keywords: 'typescript', deps });
    assert.equal(res.feedStatuses.find((f) => f.source === 'jobicy')?.ok, false);
    // Orbit Labs duplicate collapsed into 1 + Zephyr AI = 2 TypeScript jobs (Rust excluded by keyword)
    assert.equal(res.matchedCount, 2);
    assert.equal(res.jobs[0]?.company, 'Zephyr AI');
  });

  it('5. inspect_ecommerce_store detects Shopify and WooCommerce catalogs accurately', async () => {
    const shopifyDeps = createMockDeps({
      'https://shop.example.com/': {
        contentType: 'text/html',
        body: '<html><head><title>Roast Coffee</title><script src="https://cdn.shopify.com/s/app.js"></script><script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script></head></html>',
      },
      'https://shop.example.com/meta.json': {
        body: JSON.stringify({
          name: 'Roast Coffee Co',
          myshopify_domain: 'roast-coffee.myshopify.com',
          currency: 'USD',
          country: 'US',
        }),
      },
      'https://shop.example.com/products.json?limit=10': {
        body: JSON.stringify({
          products: [
            {
              id: 501,
              title: 'Espresso Blend',
              handle: 'espresso-blend',
              vendor: 'Roast',
              product_type: 'Beans',
              tags: 'dark, organic',
              variants: [
                { price: '18.50', available: true },
                { price: '34.00', available: false },
              ],
            },
          ],
        }),
      },
    });

    const shopifyRes = await inspectEcommerceStore({
      url: 'https://shop.example.com/',
      maxProducts: 5,
      deps: shopifyDeps,
    });
    assert.equal(shopifyRes.platform, 'shopify');
    assert.equal(shopifyRes.storeMeta.myshopifyDomain, 'roast-coffee.myshopify.com');
    assert.ok(shopifyRes.techSignals.includes('klaviyo'));
    assert.equal(shopifyRes.products[0]?.priceMin, 18.5);
    assert.equal(shopifyRes.products[0]?.priceMax, 34);

    const wooDeps = createMockDeps({
      'https://woo.example.com/': {
        contentType: 'text/html',
        body: '<html><head><title>Gear Shop</title><link href="/wp-content/plugins/woocommerce/style.css" /></head></html>',
      },
      'https://woo.example.com/wp-json/wc/store/v1/products?per_page=10': {
        body: JSON.stringify([
          {
            id: 88,
            name: 'Trail Backpack',
            slug: 'trail-backpack',
            permalink: 'https://woo.example.com/product/trail-backpack/',
            is_in_stock: true,
            prices: { price: '7995', currency_code: 'EUR', currency_minor_unit: 2 },
            categories: [{ name: 'Packs' }],
          },
        ]),
      },
    });

    const wooRes = await inspectEcommerceStore({
      url: 'https://woo.example.com/',
      maxProducts: 5,
      deps: wooDeps,
    });
    assert.equal(wooRes.platform, 'woocommerce');
    assert.equal(wooRes.products[0]?.priceMin, 79.95);
    assert.equal(wooRes.products[0]?.currency, 'EUR');
  });

  it('6. enrich_domain_intel extracts contact emails, socials, DNS MX/SPF/DMARC, llms.txt, and tech stack', async () => {
    const deps = createMockDeps({
      'https://acmefixture.example/': {
        contentType: 'text/html',
        headers: { server: 'cloudflare', 'x-vercel-id': 'iad1::12345' },
        body: `<html>
          <head><title>Acme Cloud</title><script src="/_next/static/chunks/main.js"></script><script src="https://js.stripe.com/v3/"></script></head>
          <body>
            <img src="hero@2x.png" />
            <a href="/contact">Contact Us</a>
            <a href="https://github.com/acme-cloud">GitHub</a>
            <a href="https://www.linkedin.com/company/acme-cloud/">LinkedIn</a>
            <a href="https://x.com/acmecloud">X</a>
          </body>
        </html>`,
      },
      'https://acmefixture.example/contact': {
        contentType: 'text/html',
        body: '<html><body>Reach us at <a href="mailto:partnerships@acmefixture.example">Email</a> or press@acmefixture.example.</body></html>',
      },
      'https://acmefixture.example/llms.txt': {
        contentType: 'text/plain',
        body: '# Acme Cloud\n> Developer infrastructure.',
      },
    });

    const res = await enrichDomainIntel({
      domainOrUrl: 'acmefixture.example',
      deps,
      dnsDeps: {
        resolveMx: async () => [{ exchange: 'aspmx.l.google.com.', priority: 1 }],
        resolveTxt: async (host) => {
          if (host.startsWith('_dmarc.')) {
            return [['v=DMARC1; p=reject; rua=mailto:dmarc@acmefixture.example']];
          }
          return [
            ['v=spf1 include:_spf.google.com ~all'],
            ['google-site-verification=synthetic_token_check'],
          ];
        },
      },
    });

    assert.deepEqual(res.emails, ['partnerships@acmefixture.example', 'press@acmefixture.example']);
    assert.deepEqual(res.socialLinks.github, ['https://github.com/acme-cloud']);
    assert.deepEqual(res.socialLinks.linkedin, ['https://www.linkedin.com/company/acme-cloud']);
    assert.equal(res.llmsTxt.found, true);
    assert.equal(res.dns.mailProvider, 'google-workspace');
    assert.equal(res.dns.dmarcPolicy, 'reject');
    assert.ok(res.dns.spfRecord?.startsWith('v=spf1'));
    assert.ok(res.techStack.includes('cloudflare'));
    assert.ok(res.techStack.includes('vercel'));
    assert.ok(res.techStack.includes('nextjs'));
    assert.ok(res.techStack.includes('stripe'));
  });

  it('7. search_podcasts_rss queries Apple Podcasts Search API and parses RSS owner email & episodes', async () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
        <channel>
          <title>Systems Engineering Weekly</title>
          <link>https://podcastfixture.example</link>
          <language>en-us</language>
          <description><![CDATA[<p>Deep dives into distributed systems.</p>]]></description>
          <itunes:author> Taylor Host </itunes:author>
          <itunes:owner>
            <itunes:name>Taylor Host</itunes:name>
            <itunes:email>bookings@podcastfixture.example</itunes:email>
          </itunes:owner>
          <itunes:category text="Technology" />
          <itunes:image href="https://podcastfixture.example/cover.jpg" />
          <item>
            <title>Ep 42: Zero-Browser Scraping</title>
            <link>https://podcastfixture.example/ep/42</link>
            <pubDate>Mon, 16 Nov 2026 12:00:00 GMT</pubDate>
            <itunes:duration>00:44:10</itunes:duration>
            <enclosure url="https://podcastfixture.example/audio/ep42.mp3" type="audio/mpeg" length="123456" />
            <description><![CDATA[<p>Why direct JSON &amp; RSS APIs beat headless browsers.</p>]]></description>
          </item>
        </channel>
      </rss>`;

    const deps = createMockDeps({
      'https://itunes.apple.com/search?media=podcast&entity=podcast&term=systems%20engineering&country=US&limit=2': {
        body: JSON.stringify({
          resultCount: 1,
          results: [
            {
              collectionName: 'Systems Engineering Weekly',
              artistName: 'Taylor Host',
              feedUrl: 'https://podcastfixture.example/feed.xml',
              primaryGenreName: 'Technology',
            },
          ],
        }),
      },
      'https://podcastfixture.example/feed.xml': {
        contentType: 'application/rss+xml',
        body: rssXml,
      },
    });

    const res = await searchPodcastsRss({
      query: 'systems engineering',
      maxShows: 2,
      maxEpisodesPerShow: 2,
      deps,
    });

    assert.equal(res.mode, 'itunes-search');
    assert.equal(res.showsReturned, 1);
    const show = res.shows[0]!;
    assert.equal(show.ownerEmail, 'bookings@podcastfixture.example');
    assert.equal(show.ownerName, 'Taylor Host');
    assert.equal(show.recentEpisodes.length, 1);
    assert.equal(show.recentEpisodes[0]?.audioUrl, 'https://podcastfixture.example/audio/ep42.mp3');
    assert.equal(show.recentEpisodes[0]?.summary, 'Why direct JSON & RSS APIs beat headless browsers.');
  });
});
