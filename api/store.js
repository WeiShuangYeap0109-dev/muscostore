import { neon } from '@neondatabase/serverless';

const json = (res, status, body) => {
  return res.status(status).json(body);
};

function removePasswords(data) {
  const copy = JSON.parse(JSON.stringify(data || {}));

  if (Array.isArray(copy.members)) {
    copy.members = copy.members.map(member => {
      const { password, ...safeMember } = member;
      return safeMember;
    });
  }

  return copy;
}

export default async function handler(req, res) {
  try {
    if (!process.env.DATABASE_URL) {
      return json(res, 500, {
        error: 'DATABASE_URL is not configured'
      });
    }

    const sql = neon(process.env.DATABASE_URL);

    await sql`
      CREATE TABLE IF NOT EXISTS musco_store (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      )
    `;

    await sql`
      INSERT INTO musco_store (id, data)
      VALUES (
        'main',
        ${JSON.stringify({
          products: [],
          members: [],
          orders: [],
          settings: {}
        })}::jsonb
      )
      ON CONFLICT (id) DO NOTHING
    `;

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT data
        FROM musco_store
        WHERE id = 'main'
        LIMIT 1
      `;

      const data = rows[0]?.data || {
        products: [],
        members: [],
        orders: [],
        settings: {}
      };

      return json(res, 200, {
        data: removePasswords(data)
      });
    }

    if (req.method === 'POST') {
      let body = req.body || {};

      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          return json(res, 400, {
            error: 'Invalid JSON body'
          });
        }
      }

      const incoming = body.data;

      if (!incoming || typeof incoming !== 'object') {
        return json(res, 400, {
          error: 'Missing data'
        });
      }

      incoming.products = Array.isArray(incoming.products)
        ? incoming.products
        : [];

      incoming.members = Array.isArray(incoming.members)
        ? incoming.members
        : [];

      incoming.orders = Array.isArray(incoming.orders)
        ? incoming.orders
        : [];

      incoming.settings =
        incoming.settings &&
        typeof incoming.settings === 'object'
          ? incoming.settings
          : {};

      await sql`
        INSERT INTO musco_store (
          id,
          data
        )
        VALUES (
          'main',
          ${JSON.stringify(incoming)}::jsonb
        )
        ON CONFLICT (id)
        DO UPDATE SET
          data = EXCLUDED.data
      `;

      return json(res, 200, {
        ok: true,
        saved: true
      });
    }

    if (req.method === 'DELETE') {
      const emptyData = {
        products: [],
        members: [],
        orders: [],
        settings: {}
      };

      await sql`
        UPDATE musco_store
        SET data = ${JSON.stringify(emptyData)}::jsonb
        WHERE id = 'main'
      `;

      return json(res, 200, {
        ok: true
      });
    }

    res.setHeader(
      'Allow',
      'GET, POST, DELETE'
    );

    return json(res, 405, {
      error: 'Method not allowed'
    });

  } catch (error) {
    console.error(
      'MUSCO STORE API ERROR:',
      error
    );

    return json(res, 500, {
      error:
        error?.message ||
        'Cloud database save failed'
    });
  }
}
