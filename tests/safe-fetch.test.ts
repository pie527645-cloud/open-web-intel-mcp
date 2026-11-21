import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
  assertPublicIp,
  assertPublicUrl,
  createSafeConnectLookup,
  isPublicIpAddress,
  ResponseTooLargeError,
  safeFetch,
  SsrfError,
  type SafeFetchDeps,
} from '../src/lib/safe-fetch.js';

describe('SSRF IP & Hostname Validation', () => {
  it('accepts globally routable IPv4 and IPv6 addresses', () => {
    const validPublicIps = [
      '93.184.216.34',
      '8.8.8.8',
      '1.1.1.1',
      '172.15.255.254',
      '172.32.0.1',
      '100.63.255.254',
      '100.128.0.1',
      '2001:4860:4860::8888',
      '2606:4700:4700::1111',
      '::ffff:93.184.216.34',
    ];
    for (const ip of validPublicIps) {
      assert.equal(isPublicIpAddress(ip), true, `Expected ${ip} to be public`);
      assert.doesNotThrow(() => assertPublicIp(ip));
    }
  });

  it('blocks loopback, RFC1918, CGNAT, link-local, metadata, and unspecified IPv4 ranges', () => {
    const blockedIpv4 = [
      '0.0.0.0',
      '0.1.2.3',
      '127.0.0.1',
      '127.0.0.53',
      '127.255.255.254',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.24.10.5',
      '172.31.255.254',
      '192.168.0.1',
      '192.168.255.254',
      '100.64.0.1',
      '100.127.255.254',
      '169.254.169.254',
      '169.254.170.2',
      '192.0.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ];
    for (const ip of blockedIpv4) {
      assert.equal(isPublicIpAddress(ip), false, `Expected ${ip} to be blocked`);
      assert.throws(() => assertPublicIp(ip), SsrfError);
    }
  });

  it('blocks IPv6 loopback, unspecified, ULA, link-local, NAT64, 6to4, and IPv4-mapped bypasses', () => {
    const blockedIpv6 = [
      '::',
      '::1',
      '0:0:0:0:0:0:0:1',
      'fc00::1',
      'fd00:ec2::254',
      'fe80::1',
      'fe80::1%eth0',
      'fec0::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '::127.0.0.1',
      '64:ff9b::127.0.0.1',
      '64:ff9b::169.254.169.254',
      '2002:7f00:0001::1',
      '2002:a9fe:a9fe::1',
    ];
    for (const ip of blockedIpv6) {
      assert.equal(isPublicIpAddress(ip), false, `Expected ${ip} to be blocked`);
      assert.throws(() => assertPublicIp(ip), SsrfError);
    }
  });

  it('blocks non-HTTP schemes, credentials, localhost variants, and mixed DNS records', async () => {
    const publicDns: SafeFetchDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    };

    await assert.rejects(() => assertPublicUrl('file:///etc/passwd', publicDns), SsrfError);
    await assert.rejects(() => assertPublicUrl('ftp://example.com/pub', publicDns), SsrfError);
    await assert.rejects(() => assertPublicUrl('gopher://example.com:70', publicDns), SsrfError);
    await assert.rejects(() => assertPublicUrl('https://user:pass@example.com/', publicDns), SsrfError);
    await assert.rejects(() => assertPublicUrl('http://localhost:3000/api', publicDns), SsrfError);
    await assert.rejects(() => assertPublicUrl('http://admin.localhost/', publicDns), SsrfError);
    await assert.rejects(() => assertPublicUrl('http://metadata.google.internal/', publicDns), SsrfError);
    await assert.rejects(() => assertPublicUrl('http://service.internal/', publicDns), SsrfError);
    await assert.rejects(() => assertPublicUrl('http://[fe80::1%25eth0]/', publicDns), SsrfError);
    await assert.rejects(() => assertPublicUrl('http://[::ffff:127.0.0.1]/', publicDns), SsrfError);
    await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data/', publicDns), SsrfError);

    // Mixed A/AAAA records where one address is private must be rejected
    const mixedDns: SafeFetchDeps = {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    };
    await assert.rejects(() => assertPublicUrl('https://dualstack.example.com/', mixedDns), SsrfError);
  });
});

