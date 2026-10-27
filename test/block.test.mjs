// Runs the real theme-block script in a simulated browser against the real server (with a fake Shopify / AI behind it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { boot, SHOP } from './helpers.mjs';

const liquid = fs.readFileSync(new URL('../shopify-app/extensions/product-tryon/blocks/product-tryon.liquid', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../shopify-app/extensions/product-tryon/assets/product-tryon.js', import.meta.url), 'utf8');

// Minimal Liquid: drop tags/comments/schema, fill the few {{ }} values the block uses.
function render(vars) {
  return liquid
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '')
    .replace(/\{%\s*schema\s*%\}[\s\S]*?\{%\s*endschema\s*%\}/g, '')
    .replace(/\{%-?[\s\S]*?-?%\}/g, '')
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => {
      const key = expr.split('|')[0].trim();
      return vars[key] ?? '';
    });
}

async function page(t, { handle, variant = '1001', category = '' }) {
  const html = render({
    api: t.base, 'shop.permanent_domain': SHOP, 'product.handle': handle, 'product.selected_or_first_available_variant.id': variant,
    'product.metafields.custom.tryon_category.value': category, 'block.settings.button_label': 'Choose photo', 'block.settings.accent': '#111',
    'block.settings.heading': 'Try it on', 'block.settings.subheading': 'sub', 'block.id': 'b1', 'block.shopify_attributes': '',
  });
  const dom = new JSDOM(`<!doctype html><body><form action="/cart/add"><input name="id" value="${variant}"></form>${html}`, { url: 'https://cool-store.myshopify.com/products/' + handle, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = (u, i) => fetch(u, i);
  w.createImageBitmap = async () => { const c = w.document.createElement('canvas'); c.width = 600; c.height = 800; return c; };
  w.eval(script);
  const root = w.document.querySelector('.ptn');
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 25)); } };
  const choose = (file = new w.File([new Uint8Array(10)], 'me.jpg', { type: 'image/jpeg' })) => {
    const inp = root.querySelector('.ptn-file');
    Object.defineProperty(inp, 'files', { value: [file], configurable: true });
    inp.dispatchEvent(new w.Event('change'));
  };
  return { w, root, until, choose, $: (s) => root.querySelector(s), close: () => w.close() };
}

test('block: shows only on wearable products and names the category', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' } });
  const hat = await page(t, { handle: 'classic-wool-beanie' });
  await hat.until(() => !hat.root.hidden);
  assert.match(hat.$('.ptn-btn-label').textContent, /try on hat \/ cap/);
  const oil = await page(t, { handle: 'hair-oil' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(oil.root.hidden, true, 'a care product gets no try-on');
  hat.close(); oil.close(); await t.close();
});

test('block: photo -> AI preview of the selected variant; changing the variant offers a new preview', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', RATE_PER_MINUTE: '20' } });
  const p = await page(t, { handle: 'classic-wool-beanie', variant: '1002' });
  await p.until(() => !p.root.hidden);

  p.choose();
  await p.until(() => /tick the box/.test(p.$('.ptn-status').textContent));
  assert.equal(t.world.cf, undefined, 'nothing is sent without consent');

  p.$('.ptn-consent-box').checked = true;
  p.choose();
  await p.until(() => !p.$('.ptn-stage').hidden && p.$('.ptn-result').src.startsWith('data:'));
  assert.match(p.$('.ptn-status').textContent, /Classic Wool Beanie \(Blue \/ S\)/);
  const form = t.world.cf.form;
  assert.ok(form.get('input_image_0') && form.get('input_image_1'));
  assert.match(form.get('prompt'), /Color: Blue/);
  assert.match(t.world.calls.filter((c) => c.url.includes('cdn.shopify')).at(-1).url, /blue\.jpg/);
  assert.equal(form.get('width'), '576', '600x800 photo was reduced to 360x480 for Cloudflare and keeps its shape');
  assert.equal(form.get('height'), '768');
  assert.equal(p.$('.ptn-regen').hidden, true);

  // shopper picks the red variant on the page
  p.w.document.querySelector('form [name="id"]').value = '1001';
  await p.until(() => !p.$('.ptn-regen').hidden, 3000);
  p.$('.ptn-regen').click();
  await p.until(() => /Red \/ S/.test(p.$('.ptn-status').textContent));
  assert.match(t.world.calls.filter((c) => c.url.includes('cdn.shopify')).at(-1).url, /red\.jpg/);
  assert.equal(p.$('.ptn-regen').hidden, true);

  const preview = p.$('.ptn-result').src;
  p.$('.ptn-toggle').click();
  assert.notEqual(p.$('.ptn-result').src, preview, 'shows the original photo');
  p.$('.ptn-toggle').click();
  assert.equal(p.$('.ptn-result').src, preview);
  p.close(); await t.close();
});

test('block: server errors are shown to the shopper in plain words', async () => {
  const t = await boot({ env: { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', DAILY_CAP_PER_SHOP: '0' } });
  const p = await page(t, { handle: 'classic-wool-beanie' });
  await p.until(() => !p.root.hidden);
  p.$('.ptn-consent-box').checked = true;
  p.choose();
  await p.until(() => /reached today/.test(p.$('.ptn-status').textContent));
  assert.equal(p.$('.ptn-stage').hidden, true);
  p.close(); await t.close();
});
