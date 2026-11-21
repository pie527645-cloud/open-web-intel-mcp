import {
  decodeEntities,
  extractFirstTagInner,
  MAX_HTML_INPUT_CHARS,
  replaceTagBlocks,
  stripHtmlComments,
  stripMarkupTagsLinear,
  stripTagBlocks,
} from './xml.js';

export { MAX_HTML_INPUT_CHARS };

/** Result of converting an HTML or text document into clean Markdown. */
export interface MarkdownConversionResult {
  title: string;
  description?: string;
  canonicalUrl?: string;
  markdown: string;
  truncated: boolean;
  approxTokens: number;
}

function extractAttr(attrs: string, name: string): string | undefined {
  const regex = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = regex.exec(attrs);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw !== undefined ? decodeEntities(raw).trim() : undefined;
}

function resolveHref(rawHref: string | undefined, baseUrl: string): string | undefined {
  if (!rawHref) return undefined;
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(?:javascript|vbscript|data):/i.test(trimmed)) {
    return undefined;
  }
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function scanVoidOrOpenTags(
  html: string,
  tagName: string,
  visitor: (attrs: string) => void,
): void {
  const tagLower = tagName.toLowerCase();
  const needle = `<${tagLower}`;
  const lower = html.toLowerCase();
  let cursor = 0;

  while (cursor < html.length) {
    const idx = lower.indexOf(needle, cursor);
    if (idx === -1) break;
    const afterName = idx + needle.length;
    const code = html.charCodeAt(afterName);
    if (code !== 62 && code !== 47 && code !== 32 && code !== 9 && code !== 10 && code !== 13) {
      cursor = afterName;
      continue;
    }
    const gt = html.indexOf('>', afterName);
    if (gt === -1) break;
    visitor(html.slice(afterName, gt));
    cursor = gt + 1;
  }
}

function replaceVoidOrOpenTags(
  html: string,
  tagName: string,
  replacer: (attrs: string) => string,
): string {
  const tagLower = tagName.toLowerCase();
  const needle = `<${tagLower}`;
  const lower = html.toLowerCase();
  let first = lower.indexOf(needle);
  if (first === -1) return html;

  const out: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const idx = first !== -1 ? first : lower.indexOf(needle, cursor);
    first = -1;
    if (idx === -1) {
      out.push(html.slice(cursor));
      break;
    }
    const afterName = idx + needle.length;
    const code = html.charCodeAt(afterName);
    if (code !== 62 && code !== 47 && code !== 32 && code !== 9 && code !== 10 && code !== 13) {
      out.push(html.slice(cursor, afterName));
      cursor = afterName;
      continue;
    }
    const gt = html.indexOf('>', afterName);
    if (gt === -1) {
      out.push(html.slice(cursor));
      break;
    }
    out.push(html.slice(cursor, idx));
    out.push(replacer(html.slice(afterName, gt)));
    cursor = gt + 1;
  }
  return out.join('');
}

function extractMetaContent(html: string, names: string[]): string | undefined {
  const targets = new Set(names.map((n) => n.toLowerCase()));
  let found: string | undefined;

  scanVoidOrOpenTags(html, 'meta', (attrs) => {
    if (found !== undefined) return;
    const key = (extractAttr(attrs, 'name') ?? extractAttr(attrs, 'property') ?? '').toLowerCase();
    if (targets.has(key)) {
      const content = extractAttr(attrs, 'content');
      if (content) found = content;
    }
  });

  return found;
}

function extractCanonicalUrl(html: string, baseUrl: string): string | undefined {
  let canonical: string | undefined;
  scanVoidOrOpenTags(html, 'link', (attrs) => {
    if (canonical !== undefined) return;
    const rel = (extractAttr(attrs, 'rel') ?? '').toLowerCase();
    if (rel.split(/\s+/).includes('canonical')) {
      canonical = resolveHref(extractAttr(attrs, 'href'), baseUrl);
    }
  });
  return canonical;
}

