import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TryOnError } from './lib/errors.js';
import { normalizeShop, normalizeHandle } from './lib/shops.js';
import { createStore } from './lib/store.js';
import { classify, CATEGORIES, categoryIds } from './lib/categories.js';
import { fetchProduct, fetchAllProducts, normalizeProduct, pickVariant } from './lib/products.js';
import { fetchProductImage } from './lib/images.js';
import { prepareProduct, fitAspect, assess } from './lib/imageops.js';
import { buildPrompt } from './lib/prompt.js';
import { pickEngine } from './lib/engines/index.js';
import { classifyByPhoto, visionEngine } from './lib/vision.js';
import {
  verifyQueryHmac, verifyWebhookHmac, makeState, checkState, installUrl, exchangeCode, encryptToken, decryptToken,
} from './lib/shopifyAuth.js';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PRODUCT_TTL_MS = 10 * 60_000;

export async function createApp(opts = {}) {
  const env = opts.env || process.env;
  const f = opts.fetch || globalThis.fetch;
  const store = opts.store || (await createStore(env));
  const engine = opts.engine !== undefined ? opts.engine : pickEngine(env);

  const API_KEY = env.SHOPIFY_API_KEY;
  const API_SECRET = env.SHOPIFY_API_SECRET;
  const APP_URL = (env.APP_URL || '').replace(/\/$/, '');
  const HAS_APP = Boolean(API_KEY && API_SECRET && APP_URL);
  // Who may use the service. With a Shopify app configured, only stores that installed it (or ALLOWED_SHOPS).
  // Without one, any *.myshopify.com store (set OPEN_SHOPS=0 to refuse unknown stores).
  const ALLOWED = (env.ALLOWED_SHOPS || '').split(',').map((s) => normalizeShop(s)).filter(Boolean);
  // A list in ALLOWED_SHOPS always restricts the service to those stores (unless OPEN_SHOPS=1 is set on purpose).
  const OPEN = env.OPEN_SHOPS === '1' || (!HAS_APP && env.OPEN_SHOPS !== '0' && ALLOWED.length === 0);
  const PER_IP_PER_MIN = Number(env.RATE_PER_MINUTE || 4);
  const SHOP_DAILY = Number(env.DAILY_CAP_PER_SHOP || 200);
  const RETRIES = Math.max(0, Number(env.TRYON_RETRIES ?? 1)); // extra tries when the AI returns a blank picture or hands the photo back unchanged
  const GLOBAL_DAILY = Number(env.DAILY_CAP || (engine?.id === 'cloudflare' ? 80 : 2000));

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ---- limits (in memory; use Redis if you run several servers) ----
  const hits = new Map();
  const shopCount = new Map();
  let day = new Date().toDateString();
  let globalCount = 0;
  function gate(ip, shop) {
    const today = new Date().toDateString();
    if (today !== day) { day = today; globalCount = 0; shopCount.clear(); }
    if (globalCount >= GLOBAL_DAILY) return 'Today\'s preview limit has been reached. Please try again tomorrow.';
    if ((shopCount.get(shop) || 0) >= SHOP_DAILY) return 'This store has reached today\'s preview limit. Please try again tomorrow.';
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
    if (recent.length >= PER_IP_PER_MIN) return 'Too many previews in a minute. Please wait a moment.';
    recent.push(now);
    hits.set(ip, recent);
    globalCount += 1;
    shopCount.set(shop, (shopCount.get(shop) || 0) + 1);
    return null;
  }

  const shopAllowed = async (shop) => OPEN || ALLOWED.includes(shop) || Boolean(await store.getShop(shop));

  // A refreshed copy of a product keeps its saved photo-based answer while its title and main photo are unchanged (so the vision call is made once, not every refresh).
  const keepVision = (old, fresh) => {
    if (old?.vision && old.title === fresh.title && old.images?.[0] === fresh.images?.[0]) fresh.vision = old.vision;
    return fresh;
  };

  async function loadProduct(shop, handle) {
    const cached = await store.getProduct(shop, handle);
    if (cached && Date.now() - cached.fetchedAt < PRODUCT_TTL_MS) return cached;
    const rec = await store.getShop(shop);
    try {
      const p = keepVision(cached, await fetchProduct({ fetch: f, shop, handle, token: decryptToken(rec?.token, env) }));
      await store.putProducts(shop, [p]);
      return p;
    } catch (e) {
      if (e.status === 404 && cached) await store.deleteProduct(shop, cached.id);
      else if (cached) return cached; // store unreachable: a slightly old copy is better than an error
      throw e;
    }
  }

  // The category of a product: the word lists first (free, instant); if they cannot place it and VISION_CLASSIFY=1, look at the
  // product photo once and remember the answer with the product.
  async function resolveCategory(shop, product, hint) {
    const cat = classify(product, hint);
    if (cat.id || hint) return cat;
    const known = product.vision;
    if (known && known.v === 1) return known.category === 'none' ? cat : { id: known.category, by: 'photo' };
    if (!visionEngine(env) || !product.images[0]) return cat;
    try {
      const image = await fetchProductImage({ fetch: f, url: product.images[0], shop, maxSide: 512 });
      const answer = await classifyByPhoto({ env, fetch: f, image, title: product.title });
      if (answer == null) return cat;
      product.vision = { v: 1, category: answer, at: Date.now() };
      await store.putProducts(shop, [product]);
      return answer === 'none' ? cat : { id: answer, by: 'photo' };
    } catch (e) {
      console.warn('[vision] could not classify', product.handle, e.message); // not saved: it will be tried again next time
      return cat;
    }
  }

  async function syncShop(shop) {
    const rec = await store.getShop(shop);
    const products = await fetchAllProducts({ fetch: f, shop, token: decryptToken(rec?.token, env) });
    const before = new Map((await store.listProducts(shop)).map((x) => [x.handle, x]));
    await store.putProducts(shop, products.map((p) => keepVision(before.get(p.handle), p)));
    await store.putShop(shop, { ...(rec || {}), syncedAt: Date.now(), productCount: products.length });
    return products.length;
  }

  // ---- Shopify webhooks need the raw body for their signature, so they are registered before the JSON parser ----
  app.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '4mb' }), async (req, res) => {
    if (!verifyWebhookHmac(req.body, req.get('x-shopify-hmac-sha256'), API_SECRET)) return res.sendStatus(401);
    const topic = req.get('x-shopify-topic') || '';
    const shop = normalizeShop(req.get('x-shopify-shop-domain'));
    let body = {};
    try { body = JSON.parse(req.body.toString('utf8') || '{}'); } catch { return res.sendStatus(400); }
    try {
      if (shop) {
        if (topic === 'products/create' || topic === 'products/update') {
          const p = normalizeProduct(body);
          if (p) await store.putProducts(shop, [keepVision(await store.getProduct(shop, p.handle), p)]);
        } else if (topic === 'products/delete') {
          await store.deleteProduct(shop, body.id);
        } else if (topic === 'app/uninstalled' || topic === 'shop/redact') {
          await store.deleteShop(shop);
        }
        // customers/data_request and customers/redact: this service stores no customer data (photos are never kept), so there is nothing to return or erase.
      }
      return res.sendStatus(200);
    } catch (e) {
      console.error('[webhook]', topic, e.message);
      return res.sendStatus(500);
    }
  });

  // Which websites may call the API from a browser (CORS).
  //  - Nothing configured (no CORS_ORIGINS, no ALLOWED_SHOPS): any site may, so it works anywhere.
  //  - ALLOWED_SHOPS set: each of those stores' own https://<shop>.myshopify.com pages are allowed automatically.
  //  - CORS_ORIGINS="https://radrasa.com,https://www.radrasa.com": extra origins, for stores that use their own domain
  //    ("*" means any). Installed stores' myshopify.com pages are allowed too.
  // CORS only controls browsers; abuse is limited by the daily caps and the store allow-list above.
  const CORS_LIST = (env.CORS_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  const CORS_OPEN = CORS_LIST.includes('*') || (CORS_LIST.length === 0 && ALLOWED.length === 0 && OPEN);
  async function originAllowed(origin) {
    if (CORS_OPEN) return true;
    if (!origin) return false;
    if (CORS_LIST.includes(origin)) return true;
    let host;
    try { const u = new URL(origin); if (u.protocol !== 'https:') return false; host = u.hostname; } catch { return false; }
    return ALLOWED.includes(host) || (Boolean(normalizeShop(host)) && (OPEN || Boolean(await store.getShop(host))));
  }
  app.use('/api', async (req, res, next) => {
    const origin = req.get('Origin');
    if (await originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', CORS_OPEN ? '*' : origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (!CORS_OPEN) res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '12mb' }));

  // ---------------- public API (called by the theme block) ----------------
  app.get('/api/config', (_req, res) => {
    res.json({ ready: Boolean(engine), engine: engine?.id || null, maxPersonSide: engine?.maxPersonSide || 0, categories: categoryIds() });
  });

  app.get('/api/product', async (req, res) => {
    const shop = normalizeShop(req.query.shop);
    const handle = normalizeHandle(req.query.handle);
    if (!shop || !handle) return res.status(400).json({ error: 'Missing or invalid shop or product.' });
    if (!(await shopAllowed(shop))) return res.status(403).json({ error: 'This store has not installed the try-on app.' });
    try {
      const product = await loadProduct(shop, handle);
      const cat = await resolveCategory(shop, product, String(req.query.category || ''));
      const { variant, exact, by } = pickVariant(product, req.query.variant);
      res.set('Cache-Control', 'private, max-age=60');
      res.json({
        ready: Boolean(engine),
        engine: engine?.id || null,
        maxPersonSide: engine?.maxPersonSide || 0,
        tryable: Boolean(cat.id) && Boolean(engine),
        category: cat.id ? { id: cat.id, label: CATEGORIES[cat.id].label, by: cat.by } : null,
        photoHint: cat.id ? CATEGORIES[cat.id].photoHint : null,
        keepFace: cat.id ? CATEGORIES[cat.id].keepFace : false,
        needs: cat.id ? CATEGORIES[cat.id].needs : null,
        title: product.title,
        variant: variant ? { id: variant.id, title: variant.title, ownImage: exact, imageBy: by } : null,
        reason: !cat.id ? 'This product is not something that can be tried on.' : !engine ? 'The try-on service is not set up yet.' : undefined,
      });
    } catch (e) {
      res.status(e instanceof TryOnError ? e.status : 500).json({ error: e instanceof TryOnError ? e.message : 'Something went wrong.' });
    }
  });

  app.post('/api/tryon', async (req, res) => {
    try {
      if (!engine) throw new TryOnError('The try-on service is not set up yet.', 503);
      const { shop: rawShop, handle: rawHandle, variantId, image, consent, category: hint } = req.body || {};
      const shop = normalizeShop(rawShop);
      const handle = normalizeHandle(rawHandle);
      if (!shop || !handle) throw new TryOnError('Missing or invalid shop or product.', 400);
      if (consent !== true) throw new TryOnError('Please confirm the photo is of you and you are 18 or over.', 400);
      if (!image || typeof image.data !== 'string' || !ALLOWED_MIME.has(image.mime)) throw new TryOnError('Upload a JPEG, PNG or WebP photo.', 400);
      if (!/^[A-Za-z0-9+/=]+$/.test(image.data)) throw new TryOnError('The photo data is not valid.', 400);
      if (Buffer.byteLength(image.data, 'base64') > MAX_IMAGE_BYTES) throw new TryOnError('That photo is too large. Please use one under 8 MB.', 413);
      const w = Number(image.width);
      const h = Number(image.height);
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 64 || h < 64 || Math.max(w, h) > engine.maxPersonSide) {
        throw new TryOnError(`Send a photo no larger than ${engine.maxPersonSide} px on its longest side, with its width and height.`, 400);
      }
      if (!(await shopAllowed(shop))) throw new TryOnError('This store has not installed the try-on app.', 403);

      const product = await loadProduct(shop, handle);
      const cat = await resolveCategory(shop, product, String(hint || ''));
      if (!cat.id) throw new TryOnError('This product is not something that can be tried on.', 422);
      const { variant, image: productImageUrl } = pickVariant(product, variantId);
      if (!productImageUrl) throw new TryOnError('This product has no photo to try on.', 422);

      const limited = gate(req.ip, shop);
      if (limited) throw new TryOnError(limited, 429);

      const fetched = await fetchProductImage({ fetch: f, url: productImageUrl, shop, maxSide: engine.productSide });
      const productImage = await prepareProduct(fetched, engine.productSide);
      const prompt = buildPrompt({ categoryId: cat.id, product, variant, optionNames: product.options, compact: engine.id === 'cloudflare' });
      const personIn = { mime: image.mime, data: image.data, width: w, height: h };
      let out = null;
      let tries = 0;
      let verdict = { ok: false };
      while (tries <= RETRIES) {
        tries += 1;
        out = await engine.generate({ env, fetch: f, prompt, person: personIn, product: productImage, signal: AbortSignal.timeout(90_000) });
        out = await fitAspect(out, w, h);
        verdict = await assess(out, personIn, cat.id);
        if (verdict.ok) break;
        console.warn(`[quality] ${shop}/${handle}: ${verdict.reason} result, try ${tries}`);
      }
      if (!verdict.ok) throw new TryOnError(`The preview did not come out right this time. ${CATEGORIES[cat.id].photoHint} Then try again.`, 422);
      const label = `${product.title}${variant && variant.title && variant.title !== 'Default Title' ? ` (${variant.title})` : ''}`;
      res.json({ image: out, label, category: cat.id, tries, keepFace: CATEGORIES[cat.id].keepFace });
    } catch (e) {
      if (!(e instanceof TryOnError)) console.error(e);
      res.status(e instanceof TryOnError ? e.status : 500).json({ error: e instanceof TryOnError ? e.message : 'Something went wrong. Please try again.' });
    }
  });

  // ---------------- Shopify install ----------------
  app.get('/', (req, res) => {
    // Shopify opens the app URL with ?shop=...&hmac=... when a merchant installs or opens the app.
    const shop = normalizeShop(req.query.shop);
    if (HAS_APP && shop && verifyQueryHmac(req.query, API_SECRET)) return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);
    res.type('text/plain').send('Universal try-on service is running.');
  });

  app.get('/auth', (req, res) => {
    if (!HAS_APP) return res.status(503).send('Shopify app credentials are not configured on this server.');
    const shop = normalizeShop(req.query.shop);
    if (!shop) return res.status(400).send('Invalid shop.');
    const state = makeState(shop, API_SECRET);
    res.setHeader('Set-Cookie', `tryon_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`);
    res.redirect(installUrl({ shop, apiKey: API_KEY, scopes: env.SCOPES || 'read_products', appUrl: APP_URL, state }));
  });

  app.get('/auth/callback', async (req, res) => {
    if (!HAS_APP) return res.status(503).send('Shopify app credentials are not configured on this server.');
    const shop = normalizeShop(req.query.shop);
    const cookie = /(?:^|;\s*)tryon_state=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (!shop || !req.query.code || !verifyQueryHmac(req.query, API_SECRET)) return res.status(400).send('Invalid request.');
    if (!cookie || cookie !== req.query.state || !checkState(req.query.state, shop, API_SECRET)) return res.status(400).send('The install session expired. Please start the install again.');
    try {
      const { token, scope } = await exchangeCode({ fetch: f, shop, apiKey: API_KEY, secret: API_SECRET, code: String(req.query.code) });
      await store.putShop(shop, { token: encryptToken(token, env), scope, installedAt: Date.now() });
      syncShop(shop).catch((e) => console.error('[sync]', shop, e.message)); // fill the catalogue in the background
      res.setHeader('Set-Cookie', 'tryon_state=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0');
      res.type('html').send('<!doctype html><meta charset="utf-8"><title>Installed</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1>Try-on installed</h1><p>Open your theme editor, add the <b>Product try-on</b> block to the product page, and save.</p>');
    } catch (e) {
      console.error('[auth]', e.message);
      res.status(502).send('Could not finish the install. Please try again.');
    }
  });

  // ---------------- admin (your own use; needs ADMIN_SECRET) ----------------
  const admin = (req, res, next) => {
    const secret = env.ADMIN_SECRET;
    const given = /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1] || '';
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(String(secret || '')).digest();
    if (!secret || !crypto.timingSafeEqual(a, b)) return res.sendStatus(secret ? 401 : 404);
    next();
  };
  app.post('/admin/sync', admin, async (req, res) => {
    const shop = normalizeShop(req.body?.shop);
    if (!shop) return res.status(400).json({ error: 'Invalid shop.' });
    try { res.json({ shop, products: await syncShop(shop) }); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.get('/admin/catalog', admin, async (req, res) => {
    const shop = normalizeShop(req.query.shop);
    if (!shop) return res.status(400).json({ error: 'Invalid shop.' });
    const list = (await store.listProducts(shop)).map((p) => ({ handle: p.handle, title: p.title, type: p.type, category: classify(p).id || (p.vision && p.vision.category !== 'none' ? p.vision.category : null), variants: p.variants.length, hasImage: p.images.length > 0 }));
    res.json({ shop, total: list.length, tryable: list.filter((p) => p.category).length, products: list });
  });

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That photo is too large. Please use one under 8 MB.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
}

// Serverless (Vercel) entry: build the app once, then reuse it.
let appPromise;
export default function handler(req, res) {
  appPromise ||= createApp();
  return appPromise.then((a) => a(req, res));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile?.(); } catch { /* no .env file */ }
  const PORT = Number(process.env.PORT || 3000);
  createApp().then((a) => a.listen(PORT, () => console.log(`Universal try-on running on port ${PORT}`)));
}
