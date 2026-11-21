import type { LookupAddress } from 'node:dns';
import { lookup as nodeDnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/** Default User-Agent sent on outbound HTTP requests. */
export const DEFAULT_USER_AGENT =
  'open-web-intel-mcp/1.0 (+https://github.com/pie527645-cloud/open-web-intel-mcp; zero-browser-ssrf-safe)';

/** Default per-hop request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Default response body byte ceiling (2 MiB). */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Default maximum HTTP redirect hops allowed. */
export const DEFAULT_MAX_REDIRECTS = 5;

/** Single resolved DNS address record. */
export interface ResolvedHostAddress {
  address: string;
  family: number;
}

/** Injectable DNS lookup signature matching `dns.promises.lookup(host, { all: true })`. */
export type DnsLookupAllFn = (hostname: string) => Promise<ResolvedHostAddress[]>;

/** Injectable runtime dependencies for deterministic unit testing. */
export interface SafeFetchDeps {
  lookup?: DnsLookupAllFn;
  fetchImpl?: typeof fetch;
}

/** Options accepted by `safeFetch` and `safeFetchJson`. */
export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  deps?: SafeFetchDeps;
}

/** Validated HTTP response returned by `safeFetch`. */
export interface SafeFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  finalUrl: string;
  redirectCount: number;
  contentType: string;
  headers: Record<string, string>;
  text: string;
  byteLength: number;
}

/** Thrown when a URL, hostname, IP, or redirect hop violates SSRF policy. */
export class SsrfError extends Error {
  public readonly code = 'SSRF_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** Thrown when an HTTP response exceeds the configured byte limit. */
export class ResponseTooLargeError extends Error {
  public readonly code = 'RESPONSE_TOO_LARGE';

