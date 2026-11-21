import { assertPublicUrl, safeFetch, type SafeFetchDeps } from '../lib/safe-fetch.js';
import {
  decodeEntities,
  extractFirstTagInner,
  MAX_HTML_INPUT_CHARS,
  stripMarkupTagsLinear,
} from '../lib/xml.js';

/** Detected ecommerce storefront platform. */
export type EcommercePlatform =
  | 'shopify'
  | 'woocommerce'
  | 'bigcommerce'
  | 'magento'
  | 'squarespace'
  | 'wix'
  | 'prestashop'
  | 'custom-or-unknown';

/** Normalized storefront product sample. */
export interface EcommerceProductSample {
  id: string;
  title: string;
  handle?: string;
  url: string;
  vendor?: string;
  productType?: string;
  priceMin?: number;
  priceMax?: number;
  currency?: string;
  available: boolean;
  tags: string[];
  publishedAt?: string;
}

/** Input options for `inspectEcommerceStore`. */
export interface InspectEcommerceStoreInput {
  url: string;
  maxProducts?: number;
  timeoutMs?: number;
  deps?: SafeFetchDeps;
}

/** Structured storefront intelligence returned by `inspectEcommerceStore`. */
export interface InspectEcommerceStoreResult {
  storeUrl: string;
  origin: string;
  platform: EcommercePlatform;
  storeMeta: {
    name?: string;
    myshopifyDomain?: string;
    country?: string;
    currency?: string;
    description?: string;
  };
  endpoints: {
    shopifyProductsJson: boolean;
    shopifyMetaJson: boolean;
    wooStoreApi: boolean;
  };
  techSignals: string[];
  priceSummary: {
    productSampleCount: number;
    minPrice?: number;
    maxPrice?: number;
    currency?: string;
  };
  products: EcommerceProductSample[];
}

interface ShopifyMetaJson {
  name?: string;
  domain?: string;
  myshopify_domain?: string;
  country?: string;
  currency?: string;
  description?: string;
}

interface ShopifyProductsPayload {
  products?: Array<{
    id?: number | string;
    title?: string;
    handle?: string;
    vendor?: string;
    product_type?: string;
    published_at?: string;
    tags?: string[] | string;
    variants?: Array<{
      price?: string | number;
      available?: boolean;
    }>;
  }>;
}

interface WooProductRaw {
  id?: number | string;
  name?: string;
  slug?: string;
  permalink?: string;
  is_in_stock?: boolean;
  prices?: {
    price?: string;
    regular_price?: string;
    currency_code?: string;
    currency_minor_unit?: number;
  };
  categories?: Array<{ name?: string }>;
  tags?: Array<{ name?: string }>;
}

const ECOMMERCE_SIGNAL_PATTERNS: Array<[string, RegExp]> = [
  ['shopify-cdn', /cdn\.shopify\.com/i],
  ['klaviyo', /klaviyo\.com|learnq/i],
  ['judgeme', /judge\.me|jdgm/i],
  ['yotpo', /yotpo\.com/i],
  ['loox', /loox\.io/i],
  ['okendo', /okendo\.io/i],
  ['gorgias', /gorgias\.chat|gorgias\.io/i],
  ['zendesk', /zdassets\.com|zendesk/i],
  ['intercom', /widget\.intercom\.io/i],
  ['recharge', /rechargepayments\.com|rechargecdn/i],
  ['loop-returns', /loopreturns\.com/i],
  ['attentive', /attn\.tv/i],
  ['postscript', /postscript\.io/i],
  ['stripe', /js\.stripe\.com/i],
  ['paypal', /paypalobjects\.com|paypal\.com\/sdk/i],
  ['klarna', /klarna\.com/i],
  ['afterpay', /afterpay\.com|static\.afterpay/i],
  ['affirm', /affirm\.com/i],
  ['shop-pay', /shopify-payment-button|shop_pay/i],
  ['google-tag-manager', /googletagmanager\.com/i],
  ['meta-pixel', /connect\.facebook\.net\/.*\/fbevents\.js/i],
  ['tiktok-pixel', /analytics\.tiktok\.com/i],
  ['pinterest-tag', /pintrk|ct\.pinterest\.com/i],
  ['hotjar', /static\.hotjar\.com/i],
];

