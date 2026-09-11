import { neon } from '@neondatabase/serverless';

const json = (res, status, body) => res.status(status).json(body);

function removePasswords(data) {
  const copy = JSON.parse(JSON.stringify(data || {}));
  if (Array.isArray(copy.members)) {
    copy.members = copy.members.map(({ password, ...safe }) => safe);
  }
  return copy;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!process.env.DATABASE_URL) return json(res, 500, { error: 'DATABASE_URL is not configured' });
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS musco_store (id TEXT PRIMARY KEY, data JSONB NOT NULL)`;
    await sql`INSERT INTO musco_store (id, data) VALUES ('main', ${JSON.stringify({products:[],members:[],orders:[],settings:{}})}::jsonb) ON CONFLICT (id) DO NOTHING`;

    if (req.method === 'GET') {
      const rows = await sql`SELECT data FROM musco_store WHERE id='main' LIMIT 1`;
      return json(res, 200, { data: removePasswords(rows[0]?.data || {products:[],members:[],orders:[],settings:{}}) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    let body = req.body || {};
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const incoming = body.data;
    if (!incoming || typeof incoming !== 'object') return json(res, 400, { error: 'Missing data' });

    incoming.products = Array.isArray(incoming.products) ? incoming.products : [];
    incoming.members = Array.isArray(incoming.members) ? incoming.members : [];
    incoming.orders = Array.isArray(incoming.orders) ? incoming.orders : [];
    incoming.settings = incoming.settings && typeof incoming.settings === 'object' ? incoming.settings : {};

    // IMPORTANT: the browser intentionally never receives member passwords.
    // Preserve the passwords already stored in Neon whenever the incoming member has none.
    const rows = await sql`SELECT data FROM musco_store WHERE id='main' LIMIT 1`;
    const existing = rows[0]?.data || { products:[], members:[], orders:[], settings:{} };
    const existingMembers = Array.isArray(existing.members) ? existing.members : [];
    incoming.members = incoming.members.map(member => {
      const old = existingMembers.find(x => String(x.id) === String(member.id));
      if (old && Object.prototype.hasOwnProperty.call(old, 'password')) {
        return { ...old, ...member, password: old.password };
      }
      return member;
    });

    await sql`INSERT INTO musco_store (id,data) VALUES ('main',${JSON.stringify(incoming)}::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`;
    return json(res, 200, { ok:true, saved:true });
  } catch (error) {
    console.error('MUSCO STORE API ERROR:', error);
    return json(res, 500, { error: error?.message || 'Cloud database save failed' });
  }
}