  constructor(maxBytes: number) {
    super(`Response body exceeded maximum size of ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

const builtinDnsLookup: DnsLookupAllFn = (hostname: string) =>
  nodeDnsLookup(hostname, { all: true, verbatim: true });

let customDefaultLookup: DnsLookupAllFn | undefined;
let customDefaultFetch: typeof fetch | undefined;

/**
 * Overrides default DNS lookup and/or fetch implementations (intended for offline tests).
 */
export function setDefaultSafeFetchDeps(overrides: SafeFetchDeps): void {
  customDefaultLookup = overrides.lookup;
  customDefaultFetch = overrides.fetchImpl;
}

/**
 * Resets DNS lookup and fetch implementations back to production defaults.
 */
export function resetDefaultSafeFetchDeps(): void {
  customDefaultLookup = undefined;
  customDefaultFetch = undefined;
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    nums.push(value);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isPrivateOrReservedIpv4Octets([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 unspecified / current network
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
  return false;
}

function parseIpv6Hextets(rawIp: string): number[] | null {
  if (rawIp.includes('%')) return null; // Reject zone identifiers (e.g., fe80::1%eth0)
  let working = rawIp.toLowerCase();

  // Convert trailing dotted-quad IPv4 (e.g., ::ffff:127.0.0.1) into two 16-bit hex groups
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const ipv4Tail = working.slice(lastColon + 1);
    const octets = parseIpv4Octets(ipv4Tail);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    working = `${working.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleColonParts = working.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSide = (segment: string): number[] | null => {
    if (segment === '') return [];
    const tokens = segment.split(':');
    const values: number[] = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      values.push(parseInt(token, 16));
    }
    return values;
  };

  if (doubleColonParts.length === 1) {
    const full = parseSide(doubleColonParts[0]!);
    return full && full.length === 8 ? full : null;
  }

  const left = parseSide(doubleColonParts[0]!);
  const right = parseSide(doubleColonParts[1]!);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function hextetsToIpv4(high: number, low: number): [number, number, number, number] {
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

/**
 * Returns true strictly when `ip` is a valid, globally routable public IPv4 or IPv6 address.
 */
export function isPublicIpAddress(ip: string): boolean {
  const trimmed = ip.trim();
  if (!trimmed || trimmed.includes('%')) return false;

  const family = isIP(trimmed);
  if (family === 4) {
    const octets = parseIpv4Octets(trimmed);
    return octets !== null && !isPrivateOrReservedIpv4Octets(octets);
  }

  if (family === 6) {
    const g = parseIpv6Hextets(trimmed);
    if (!g || g.length !== 8) return false;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];

    // Unspecified ::/128 or Loopback ::1/128
    const firstSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
    if (firstSixZero && g6 === 0 && (g7 === 0 || g7 === 1)) {
      return false;
    }

    // IPv4-compatible ::/96 (deprecated)
    if (firstSixZero) {
      return !isPrivateOrReservedIpv4Octets(hextetsToIpv4(g6, g7));
    }

    // IPv4-mapped ::ffff:0:0/96
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      return !isPrivateOrReservedIpv4Octets(hextetsToIpv4(g6, g7));
    }

    // IPv4-translated ::ffff:0:0:0/96
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
      return !isPrivateOrReservedIpv4Octets(hextetsToIpv4(g6, g7));
    }

    // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48
    if (g0 === 0x0064 && g1 === 0xff9b && (g2 === 0 || g2 === 1)) {
      return !isPrivateOrReservedIpv4Octets(hextetsToIpv4(g6, g7));
    }

    // 6to4 2002::/16 embeds IPv4 in groups 1 and 2
    if (g0 === 0x2002) {
      return !isPrivateOrReservedIpv4Octets(hextetsToIpv4(g1, g2));
    }

    // Teredo tunneling 2001:0000::/32
    if (g0 === 0x2001 && g1 === 0x0000) {
      return false;
    }

    // Unique local fc00::/7 (fc00:: - fdff::)
    if ((g0 & 0xfe00) === 0xfc00) return false;

    // Link-local fe80::/10
    if ((g0 & 0xffc0) === 0xfe80) return false;

    // Deprecated site-local fec0::/10
    if ((g0 & 0xffc0) === 0xfec0) return false;

    // Multicast ff00::/8
    if ((g0 & 0xff00) === 0xff00) return false;

    return true;
  }

  return false;
}

/**
 * Throws `SsrfError` if `ip` is private, loopback, link-local, metadata, CGNAT, or invalid.
 */
export function assertPublicIp(ip: string): void {
  if (!isPublicIpAddress(ip)) {
    throw new SsrfError(`Blocked non-public IP address: ${ip}`);
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

function trimTrailingDots(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 46) {
    end -= 1;
  }
  return end === input.length ? input : input.slice(0, end);
}

function validateUrlSyntaxAndHostname(rawUrl: string): { parsed: URL; normalizedHost: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`Blocked URL scheme "${parsed.protocol}" (only http: and https: are allowed)`);
  }

  if (parsed.username || parsed.password) {
    throw new SsrfError('URLs containing embedded credentials are not allowed');
  }

  const rawHost = parsed.hostname.trim().toLowerCase();
  if (!rawHost) {
    throw new SsrfError('URL is missing a hostname');
  }

  if (rawHost.includes('%')) {
    throw new SsrfError(`Blocked IPv6 zone identifier in hostname: ${rawHost}`);
  }

  const unbracketed =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const normalizedHost = trimTrailingDots(unbracketed);

  if (
    !normalizedHost ||
    BLOCKED_HOSTNAMES.has(normalizedHost) ||
    normalizedHost.endsWith('.localhost') ||
    normalizedHost.endsWith('.internal') ||
    normalizedHost.endsWith('.local')
  ) {
    throw new SsrfError(`Blocked restricted hostname: ${parsed.hostname}`);
  }

  if (isIP(normalizedHost) === 0 && /^(?:0x[0-9a-f]+|\d+)$/i.test(normalizedHost)) {
    throw new SsrfError(`Blocked numeric hostname literal: ${normalizedHost}`);
  }