function detectPlatformFromHtml(html: string, headers: Record<string, string>): EcommercePlatform {
  const poweredBy = `${headers['x-shopid'] ?? ''} ${headers['x-shopify-stage'] ?? ''} ${headers['powered-by'] ?? ''}`;
  if (/shopify/i.test(poweredBy) || /Shopify\.shop\s*=|cdn\.shopify\.com/i.test(html)) {
    return 'shopify';
  }
  if (/wp-content\/plugins\/woocommerce|class=["'][^"']*woocommerce/i.test(html)) {
    return 'woocommerce';
  }
  if (/cdn\d*\.bigcommerce\.com|stencil-utils/i.test(html)) {
    return 'bigcommerce';
  }
  if (/Mage\.Cookies|text\/x-magento-init/i.test(html)) {
    return 'magento';
  }
  if (/Static\.SQUARESPACE_CONTEXT/i.test(html)) {
    return 'squarespace';
  }
  if (/wix-ecommerce|static\.parastorage\.com/i.test(html)) {
    return 'wix';
  }
  if (/prestashop/i.test(html)) {
    return 'prestashop';
  }
  return 'custom-or-unknown';
}

function extractHtmlTitle(html: string): string | undefined {
  const inner = extractFirstTagInner(html, 'title');
  if (!inner) return undefined;
  return decodeEntities(stripMarkupTagsLinear(inner, ' ')).replace(/\s+/g, ' ').trim() || undefined;
}

function extractShopifyInlineVars(html: string): { myshopifyDomain?: string; currency?: string; country?: string } {
  const shopMatch = /Shopify\.shop\s*=\s*["']([^"']+)["']/i.exec(html);
  const currencyMatch = /Shopify\.currency\s*=\s*\{\s*["']active["']\s*:\s*["']([A-Z]{3})["']/i.exec(html);
  const countryMatch = /Shopify\.country\s*=\s*["']([A-Z]{2})["']/i.exec(html);
  return {
    ...(shopMatch?.[1] ? { myshopifyDomain: shopMatch[1] } : {}),
    ...(currencyMatch?.[1] ? { currency: currencyMatch[1] } : {}),
    ...(countryMatch?.[1] ? { country: countryMatch[1] } : {}),
  };
}

function normalizeShopifyProducts(
  payload: ShopifyProductsPayload,
  origin: string,
  currency?: string,
  maxProducts = 15,
): EcommerceProductSample[] {
  return (payload.products ?? []).slice(0, maxProducts).map((p) => {
    const prices = (p.variants ?? [])
      .map((v) => Number(v.price))
      .filter((n) => Number.isFinite(n) && n >= 0);
    const priceMin = prices.length > 0 ? Math.min(...prices) : undefined;
    const priceMax = prices.length > 0 ? Math.max(...prices) : undefined;
    const available = (p.variants ?? []).some((v) => v.available === true);
    const tags = Array.isArray(p.tags)
      ? p.tags.map((t) => String(t).trim()).filter(Boolean)
      : typeof p.tags === 'string'
        ? p.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
    const handle = p.handle ?? '';

    return {
      id: String(p.id ?? handle),
      title: p.title?.trim() || 'Untitled Product',
      ...(handle ? { handle } : {}),
      url: handle ? `${origin}/products/${handle}` : origin,
      ...(p.vendor ? { vendor: p.vendor } : {}),
      ...(p.product_type ? { productType: p.product_type } : {}),
      ...(priceMin !== undefined ? { priceMin } : {}),
      ...(priceMax !== undefined ? { priceMax } : {}),
      ...(currency ? { currency } : {}),
      available,
      tags: tags.slice(0, 12),
      ...(p.published_at ? { publishedAt: p.published_at } : {}),
    };
  });
}

function normalizeWooProducts(
  rows: WooProductRaw[],
  origin: string,
  maxProducts = 15,
): EcommerceProductSample[] {
  return rows.slice(0, maxProducts).map((p) => {
    const minorUnit = p.prices?.currency_minor_unit ?? 2;
    const rawMinor = Number(p.prices?.price ?? p.prices?.regular_price ?? NaN);
    const computedPrice = Number.isFinite(rawMinor)
      ? Number((rawMinor / 10 ** minorUnit).toFixed(minorUnit))
      : undefined;
    const currency = p.prices?.currency_code;
    const productType = p.categories?.[0]?.name;
    const tags = (p.tags ?? []).map((t) => t.name ?? '').filter(Boolean);

    return {
      id: String(p.id ?? p.slug ?? ''),
      title: decodeEntities(p.name ?? 'Untitled Product').trim(),
      ...(p.slug ? { handle: p.slug } : {}),
      url: p.permalink ?? (p.slug ? `${origin}/product/${p.slug}/` : origin),
      ...(productType ? { productType } : {}),
      ...(computedPrice !== undefined ? { priceMin: computedPrice, priceMax: computedPrice } : {}),
      ...(currency ? { currency } : {}),
      available: p.is_in_stock !== false,
      tags: tags.slice(0, 12),
    };
  });
}

/**
 * Inspects an ecommerce storefront via public Shopify and WooCommerce JSON endpoints
 * plus homepage HTML platform and app signatures (all SSRF-validated).
 */
export async function inspectEcommerceStore(
  input: InspectEcommerceStoreInput,
): Promise<InspectEcommerceStoreResult> {
  const maxProducts = input.maxProducts ?? 15;
  const timeoutMs = input.timeoutMs ?? 12_000;

  const validatedTarget = await assertPublicUrl(input.url, input.deps);
  const origin = validatedTarget.origin;

  const shopifyLimit = Math.min(Math.max(maxProducts, 10), 250);
  const wooLimit = Math.min(Math.max(maxProducts, 10), 100);

  const [homeSettled, shopifyProdSettled, shopifyMetaSettled, wooSettled] = await Promise.allSettled([
    safeFetch(validatedTarget.toString(), { timeoutMs, maxBytes: 2 * 1024 * 1024, deps: input.deps }),
    safeFetch(`${origin}/products.json?limit=${shopifyLimit}`, {
      timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      headers: { accept: 'application/json' },
      deps: input.deps,
    }),
    safeFetch(`${origin}/meta.json`, {
      timeoutMs,
      maxBytes: 512 * 1024,
      headers: { accept: 'application/json' },
      deps: input.deps,
    }),
    safeFetch(`${origin}/wp-json/wc/store/v1/products?per_page=${wooLimit}`, {
      timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      headers: { accept: 'application/json' },
      deps: input.deps,
    }),
  ]);

  const rawHomeHtml =
    homeSettled.status === 'fulfilled' && homeSettled.value.ok ? homeSettled.value.text : '';
  const homeHtml =
    rawHomeHtml.length > MAX_HTML_INPUT_CHARS
      ? rawHomeHtml.slice(0, MAX_HTML_INPUT_CHARS)
      : rawHomeHtml;
  const homeHeaders =
    homeSettled.status === 'fulfilled' ? homeSettled.value.headers : {};

  let shopifyProductsPayload: ShopifyProductsPayload | undefined;
  if (shopifyProdSettled.status === 'fulfilled' && shopifyProdSettled.value.ok) {
    try {
      const parsed = JSON.parse(shopifyProdSettled.value.text) as ShopifyProductsPayload;
      if (Array.isArray(parsed.products)) {
        shopifyProductsPayload = parsed;
      }
    } catch {
      // Non-JSON /products.json
    }
  }

  let shopifyMeta: ShopifyMetaJson | undefined;
  if (shopifyMetaSettled.status === 'fulfilled' && shopifyMetaSettled.value.ok) {
    try {
      const parsed = JSON.parse(shopifyMetaSettled.value.text) as ShopifyMetaJson;
      if (parsed && typeof parsed === 'object' && (parsed.myshopify_domain || parsed.currency || parsed.name)) {
        shopifyMeta = parsed;
      }
    } catch {
      // Non-JSON /meta.json
    }
  }

  let wooProductsRaw: WooProductRaw[] | undefined;
  if (wooSettled.status === 'fulfilled' && wooSettled.value.ok) {
    try {
      const parsed = JSON.parse(wooSettled.value.text) as unknown;
      if (Array.isArray(parsed)) {
        wooProductsRaw = parsed as WooProductRaw[];
      }
    } catch {
      // Non-JSON Woo response
    }
  }

  let platform: EcommercePlatform = detectPlatformFromHtml(homeHtml, homeHeaders);
  if (shopifyProductsPayload || shopifyMeta) {
    platform = 'shopify';
  } else if (wooProductsRaw) {
    platform = 'woocommerce';
  }

  const inlineShopify = extractShopifyInlineVars(homeHtml);
  const currency = shopifyMeta?.currency ?? inlineShopify.currency;

  let products: EcommerceProductSample[] = [];
  if (shopifyProductsPayload) {
    products = normalizeShopifyProducts(shopifyProductsPayload, origin, currency, maxProducts);
  } else if (wooProductsRaw) {
    products = normalizeWooProducts(wooProductsRaw, origin, maxProducts);
  }

  const techSignals: string[] = [];
  for (const [label, regex] of ECOMMERCE_SIGNAL_PATTERNS) {
    if (regex.test(homeHtml)) {
      techSignals.push(label);
    }
  }

  const allPrices = products.flatMap((p) =>
    [p.priceMin, p.priceMax].filter((v): v is number => v !== undefined && Number.isFinite(v)),
  );
  const detectedCurrency = currency ?? products.find((p) => p.currency)?.currency;

  return {
    storeUrl: validatedTarget.toString(),
    origin,
    platform,
    storeMeta: {
      ...(shopifyMeta?.name || extractHtmlTitle(homeHtml)
        ? { name: shopifyMeta?.name ?? extractHtmlTitle(homeHtml) }
        : {}),
      ...(shopifyMeta?.myshopify_domain || inlineShopify.myshopifyDomain
        ? { myshopifyDomain: shopifyMeta?.myshopify_domain ?? inlineShopify.myshopifyDomain }
        : {}),
      ...(shopifyMeta?.country || inlineShopify.country
        ? { country: shopifyMeta?.country ?? inlineShopify.country }
        : {}),
      ...(detectedCurrency ? { currency: detectedCurrency } : {}),
      ...(shopifyMeta?.description ? { description: shopifyMeta.description } : {}),
    },
    endpoints: {
      shopifyProductsJson: Boolean(shopifyProductsPayload),
      shopifyMetaJson: Boolean(shopifyMeta),
      wooStoreApi: Boolean(wooProductsRaw),
    },
    techSignals,
    priceSummary: {
      productSampleCount: products.length,
      ...(allPrices.length > 0 ? { minPrice: Math.min(...allPrices), maxPrice: Math.max(...allPrices) } : {}),
      ...(detectedCurrency ? { currency: detectedCurrency } : {}),
    },
    products,
  };
}
