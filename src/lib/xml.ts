/** Maximum HTML character length processed by text/markdown extractors (512 KiB). */
export const MAX_HTML_INPUT_CHARS = 512 * 1024;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  rarr: '->',
  larr: '<-',
};

function isTagNameBoundaryCode(code: number | undefined): boolean {
  return (
    code === 62 || // >
    code === 47 || // /
    code === 32 || // space
    code === 9 || // \t
    code === 10 || // \n
    code === 13 || // \r
    code === 12 // \f
  );
}

function findMatchingCloseTag(
  raw: string,
  lower: string,
  tagLower: string,
  fromIndex: number,
): { closeStart: number; closeEnd: number } | null {
  const needle = `</${tagLower}`;
  let searchPos = fromIndex;

  while (searchPos < raw.length) {
    const idx = lower.indexOf(needle, searchPos);
    if (idx === -1) return null;

    const afterName = idx + needle.length;
    if (afterName >= raw.length) return null;

    const code = raw.charCodeAt(afterName);
    if (code === 62) {
      return { closeStart: idx, closeEnd: afterName + 1 };
    }
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 12) {
      const gt = raw.indexOf('>', afterName + 1);
      if (gt === -1) return null;
      return { closeStart: idx, closeEnd: gt + 1 };
    }

    searchPos = afterName;
  }

  return null;
}

/**
 * Linear O(n) paired-tag replacer using `indexOf` (immune to unclosed-tag quadratic backtracking).
 */
export function replaceTagBlocks(
  raw: string,
  tagName: string,
  replacer: (attrs: string, inner: string) => string,
  options: { stripUnclosedToEnd?: boolean } = {},
): string {
  if (!raw) return '';
  const tagLower = tagName.toLowerCase();
  const openNeedle = `<${tagLower}`;
  const lower = raw.toLowerCase();

  let firstCheck = lower.indexOf(openNeedle);
  if (firstCheck === -1) return raw;
  if (!options.stripUnclosedToEnd && lower.indexOf(`</${tagLower}`, firstCheck + openNeedle.length) === -1 && !raw.includes('/>')) {
    return raw;
  }

  const out: string[] = [];
  let emitCursor = 0;
  let scanCursor = firstCheck;

  while (scanCursor < raw.length) {
    const openIdx = firstCheck !== -1 ? firstCheck : lower.indexOf(openNeedle, scanCursor);
    firstCheck = -1;
    if (openIdx === -1) {
      break;
    }

    const afterOpenName = openIdx + openNeedle.length;
    if (!isTagNameBoundaryCode(raw.charCodeAt(afterOpenName))) {
      scanCursor = afterOpenName;
      continue;
    }

    const openGt = raw.indexOf('>', afterOpenName);
    if (openGt === -1) {
      if (options.stripUnclosedToEnd) {
        out.push(raw.slice(emitCursor, openIdx));
        emitCursor = raw.length;
      }
      break;
    }

    // Self-closing <tag ... />
    if (raw.charCodeAt(openGt - 1) === 47) {
      out.push(raw.slice(emitCursor, openIdx));
      const attrs = raw.slice(afterOpenName, openGt - 1).trim();
      out.push(replacer(attrs, ''));
      emitCursor = openGt + 1;
      scanCursor = openGt + 1;
      continue;
    }

    const closeMatch = findMatchingCloseTag(raw, lower, tagLower, openGt + 1);
    if (!closeMatch) {
      if (options.stripUnclosedToEnd) {
        out.push(raw.slice(emitCursor, openIdx));
        emitCursor = raw.length;
      }
      break;
    }

    out.push(raw.slice(emitCursor, openIdx));
    const attrs = raw.slice(afterOpenName, openGt).trim();
    const inner = raw.slice(openGt + 1, closeMatch.closeStart);
    out.push(replacer(attrs, inner));
    emitCursor = closeMatch.closeEnd;
    scanCursor = closeMatch.closeEnd;
  }

  if (emitCursor === 0) return raw;
  if (emitCursor < raw.length) {
    out.push(raw.slice(emitCursor));
  }
  return out.join('');
}

/**
 * Linear O(n) removal of paired elements (such as `script`, `style`, `nav`, `footer`).
 */
export function stripTagBlocks(
  raw: string,
  tagNames: readonly string[],
  options: { replacement?: string; stripUnclosedToEnd?: boolean } = {},
): string {
  const rep = options.replacement ?? '\n';
  let current = raw;
  for (const tag of tagNames) {
    current = replaceTagBlocks(current, tag, () => rep, {
      stripUnclosedToEnd: options.stripUnclosedToEnd,
    });
  }
  return current;
}

