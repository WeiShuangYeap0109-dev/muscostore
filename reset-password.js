import { neon } from "@neondatabase/serverless";

const json = (res, status, body) => res.status(status).json(body);

function safeMember(m) {
  if (!m) return null;
  const { password, ...safe } = m;
  return safe;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    if (!process.env.DATABASE_URL) return json(res, 500, { error: "DATABASE_URL is not configured" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const memberId = String(body.memberId || "").trim();
    const password = String(body.password || "").trim();

    if (!memberId || password.length < 6) {
      return json(res, 400, { error: "Member ID and a password of at least 6 characters are required" });
    }

    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`SELECT data FROM musco_store WHERE id = 'main' LIMIT 1`;
    const data = rows[0]?.data || { products: [], members: [], orders: [], settings: {} };
    data.members = Array.isArray(data.members) ? data.members : [];

    const member = data.members.find((m) => String(m.id) === memberId);
    if (!member) return json(res, 404, { error: "Member not found in cloud store" });

    member.password = password;
    await sql`
      INSERT INTO musco_store (id, data)
      VALUES ('main', ${JSON.stringify(data)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
    `;

    return json(res, 200, { ok: true, member: safeMember(member) });
  } catch (e) {
    console.error("Reset password API error:", e);
    return json(res, 500, { error: e?.message || "Database error" });
  }
}