describe('safeFetch Redirect & Byte-Limit Defenses', () => {
  it('enforces redirect: manual and blocks redirect hops to 127.0.0.1 or cloud metadata', async () => {
    const fetchedUrls: string[] = [];
    const redirectModes: Array<RequestInit['redirect']> = [];

    const deps: SafeFetchDeps = {
      lookup: async (host) => {
        if (host === 'public.example.com') {
          return [{ address: '93.184.216.34', family: 4 }];
        }
        if (host === 'internal-hop.example.com') {
          return [{ address: '10.0.0.42', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        fetchedUrls.push(url);
        redirectModes.push(init?.redirect);

        if (url === 'https://public.example.com/redirect-local') {
          return new Response('', {
            status: 302,
            headers: { location: 'http://127.0.0.1:8080/secret' },
          });
        }
        if (url === 'https://public.example.com/redirect-dns-private') {
          return new Response('', {
            status: 301,
            headers: { location: 'https://internal-hop.example.com/admin' },
          });
        }
        return new Response('should never reach here', { status: 200 });
      },
    };

    await assert.rejects(
      () => safeFetch('https://public.example.com/redirect-local', { deps }),
      SsrfError,
    );
    await assert.rejects(
      () => safeFetch('https://public.example.com/redirect-dns-private', { deps }),
      SsrfError,
    );

    assert.deepEqual(fetchedUrls, [
      'https://public.example.com/redirect-local',
      'https://public.example.com/redirect-dns-private',
    ]);
    assert.ok(redirectModes.every((m) => m === 'manual'));
  });

  it('follows valid public redirects up to maxRedirects and rejects redirect loops', async () => {
    const deps: SafeFetchDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === 'https://example.com/hop1') {
          return new Response('', { status: 302, headers: { location: '/hop2' } });
        }
        if (url === 'https://example.com/hop2') {
          return new Response('ok-final', { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        // Infinite loop URL
        return new Response('', { status: 302, headers: { location: url } });
      },
    };

    const okRes = await safeFetch('https://example.com/hop1', { deps });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.redirectCount, 1);
    assert.equal(okRes.finalUrl, 'https://example.com/hop2');
    assert.equal(okRes.text, 'ok-final');

    await assert.rejects(
      () => safeFetch('https://example.com/loop', { deps, maxRedirects: 3 }),
      SsrfError,
    );
  });

  it('aborts streaming responses exceeding maxBytes even without Content-Length', async () => {
    const deps: SafeFetchDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => {
        const chunk = new Uint8Array(600).fill(65);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            controller.enqueue(chunk);
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    };

    await assert.rejects(
      () => safeFetch('https://example.com/oversized', { deps, maxBytes: 1000 }),
      ResponseTooLargeError,
    );
  });

  it('blocks DNS-rebinding TOCTOU at socket connect time via undici Agent connect.lookup', async () => {
    let localServerHits = 0;
    const localTarget = createServer((_req, res) => {
      localServerHits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('SENSITIVE_INTERNAL_METADATA');
    });

    await new Promise<void>((resolve) => localTarget.listen(0, '127.0.0.1', () => resolve()));
    try {
      const addr = localTarget.address();
      assert.ok(addr && typeof addr === 'object');

      // Simulate TTL-0 DNS rebinding:
      // Call 1 (assertPublicUrl) -> public IP 93.184.216.34
      // Call 2 (undici socket connect) -> 127.0.0.1 (or mixed public + metadata IP)
      let dnsCallCount = 0;
      const rebindingLookup: SafeFetchDeps['lookup'] = async () => {
        dnsCallCount += 1;
        if (dnsCallCount === 1) {
          return [{ address: '93.184.216.34', family: 4 }];
        }
        return [{ address: '127.0.0.1', family: 4 }];
      };

      await assert.rejects(
        () =>
          safeFetch(`http://rebind.attacker.example:${addr.port}/secret`, {
            deps: { lookup: rebindingLookup },
            timeoutMs: 3000,
          }),
        SsrfError,
      );
      assert.equal(dnsCallCount, 2, 'Expected both pre-check and connect-time lookup to execute');
      assert.equal(localServerHits, 0, 'Local server must never receive a rebinding connection');

      // Also verify createSafeConnectLookup rejects mixed public + private A/AAAA records in both all:true and all:false modes
      const mixedConnectLookup = createSafeConnectLookup(async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);

      await new Promise<void>((resolve, reject) => {
        mixedConnectLookup('mixed.attacker.example', { all: true }, (err) => {
          try {
            assert.ok(err instanceof SsrfError);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        mixedConnectLookup('mixed.attacker.example', { family: 4 }, (err) => {
          try {
            assert.ok(err instanceof SsrfError);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    } finally {
      await new Promise<void>((resolve) => localTarget.close(() => resolve()));
    }
  });
});