function stripInlineTags(fragment: string): string {
  return decodeEntities(stripMarkupTagsLinear(fragment, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function pickPrimaryContentRegion(cleanedHtml: string): string {
  const mainInner = extractFirstTagInner(cleanedHtml, 'main');
  if (mainInner && stripInlineTags(mainInner).length >= 120) {
    return mainInner;
  }

  const articleInner = extractFirstTagInner(cleanedHtml, 'article');
  if (articleInner && stripInlineTags(articleInner).length >= 120) {
    return articleInner;
  }

  const bodyInner = extractFirstTagInner(cleanedHtml, 'body') ?? cleanedHtml;
  return stripTagBlocks(bodyInner, ['nav', 'footer', 'aside', 'header'], {
    replacement: '\n',
  });
}

/**
 * Estimates LLM token usage (~4 characters per token heuristic).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Converts HTML (hard-capped to 512 KiB) into token-lean Markdown in O(n) time without DOM dependencies.
 */
export function convertHtmlToMarkdown(
  rawHtml: string,
  baseUrl: string,
  maxChars = 30_000,
): MarkdownConversionResult {
  const boundedHtml =
    rawHtml.length > MAX_HTML_INPUT_CHARS ? rawHtml.slice(0, MAX_HTML_INPUT_CHARS) : rawHtml;

  const rawTitleInner = extractFirstTagInner(boundedHtml, 'title');
  const metaTitle = extractMetaContent(boundedHtml, ['og:title', 'twitter:title']);
  const description = extractMetaContent(boundedHtml, [
    'description',
    'og:description',
    'twitter:description',
  ]);
  const canonicalUrl = extractCanonicalUrl(boundedHtml, baseUrl);

  const withoutComments = stripHtmlComments(boundedHtml);
  const stripped = stripTagBlocks(
    withoutComments,
    [
      'script',
      'style',
      'noscript',
      'template',
      'svg',
      'canvas',
      'iframe',
      'form',
      'button',
      'select',
      'option',
    ],
    { replacement: '\n', stripUnclosedToEnd: true },
  );

  let work = pickPrimaryContentRegion(stripped);

  // Preserve fenced <pre> blocks via placeholders
  const codeBlocks: string[] = [];
  work = replaceTagBlocks(work, 'pre', (preAttrs, inner) => {
    const langSource = `${preAttrs} ${inner.slice(0, 200)}`;
    const langMatch = /language-([a-zA-Z0-9_+-]+)/i.exec(langSource);
    const lang = langMatch?.[1] ?? '';
    const codeText = decodeEntities(stripMarkupTagsLinear(inner, ''))
      .replace(/\r\n?/g, '\n')
      .trim();
    const index = codeBlocks.length;
    codeBlocks.push(`\n\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`);
    return `@@CODEBLOCK_${index}@@`;
  });

  // Inline <code>
  work = replaceTagBlocks(work, 'code', (_attrs, inner) => {
    const clean = stripInlineTags(inner).replace(/`/g, "'");
    return clean ? `\`${clean}\`` : '';
  });

  // Images with alt text
  work = replaceVoidOrOpenTags(work, 'img', (attrs) => {
    const alt = extractAttr(attrs, 'alt');
    const src = resolveHref(extractAttr(attrs, 'src'), baseUrl);
    if (!alt || !src) return '';
    return `![${alt.replace(/[[\]]/g, '')}](${src})`;
  });

  // Links
  work = replaceTagBlocks(work, 'a', (attrs, inner) => {
    const label = stripInlineTags(inner);
    if (!label) return '';
    const href = resolveHref(extractAttr(attrs, 'href'), baseUrl);
    if (!href) return label;
    return `[${label}](${href})`;
  });

  // Headings h1..h6
  for (let level = 1; level <= 6; level += 1) {
    const hashes = '#'.repeat(level);
    work = replaceTagBlocks(work, `h${level}`, (_attrs, inner) => {
      const text = stripInlineTags(inner);
      return text ? `\n\n${hashes} ${text}\n\n` : '\n';
    });
  }

  // Strong & emphasis
  for (const strongTag of ['strong', 'b']) {
    work = replaceTagBlocks(work, strongTag, (_attrs, inner) => {
      const text = stripInlineTags(inner);
      return text ? `**${text}**` : '';
    });
  }
  for (const emTag of ['em', 'i']) {
    work = replaceTagBlocks(work, emTag, (_attrs, inner) => {
      const text = stripInlineTags(inner);
      return text ? `*${text}*` : '';
    });
  }

  // Blockquotes
  work = replaceTagBlocks(work, 'blockquote', (_attrs, inner) => {
    const text = stripInlineTags(inner);
    return text ? `\n\n> ${text}\n\n` : '\n';
  });

  // Ordered lists & list items
  work = replaceTagBlocks(work, 'ol', (_attrs, inner) => {
    let idx = 0;
    const items = replaceTagBlocks(inner, 'li', (_liAttrs, liInner) => {
      const itemText = stripInlineTags(liInner);
      if (!itemText) return '';
      idx += 1;
      return `\n${idx}. ${itemText}`;
    });
    return `\n${items}\n\n`;
  });
  work = replaceTagBlocks(work, 'li', (_attrs, inner) => {
    const itemText = stripInlineTags(inner);
    return itemText ? `\n- ${itemText}` : '';
  });

  // Table rows
  work = replaceTagBlocks(work, 'tr', (_attrs, rowInner) => {
    const cells: string[] = [];
    const collectCell = (_cAttrs: string, cInner: string) => {
      cells.push(stripInlineTags(cInner).replace(/\|/g, '\\|'));
      return '';
    };
    replaceTagBlocks(rowInner, 'th', collectCell);
    replaceTagBlocks(rowInner, 'td', collectCell);
    return cells.length > 0 ? `\n| ${cells.join(' | ')} |` : '';
  });

  // Structural breaks & remaining tags
  work = replaceVoidOrOpenTags(work, 'hr', () => '\n\n---\n\n');
  work = replaceVoidOrOpenTags(work, 'br', () => '\n');
  work = work.replace(/<\/(?:p|div|section|article|ul|table|dl|dd|dt|figure|figcaption)>/gi, '\n\n');
  work = stripMarkupTagsLinear(work, ' ');

  work = decodeEntities(work)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ \n/g, '\n')
    .replace(/\n /g, '\n');

  // Restore code blocks
  work = work.replace(/@@CODEBLOCK_(\d+)@@/g, (_m, idxStr: string) => {
    return codeBlocks[Number(idxStr)] ?? '';
  });

  let markdown = work.replace(/\n{3,}/g, '\n\n').trim();

  const headingMatch = /^#{1,3}\s+(.+)$/m.exec(markdown);
  const title =
    (rawTitleInner ? stripInlineTags(rawTitleInner) : '') ||
    metaTitle ||
    headingMatch?.[1]?.trim() ||
    baseUrl;

  let truncated = false;
  if (markdown.length > maxChars) {
    markdown = `${markdown.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
    truncated = true;
  }

  return {
    title,
    description,
    canonicalUrl,
    markdown,
    truncated,
    approxTokens: estimateTokens(markdown),
  };
}