  return { parsed, normalizedHost };
}

/**
 * Validates URL scheme, credentials, hostname rules, and resolves all DNS A/AAAA records
 * to verify every returned IP address is globally public.
 */
export async function assertPublicUrl(rawUrl: string, deps?: SafeFetchDeps): Promise<URL> {
  const { parsed, normalizedHost } = validateUrlSyntaxAndHostname(rawUrl);

  if (isIP(normalizedHost) !== 0) {
    assertPublicIp(normalizedHost);
    return parsed;
  }

  const lookupFn = deps?.lookup ?? customDefaultLookup ?? builtinDnsLookup;
  let records: ResolvedHostAddress[];
  try {
    records = await lookupFn(normalizedHost);
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new SsrfError(`DNS resolution failed for "${normalizedHost}": ${detail}`);
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new SsrfError(`DNS resolution returned no addresses for "${normalizedHost}"`);
  }

  for (const record of records) {
    assertPublicIp(record.address);
  }

  return parsed;
}

/**
 * Creates a socket-level `connect.lookup` hook for `undici.Agent` that resolves all DNS records,
 * verifies every returned IP passes `isPublicIpAddress`, and pins the socket connection directly
 * to the validated IP(s), eliminating DNS-rebinding TOCTOU between URL check and TCP/TLS connect.
 */
export function createSafeConnectLookup(lookupFn: DnsLookupAllFn): LookupFunction {
  return (hostname, opts, callback) => {
    const clean =
      hostname.startsWith('[') && hostname.endsWith(']')
        ? trimTrailingDots(hostname.slice(1, -1))
        : trimTrailingDots(hostname);
    const wantAll = Boolean(opts && typeof opts === 'object' && opts.all);

    const deliverError = (err: Error) => {
      if (wantAll) {
        (callback as (e: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void)(err, []);
      } else {
        callback(err, '', 4);
      }
    };

    if (
      !clean ||
      BLOCKED_HOSTNAMES.has(clean.toLowerCase()) ||
      clean.toLowerCase().endsWith('.localhost') ||
      clean.toLowerCase().endsWith('.internal') ||
      clean.toLowerCase().endsWith('.local')
    ) {
      deliverError(new SsrfError(`Blocked restricted hostname at connect: ${hostname}`));
      return;
    }

    if (isIP(clean) !== 0) {
      if (!isPublicIpAddress(clean)) {
        deliverError(new SsrfError(`Blocked non-public IP address at connect: ${clean}`));
        return;
      }
      const fam = isIP(clean) as 4 | 6;
      if (wantAll) {
        (callback as (e: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void)(null, [
          { address: clean, family: fam },
        ]);
      } else {
        callback(null, clean, fam);
      }
      return;
    }

    lookupFn(clean)
      .then((records) => {
        if (!Array.isArray(records) || records.length === 0) {
          deliverError(new SsrfError(`DNS resolution returned no addresses for "${clean}"`));
          return;
        }
        for (const rec of records) {
          if (!isPublicIpAddress(rec.address)) {
            deliverError(new SsrfError(`Blocked non-public IP address at connect: ${rec.address}`));
            return;
          }
        }

        const rawFamily = typeof opts === 'number' ? opts : opts?.family;
        const requestedFamily =
          rawFamily === 4 || rawFamily === 'IPv4'
            ? 4
            : rawFamily === 6 || rawFamily === 'IPv6'
              ? 6
              : 0;
        const matching =
          requestedFamily === 4 || requestedFamily === 6
            ? records.filter((r) => r.family === requestedFamily)
            : records;
        const selected = matching.length > 0 ? matching : records;

        if (wantAll) {
          (callback as (e: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void)(
            null,
            selected.map((r) => ({ address: r.address, family: r.family })),
          );
        } else {
          const first = selected[0]!;
          callback(null, first.address, first.family);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof SsrfError) {
          deliverError(err);
          return;
        }
        const detail = err instanceof Error ? err.message : String(err);
        deliverError(new SsrfError(`DNS resolution failed for "${clean}": ${detail}`));
      });
  };
}

const defaultPinnedAgent = new Agent({
  connect: {
    lookup: createSafeConnectLookup(builtinDnsLookup),
  },
});

function extractNestedSsrfError(err: unknown, depth = 0): SsrfError | null {
  if (depth > 5 || !err) return null;
  if (err instanceof SsrfError) return err;
  if (err instanceof AggregateError) {
    for (const inner of err.errors) {
      const hit = extractNestedSsrfError(inner, depth + 1);
      if (hit) return hit;
    }
  }
  if (err instanceof Error && 'cause' in err && err.cause) {
    return extractNestedSsrfError(err.cause, depth + 1);
  }
  return null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface StreamReadableResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: {
    get(name: string): string | null;
    forEach(cb: (value: string, key: string) => void): void;
  };
  body: {
    cancel(): Promise<void>;
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
      releaseLock(): void;
    };
  } | null;
}

async function readStreamWithCap(
  response: StreamReadableResponse,
  maxBytes: number,
): Promise<{ text: string; byteLength: number }> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
  }

  if (!response.body) {
    return { text: '', byteLength: 0 };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ResponseTooLargeError(maxBytes);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  return { text: decoder.decode(combined), byteLength: totalBytes };
}

/**
 * Performs an SSRF-validated HTTP fetch with `redirect: 'manual'` and connect-time IP pinning
 * (`undici.Agent` custom `lookup`), re-validating every redirect hop up to `maxRedirects`,
 * enforcing per-request timeouts and a streaming response byte limit.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const injectedFetch = options.deps?.fetchImpl ?? customDefaultFetch;
  const activeLookup = options.deps?.lookup ?? customDefaultLookup;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const scopedAgent =
    !injectedFetch && activeLookup
      ? new Agent({ connect: { lookup: createSafeConnectLookup(activeLookup) } })
      : undefined;

  let currentUrl = rawUrl;
  let method = options.method ?? 'GET';
  let body = options.body;
  const baseHeaders: Record<string, string> = {
    'user-agent': DEFAULT_USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml,application/json,text/plain;q=0.9,*/*;q=0.8',
    ...options.headers,
  };

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const validatedUrl = await assertPublicUrl(currentUrl, options.deps);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

