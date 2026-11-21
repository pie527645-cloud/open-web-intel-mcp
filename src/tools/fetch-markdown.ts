import {
  convertHtmlToMarkdown,
  estimateTokens,
  MAX_HTML_INPUT_CHARS,
} from '../lib/html-to-markdown.js';
import { safeFetch, type SafeFetchDeps } from '../lib/safe-fetch.js';

/** Input options for `fetchMarkdown`. */
export interface FetchMarkdownInput {
  url: string;
  includeLlmsTxt?: boolean;
  maxChars?: number;
  timeoutMs?: number;
  deps?: SafeFetchDeps;
}

/** Structured result returned by `fetchMarkdown`. */
export interface FetchMarkdownResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  description?: string;
  canonicalUrl?: string;
  markdown: string;
  truncated: boolean;
  approxTokens: number;
  llmsTxt?: {
    found: boolean;
    url: string;
    content?: string;
  };
}

function looksLikeHtml(text: string, contentType: string): boolean {
  if (contentType.includes('html') || contentType.includes('xhtml')) return true;
  return /^\s*<(?:!doctype\s+html|html|head|body|main|article)\b/i.test(text);
}

async function probeLlmsTxt(
  finalUrl: string,
  timeoutMs: number,
  deps?: SafeFetchDeps,
): Promise<{ found: boolean; url: string; content?: string }> {
  const origin = new URL(finalUrl).origin;
  const llmsUrl = `${origin}/llms.txt`;
  try {
    const res = await safeFetch(llmsUrl, {
      timeoutMs: Math.min(timeoutMs, 8_000),
      maxBytes: 256 * 1024,
      deps,
    });
    if (!res.ok || looksLikeHtml(res.text, res.contentType)) {
      return { found: false, url: llmsUrl };
    }
    const trimmed = res.text.trim();
    if (!trimmed) {
      return { found: false, url: llmsUrl };
    }
    const content = trimmed.length > 8_000 ? `${trimmed.slice(0, 7_999)}…` : trimmed;
    return { found: true, url: res.finalUrl, content };
  } catch {
    return { found: false, url: llmsUrl };
  }
}

/**
 * Fetches a public URL via SSRF-safe HTTP, strips script/style/navigation chrome,
 * and returns clean Markdown with token estimates and optional `llms.txt` discovery.
 */
export async function fetchMarkdown(input: FetchMarkdownInput): Promise<FetchMarkdownResult> {
  const maxChars = input.maxChars ?? 30_000;
  const timeoutMs = input.timeoutMs ?? 15_000;

  const res = await safeFetch(input.url, {
    timeoutMs,
    maxBytes: 2 * 1024 * 1024,
    deps: input.deps,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${res.finalUrl}`);
  }

  let title = res.finalUrl;
  let description: string | undefined;
  let canonicalUrl: string | undefined;
  let markdown: string;
  let truncated = false;

  if (looksLikeHtml(res.text, res.contentType)) {
    const htmlBounded =
      res.text.length > MAX_HTML_INPUT_CHARS
        ? res.text.slice(0, MAX_HTML_INPUT_CHARS)
        : res.text;
    const converted = convertHtmlToMarkdown(htmlBounded, res.finalUrl, maxChars);
    title = converted.title;
    description = converted.description;
    canonicalUrl = converted.canonicalUrl;
    markdown = converted.markdown;
    truncated = converted.truncated;
  } else if (res.contentType.includes('json')) {
    let formatted = res.text.trim();
    try {
      formatted = JSON.stringify(JSON.parse(formatted), null, 2);
    } catch {
      // Keep raw text if malformed JSON
    }
    const wrapped = `\`\`\`json\n${formatted}\n\`\`\``;
    if (wrapped.length > maxChars) {
      markdown = `${wrapped.slice(0, Math.max(0, maxChars - 5))}\n\`\`\`\n…`;
      truncated = true;
    } else {
      markdown = wrapped;
    }
  } else {
    const normalized = res.text.replace(/\r\n?/g, '\n').trim();
    const heading = /^#\s+(.+)$/m.exec(normalized);
    if (heading?.[1]) {
      title = heading[1].trim();
    }
    if (normalized.length > maxChars) {
      markdown = `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
      truncated = true;
    } else {
      markdown = normalized;
    }
  }

  const llmsTxt = input.includeLlmsTxt
    ? await probeLlmsTxt(res.finalUrl, timeoutMs, input.deps)
    : undefined;

  return {
    url: input.url,
    finalUrl: res.finalUrl,
    status: res.status,
    contentType: res.contentType,
    title,
    description,
    canonicalUrl,
    markdown,
    truncated,
    approxTokens: estimateTokens(markdown),
    ...(llmsTxt ? { llmsTxt } : {}),
  };
}