/**
 * Linear O(n) removal of HTML/XML `<!-- ... -->` comments.
 */
export function stripHtmlComments(raw: string): string {
  if (!raw) return '';
  let openIdx = raw.indexOf('<!--');
  if (openIdx === -1) return raw;

  const out: string[] = [];
  let cursor = 0;
  while (openIdx !== -1) {
    out.push(raw.slice(cursor, openIdx));
    const closeIdx = raw.indexOf('-->', openIdx + 4);
    if (closeIdx === -1) {
      break;
    }
    cursor = closeIdx + 3;
    openIdx = raw.indexOf('<!--', cursor);
  }
  if (openIdx === -1 && cursor < raw.length) {
    out.push(raw.slice(cursor));
  }
  return out.join('');
}

/**
 * Strips remaining `<...>` markup tags in O(n) time without backtracking regexes.
 */
export function stripMarkupTagsLinear(raw: string, replacement = ' '): string {
  if (!raw || !raw.includes('<')) return raw;
  const out: string[] = [];
  let cursor = 0;

  while (cursor < raw.length) {
    const lt = raw.indexOf('<', cursor);
    if (lt === -1) {
      out.push(raw.slice(cursor));
      break;
    }
    const nextChar = raw.charCodeAt(lt + 1);
    const looksLikeTag =
      nextChar === 47 || // /
      nextChar === 33 || // !
      nextChar === 63 || // ?
      (nextChar >= 65 && nextChar <= 90) || // A-Z
      (nextChar >= 97 && nextChar <= 122); // a-z

    if (!looksLikeTag) {
      out.push(raw.slice(cursor, lt + 1));
      cursor = lt + 1;
      continue;
    }

    const gt = raw.indexOf('>', lt + 1);
    if (gt === -1) {
      out.push(raw.slice(cursor));
      break;
    }
    out.push(raw.slice(cursor, lt));
    out.push(replacement);
    cursor = gt + 1;
  }

  return out.join('');
}

/**
 * Decodes HTML and XML character entities (named, decimal, and hex) into UTF-8 text.
 */
export function decodeEntities(input: string): string {
  if (!input || !input.includes('&')) return input;
  return input.replace(
    /&(#x[0-9a-fA-F]{1,8}|#\d{1,8}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const codePoint = parseInt(entity.slice(2), 16);
        if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
          try {
            return String.fromCodePoint(codePoint);
          } catch {
            return match;
          }
        }
        return match;
      }
      if (entity.startsWith('#')) {
        const codePoint = parseInt(entity.slice(1), 10);
        if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
          try {
            return String.fromCodePoint(codePoint);
          } catch {
            return match;
          }
        }
        return match;
      }
      const replacement = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()];
      return replacement ?? match;
    },
  );
}

/**
 * Unwraps XML `<![CDATA[...]]>` sections in O(n) time and trims surrounding whitespace.
 */
export function unwrapCdata(raw: string): string {
  if (!raw) return '';
  let openIdx = raw.indexOf('<![CDATA[');
  if (openIdx === -1) return raw.trim();

  const out: string[] = [];
  let cursor = 0;
  while (openIdx !== -1) {
    out.push(raw.slice(cursor, openIdx));
    const closeIdx = raw.indexOf(']]>', openIdx + 9);
    if (closeIdx === -1) {
      out.push(raw.slice(openIdx + 9));
      cursor = raw.length;
      break;
    }
    out.push(raw.slice(openIdx + 9, closeIdx));
    cursor = closeIdx + 3;
    openIdx = raw.indexOf('<![CDATA[', cursor);
  }
  if (cursor < raw.length) {
    out.push(raw.slice(cursor));
  }
  return out.join('').trim();
}

/**
 * Extracts the raw inner markup of the first matching XML/HTML tag in O(n) time.
 */
export function extractFirstTagInner(xml: string, tagName: string): string | undefined {
  if (!xml) return undefined;
  const tagLower = tagName.toLowerCase();
  const openNeedle = `<${tagLower}`;
  const lower = xml.toLowerCase();

  let searchPos = 0;
  while (searchPos < xml.length) {
    const openIdx = lower.indexOf(openNeedle, searchPos);
    if (openIdx === -1) return undefined;

    const afterName = openIdx + openNeedle.length;
    if (!isTagNameBoundaryCode(xml.charCodeAt(afterName))) {
      searchPos = afterName;
      continue;
    }

    const openGt = xml.indexOf('>', afterName);
    if (openGt === -1) return undefined;
    if (xml.charCodeAt(openGt - 1) === 47) {
      searchPos = openGt + 1;
      continue;
    }

    const closeMatch = findMatchingCloseTag(xml, lower, tagLower, openGt + 1);
    if (!closeMatch) return undefined;
    return xml.slice(openGt + 1, closeMatch.closeStart);
  }

  return undefined;
}