      let response: StreamReadableResponse;
      try {
        if (injectedFetch) {
          response = await injectedFetch(validatedUrl.toString(), {
            method,
            headers: baseHeaders,
            body,
            redirect: 'manual',
            signal,
          });
        } else {
          response = (await undiciFetch(validatedUrl.toString(), {
            method,
            headers: baseHeaders,
            body,
            redirect: 'manual',
            signal,
            dispatcher: scopedAgent ?? defaultPinnedAgent,
          })) as unknown as StreamReadableResponse;
        }
      } catch (err) {
        const ssrfCause = extractNestedSsrfError(err);
        if (ssrfCause) throw ssrfCause;
        throw err;
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) {
          throw new SsrfError(`Redirect status ${response.status} missing Location header from ${validatedUrl.href}`);
        }
        if (hop >= maxRedirects) {
          throw new SsrfError(`Exceeded maximum redirects (${maxRedirects}) starting from ${rawUrl}`);
        }

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, validatedUrl);
        } catch {
          throw new SsrfError(`Invalid redirect Location "${location}"`);
        }

        if (nextUrl.origin !== validatedUrl.origin) {
          delete baseHeaders['authorization'];
          delete baseHeaders['cookie'];
          delete baseHeaders['proxy-authorization'];
        }

        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          delete baseHeaders['content-type'];
        }

        currentUrl = nextUrl.toString();
        continue;
      }

      const { text, byteLength } = await readStreamWithCap(response, maxBytes);
      const plainHeaders: Record<string, string> = {};
      response.headers.forEach((val, key) => {
        plainHeaders[key.toLowerCase()] = val;
      });

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        finalUrl: validatedUrl.toString(),
        redirectCount: hop,
        contentType: plainHeaders['content-type'] ?? '',
        headers: plainHeaders,
        text,
        byteLength,
      };
    }
  } finally {
    if (scopedAgent) {
      await scopedAgent.close().catch(() => undefined);
    }
  }

  throw new SsrfError(`Exceeded maximum redirects (${maxRedirects})`);
}

/**
 * Convenience wrapper around `safeFetch` that parses JSON and throws on non-2xx status codes.
 */
export async function safeFetchJson<T>(rawUrl: string, options: SafeFetchOptions = {}): Promise<T> {
  const res = await safeFetch(rawUrl, {
    ...options,
    headers: {
      accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      ...options.headers,
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${res.finalUrl}`);
  }

  try {
    return JSON.parse(res.text) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON response from ${res.finalUrl}: ${detail}`);
  }
}
