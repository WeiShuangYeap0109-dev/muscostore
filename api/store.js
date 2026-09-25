import { neon } from '@neondatabase/serverless';

const json = (res, status, body) => res.status(status).json(body);
const empty = () => ({ products: [], members: [], orders: [], creditHistory: [], stockMovements: [], settings: {} });

function safeForBrowser(data) {
  const copy = JSON.parse(JSON.stringify(data || empty()));
  copy.members = Array.isArray(copy.members) ? copy.members.map(({ password, ...safe }) => safe) : [];
  return copy;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!process.env.DATABASE_URL) return json(res, 500, { error: 'DATABASE_URL is not configured' });
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS musco_store (id TEXT PRIMARY KEY, data JSONB NOT NULL)`;
    await sql`INSERT INTO musco_store (id, data) VALUES ('main', ${JSON.stringify(empty())}::jsonb) ON CONFLICT (id) DO NOTHING`;

    if (req.method === 'GET') {
      const rows = await sql`SELECT data FROM musco_store WHERE id='main' LIMIT 1`;
      return json(res, 200, { data: safeForBrowser(rows[0]?.data || empty()) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    let body = req.body || {};
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const incoming = body.data;
    if (!incoming || typeof incoming !== 'object') return json(res, 400, { error: 'Missing data' });

    incoming.products = Array.isArray(incoming.products) ? incoming.products : [];
    incoming.members = Array.isArray(incoming.members) ? incoming.members : [];
    incoming.orders = Array.isArray(incoming.orders) ? incoming.orders : [];
    incoming.creditHistory = Array.isArray(incoming.creditHistory) ? incoming.creditHistory : [];
    incoming.stockMovements = Array.isArray(incoming.stockMovements) ? incoming.stockMovements : [];
    incoming.settings = incoming.settings && typeof incoming.settings === 'object' ? incoming.settings : {};

    const rows = await sql`SELECT data FROM musco_store WHERE id='main' LIMIT 1`;
    const existing = rows[0]?.data || empty();

    // Keep legacy member passwords server-side; V2 no longer uses customer login.
    const existingMembers = Array.isArray(existing.members) ? existing.members : [];
    incoming.members = incoming.members.map(member => {
      const old = existingMembers.find(x => String(x.id) === String(member.id));
      return old && Object.prototype.hasOwnProperty.call(old, 'password')
        ? { ...old, ...member, password: old.password }
        : member;
    });

    // Never erase a saved Base64 product image just because a client sends an empty photo field.
    const existingProducts = Array.isArray(existing.products) ? existing.products : [];
    incoming.products = incoming.products.map(product => {
      const old = existingProducts.find(x => String(x.id) === String(product.id) || (x.productId && product.productId && String(x.productId) === String(product.productId)));
      return old?.photo && !product.photo ? { ...product, photo: old.photo } : product;
    });
    if (existing?.settings?.logo && !incoming.settings.logo) incoming.settings.logo = existing.settings.logo;

    await sql`INSERT INTO musco_store (id,data) VALUES ('main',${JSON.stringify(incoming)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`;
    return json(res, 200, { ok: true, saved: true });
  } catch (error) {
    console.error('MUSCO STORE API ERROR:', error);
    return json(res, 500, { error: error?.message || 'Cloud database save failed' });
  }
}