/**
 * Extracts the decoded inner content of the first matching XML tag in O(n) time.
 */
export function extractXmlTag(xml: string, tagName: string): string | undefined {
  const inner = extractFirstTagInner(xml, tagName);
  if (inner === undefined) return undefined;
  return decodeEntities(unwrapCdata(inner)).trim();
}

/**
 * Extracts all raw inner blocks of a repeating XML element in strictly O(n) time.
 */
export function extractAllXmlBlocks(xml: string, tagName: string): string[] {
  if (!xml) return [];
  const tagLower = tagName.toLowerCase();
  const openNeedle = `<${tagLower}`;
  const lower = xml.toLowerCase();
  const blocks: string[] = [];

  let cursor = 0;
  while (cursor < xml.length) {
    const openIdx = lower.indexOf(openNeedle, cursor);
    if (openIdx === -1) break;

    const afterName = openIdx + openNeedle.length;
    if (!isTagNameBoundaryCode(xml.charCodeAt(afterName))) {
      cursor = afterName;
      continue;
    }

    const openGt = xml.indexOf('>', afterName);
    if (openGt === -1) break;

    if (xml.charCodeAt(openGt - 1) === 47) {
      cursor = openGt + 1;
      continue;
    }

    const closeMatch = findMatchingCloseTag(xml, lower, tagLower, openGt + 1);
    if (!closeMatch) {
      // No closing </tagName> exists anywhere in the remainder of `xml` -> O(n) early exit
      break;
    }

    blocks.push(xml.slice(openGt + 1, closeMatch.closeStart));
    cursor = closeMatch.closeEnd;
  }

  return blocks;
}

/**
 * Extracts all attribute values for a given XML/HTML tag and attribute name in O(n) time.
 */
export function extractXmlAttributes(xml: string, tagName: string, attrName: string): string[] {
  if (!xml) return [];
  const tagLower = tagName.toLowerCase();
  const openNeedle = `<${tagLower}`;
  const lower = xml.toLowerCase();
  const escapedAttr = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attrRegex = new RegExp(`\\b${escapedAttr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');

  const values: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const openIdx = lower.indexOf(openNeedle, cursor);
    if (openIdx === -1) break;

    const afterName = openIdx + openNeedle.length;
    if (!isTagNameBoundaryCode(xml.charCodeAt(afterName))) {
      cursor = afterName;
      continue;
    }

    const openGt = xml.indexOf('>', afterName);
    if (openGt === -1) break;

    const attrs = xml.slice(afterName, openGt);
    const attrMatch = attrRegex.exec(attrs);
    const rawVal = attrMatch?.[1] ?? attrMatch?.[2];
    if (rawVal !== undefined) {
      values.push(decodeEntities(rawVal).trim());
    }

    cursor = openGt + 1;
  }

  return values;
}

/**
 * Converts HTML (including double-escaped ATS descriptions like Greenhouse) to clean plain text in O(n) time.
 */
export function htmlToPlainText(rawHtml: string, maxChars?: number): string {
  if (!rawHtml) return '';
  const capped =
    rawHtml.length > MAX_HTML_INPUT_CHARS ? rawHtml.slice(0, MAX_HTML_INPUT_CHARS) : rawHtml;
  let working = unwrapCdata(capped);

  // Greenhouse and several XML feeds double-escape HTML tags (&lt;p&gt; or &amp;lt;p&amp;gt;)
  for (let pass = 0; pass < 2; pass += 1) {
    if (/&(?:lt|gt|quot|amp|#60|#62|#x3c|#x3e);/i.test(working)) {
      working = decodeEntities(working);
    }
  }

  working = stripHtmlComments(working);
  working = stripTagBlocks(working, ['script', 'style', 'noscript', 'svg', 'template'], {
    replacement: ' ',
    stripUnclosedToEnd: true,
  });

  working = working
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<li(?:\s[^>]*)?>/gi, '- ');

  working = stripMarkupTagsLinear(working, ' ');

  working = decodeEntities(working)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ \n/g, '\n')
    .replace(/\n /g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (maxChars !== undefined && working.length > maxChars) {
    return `${working.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }
  return working;
}
