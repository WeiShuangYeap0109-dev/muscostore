export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD is not configured' });
  if (body.username === username && body.password === password) return res.status(200).json({ ok: true });
  return res.status(401).json({ ok: false });
}
