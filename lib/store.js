// Storage for installed shops and their synced products.
//  - no MONGODB_URI: a JSON file (DATA_FILE, default ./data/db.json). Fine for one server with a disk (Render, Railway, Fly, VPS).
//  - MONGODB_URI set: MongoDB (needed on Vercel/serverless, where local files are not kept).
// Both expose the same small interface, so the rest of the code does not care which one is used.
import fs from 'node:fs/promises';
import path from 'node:path';

export function createFileStore(file) {
  let db = null;
  let queue = Promise.resolve();
  const load = async () => {
    if (db) return db;
    try {
      db = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      db = { shops: {}, products: {} };
    }
    db.shops ||= {};
    db.products ||= {};
    return db;
  };
  const persist = () => {
    if (!file) return Promise.resolve();
    queue = queue
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(db));
        await fs.rename(tmp, file);
      })
      .catch((e) => console.error('[store] could not write', e.message));
    return queue;
  };
  return {
    kind: file ? 'file' : 'memory',
    async getShop(shop) { return (await load()).shops[shop] || null; },
    async putShop(shop, data) { (await load()).shops[shop] = data; await persist(); },
    async deleteShop(shop) { const d = await load(); delete d.shops[shop]; delete d.products[shop]; await persist(); },
    async listShops() { return Object.keys((await load()).shops); },
    async getProduct(shop, handle) { return (await load()).products[shop]?.[handle] || null; },
    async putProducts(shop, list) {
      const d = await load();
      d.products[shop] ||= {};
      for (const p of list) d.products[shop][p.handle] = p;
      await persist();
    },
    async deleteProduct(shop, id) {
      const d = await load();
      const all = d.products[shop] || {};
      for (const h of Object.keys(all)) if (String(all[h].id) === String(id)) delete all[h];
      await persist();
    },
    async listProducts(shop) { return Object.values((await load()).products[shop] || {}); },
  };
}

export async function createMongoStore(uri) {
  let mongodb;
  try {
    mongodb = await import('mongodb');
  } catch {
    throw new Error('MONGODB_URI is set but the "mongodb" package is not installed. Run: npm install mongodb');
  }
  const client = new mongodb.MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'universal_tryon');
  const shops = db.collection('shops');
  const products = db.collection('products');
  await products.createIndex({ shop: 1, id: 1 });
  return {
    kind: 'mongo',
    async getShop(shop) { const d = await shops.findOne({ _id: shop }); return d ? d.data : null; },
    async putShop(shop, data) { await shops.replaceOne({ _id: shop }, { _id: shop, data }, { upsert: true }); },
    async deleteShop(shop) { await shops.deleteOne({ _id: shop }); await products.deleteMany({ shop }); },
    async listShops() { return (await shops.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id); },
    async getProduct(shop, handle) { const d = await products.findOne({ _id: `${shop}|${handle}` }); return d ? d.data : null; },
    async putProducts(shop, list) {
      if (!list.length) return;
      await products.bulkWrite(list.map((p) => ({
        replaceOne: { filter: { _id: `${shop}|${p.handle}` }, replacement: { _id: `${shop}|${p.handle}`, shop, id: String(p.id), data: p }, upsert: true },
      })));
    },
    async deleteProduct(shop, id) { await products.deleteMany({ shop, id: String(id) }); },
    async listProducts(shop) { return (await products.find({ shop }).toArray()).map((d) => d.data); },
  };
}

export async function createStore(env = process.env) {
  if (env.MONGODB_URI) return createMongoStore(env.MONGODB_URI);
  return createFileStore(env.DATA_FILE === 'memory' ? null : env.DATA_FILE || path.resolve('data/db.json'));
}
