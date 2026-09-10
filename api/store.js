import { neon } from '@neondatabase/serverless';
export default async function handler(req, res) {
  try {
    const sql = neon(process.env.DATABASE_URL);
    if (req.method === 'GET') {
      const rows = await sql`SELECT data FROM musco_store WHERE id='main' LIMIT 1`;
      return res.status(200).json({ data: rows[0]?.data || null });
    }
    if (req.method === 'POST') {
      const { data } = req.body;
      await sql`
        INSERT INTO musco_store (id, data) VALUES ('main', ${JSON.stringify(data)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
      `;
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(200).json({ data: null, error: e.message });
  }
}
