import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, it } from 'node:test';
import { runCli } from '../src/cli.js';
import { convertHtmlToMarkdown, MAX_HTML_INPUT_CHARS } from '../src/lib/html-to-markdown.js';
import { resetDefaultSafeFetchDeps, setDefaultSafeFetchDeps } from '../src/lib/safe-fetch.js';
import { decodeEntities, extractAllXmlBlocks, htmlToPlainText } from '../src/lib/xml.js';
import { fetchMarkdown } from '../src/tools/fetch-markdown.js';
import { searchAtsJobs } from '../src/tools/search-ats-jobs.js';
import { searchPodcastsRss } from '../src/tools/search-podcasts-rss.js';

afterEach(() => {
  resetDefaultSafeFetchDeps();
});

describe('HTML, XML, Fallback Endpoints & Full CLI Subcommand Coverage', () => {
  it('converts tables, ordered lists, blockquotes, emphasis, and truncates cleanly', () => {
    const html = `<html><head><title>Spec Sheet</title><link rel="canonical" href="https://example.com/spec" /></head>
      <body><article>
        <h2>Overview</h2>
        <p>Supports <strong>strict</strong> and <em>streaming</em> modes across deployments with zero headless overhead.</p>
        <blockquote>Security by default on every outbound HTTP request.</blockquote>
        <ol><li>Validate URL</li><li>Resolve DNS</li></ol>
        <table><tr><th>Feature</th><th>Status</th></tr><tr><td>SSRF Guard</td><td>Active</td></tr></table>
      </article></body></html>`;

    const res = convertHtmlToMarkdown(html, 'https://example.com/raw', 5000);
    assert.equal(res.title, 'Spec Sheet');
    assert.equal(res.canonicalUrl, 'https://example.com/spec');
    assert.ok(res.markdown.includes('## Overview'));
    assert.ok(res.markdown.includes('**strict**'));
    assert.ok(res.markdown.includes('*streaming*'));
    assert.ok(res.markdown.includes('> Security by default'));
    assert.ok(res.markdown.includes('1. Validate URL'));
    assert.ok(res.markdown.includes('| Feature | Status |'));

    const truncated = convertHtmlToMarkdown(html, 'https://example.com/raw', 60);
    assert.equal(truncated.truncated, true);
    assert.ok(truncated.markdown.length <= 60);
  });

  it('decodes decimal, hex, and double-escaped entities accurately', () => {
    assert.equal(decodeEntities('Price &#36;10 &amp; &#x2713;'), 'Price $10 & ✓');
    assert.equal(
      htmlToPlainText('&amp;lt;p&amp;gt; Engineer &amp;ndash; Core &amp;lt;/p&amp;gt;'),
      'Engineer – Core',
    );
  });

  it('handles JSON responses in fetchMarkdown, Workable v1 fallback, and direct RSS URL mode', async () => {
    const deps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://api.example.com/info.json') {
          return new Response('{"status":"healthy","items":[1,2]}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === 'https://apply.workable.com/api/v3/accounts/legacyco/jobs') {
          return new Response('Not Found', { status: 404 });
        }
        if (url === 'https://www.workable.com/api/accounts/legacyco?details=true') {
          return new Response(
            JSON.stringify({
              jobs: [
                {
                  shortcode: 'LG1',
                  title: 'Site Reliability Engineer',
                  telecommuting: true,
                  city: 'Toronto',
                  country: 'Canada',
                  description: '<p>Maintain high availability clusters.</p>',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url === 'https://podcastfixture.example/direct.xml') {
          return new Response(
            `<?xml version="1.0"?><rss version="2.0"><channel><title>Direct Feed</title><managingEditor>editor@podcastfixture.example (Lead Editor)</managingEditor><item><title>Ep 1</title><description>Intro</description></item></channel></rss>`,
            { status: 200, headers: { 'content-type': 'application/rss+xml' } },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
    };

    const mdJson = await fetchMarkdown({ url: 'https://api.example.com/info.json', deps });
    assert.ok(mdJson.markdown.includes('```json'));
    assert.ok(mdJson.markdown.includes('"status": "healthy"'));

    const wkLegacy = await searchAtsJobs({ provider: 'workable', company: 'legacyco', deps });
    assert.equal(wkLegacy.matchedCount, 1);
    assert.equal(wkLegacy.jobs[0]?.remote, true);

    const directPod = await searchPodcastsRss({
      query: 'https://podcastfixture.example/direct.xml',
      deps,
    });
    assert.equal(directPod.mode, 'direct-rss');
    assert.equal(directPod.shows[0]?.ownerEmail, 'editor@podcastfixture.example');
  });

  it('runs CLI sitemap, ats, remote, store, and podcasts subcommands with --json', async () => {
    setDefaultSafeFetchDeps({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === 'https://example.com/sitemap.xml') {
          return new Response(
            '<urlset><url><loc>https://example.com/docs</loc></url></urlset>',
            { status: 200, headers: { 'content-type': 'application/xml' } },
          );
        }
        if (url.includes('boards-api.greenhouse.io')) {
          return new Response(
            JSON.stringify({ jobs: [{ id: 1, title: 'Backend Dev', location: { name: 'Remote' }, content: 'Node.js' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('remotive.com')) {
          return new Response(
            JSON.stringify({ jobs: [{ id: 9, title: 'Infra Engineer', company_name: 'CloudCo', url: 'https://cloudco.example/9' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url === 'https://store.example.com/products.json?limit=10') {
          return new Response(
            JSON.stringify({ products: [{ id: 1, title: 'Mug', handle: 'mug', variants: [{ price: '12.00', available: true }] }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url === 'https://podcastfixture.example/rss.xml') {
          return new Response(
            '<rss><channel><title>CLI Cast</title></channel></rss>',
            { status: 200, headers: { 'content-type': 'application/xml' } },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    const execJson = async (args: string[]) => {
      let stdout = '';
      const code = await runCli(args, {
        stdout: (s) => {
          stdout += s;
        },
        stderr: () => undefined,
      });
      assert.equal(code, 0);
      return JSON.parse(stdout) as Record<string, unknown>;
    };

    const sm = await execJson(['sitemap', 'https://example.com/sitemap.xml', '--json']);
    assert.equal(sm['totalCollected'], 1);

    const ats = await execJson(['ats', 'greenhouse', 'acme', '--remote-only', '--json']);
    assert.equal(ats['matchedCount'], 1);

    const rem = await execJson(['remote', '--sources', 'remotive', '--max-jobs', '5', '--json']);
    assert.equal(rem['matchedCount'], 1);

    const st = await execJson(['store', 'https://store.example.com/', '--max-products', '5', '--json']);
    assert.equal(st['platform'], 'shopify');

    const pod = await execJson(['podcasts', 'https://podcastfixture.example/rss.xml', '--json']);
    assert.equal(pod['showsReturned'], 1);
  });

  it('completes pathological unclosed XML/HTML tag inputs in linear O(n) time (< 500 ms) and enforces 512 KB cap', () => {
    const hostileXml = '<url>'.repeat(200_000);
    const t0 = performance.now();
    const xmlBlocks = extractAllXmlBlocks(hostileXml, 'url');
    const xmlElapsedMs = performance.now() - t0;
    assert.equal(xmlBlocks.length, 0);
    assert.ok(xmlElapsedMs < 500, `Expected <url>*200000 under 500 ms, took ${xmlElapsedMs.toFixed(1)} ms`);

    const hostileScripts = '<script>'.repeat(50_000);
    const t1 = performance.now();
    const scriptMd = convertHtmlToMarkdown(hostileScripts, 'https://example.com/');
    const scriptElapsedMs = performance.now() - t1;
    assert.equal(scriptMd.markdown, '');
    assert.ok(
      scriptElapsedMs < 500,
      `Expected <script>*50000 under 500 ms, took ${scriptElapsedMs.toFixed(1)} ms`,
    );

    const hostileInline = '<li><a href="/x"><b>'.repeat(30_000);
    const t2 = performance.now();
    convertHtmlToMarkdown(hostileInline, 'https://example.com/');
    htmlToPlainText(hostileScripts);
    const inlineElapsedMs = performance.now() - t2;
    assert.ok(
      inlineElapsedMs < 500,
      `Expected unclosed inline tags under 500 ms, took ${inlineElapsedMs.toFixed(1)} ms`,
    );

    // Verify 512 KB HTML input cap drops trailing content beyond MAX_HTML_INPUT_CHARS
    const hugePrefix = `<main><p>${'A'.repeat(MAX_HTML_INPUT_CHARS)}</p><p>TRAILING_BEYOND_CAP</p></main>`;
    const cappedRes = convertHtmlToMarkdown(hugePrefix, 'https://example.com/', 100_000);
    assert.equal(cappedRes.markdown.includes('TRAILING_BEYOND_CAP'), false);
  });
});
