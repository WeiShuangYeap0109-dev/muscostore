import { neon } from '@neondatabase/serverless';

const json = (res, status, body) => res.status(status).json(body);

const safeMember = (m) => {
  if (!m) return null;
  const { password, ...safe } = m;
  return safe;
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!process.env.DATABASE_URL) {
      return json(res, 500, {
        error: 'DATABASE_URL is not configured'
      });
    }

    const sql = neon(process.env.DATABASE_URL);

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

    data.products = Array.isArray(data.products) ? data.products : [];
    data.members = Array.isArray(data.members) ? data.members : [];
    data.orders = Array.isArray(data.orders) ? data.orders : [];
    data.settings = data.settings || {};

    // =========================
    // GET MEMBERS
    // =========================
    if (req.method === 'GET') {
      const members = data.members.map(safeMember);

      const credits = [];

      for (const m of data.members) {
        const amount = Number(m.credit || 0);

        if (amount !== 0) {
          credits.push({
            id: `BAL-${m.id}`,
            memberId: m.id,
            date: new Date().toISOString(),
            type: 'Balance',
            amount,
            expiry: null,
            note: 'Current member credit balance'
          });
        }
      }

      return json(res, 200, {
        members,
        credits
      });
    }

    if (req.method !== 'POST') {
      return json(res, 405, {
        error: 'Method not allowed'
      });
    }

    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body || '{}')
        : (req.body || {});

    // =========================
    // CREATE / UPDATE MEMBER
    // =========================
    if (body.action === 'member') {
      const m = body.member || {};

      const id = String(m.id || '').trim();
      const name = String(m.name || '').trim();
      const phone = String(m.phone || '').trim();

      if (!id || !name || !phone) {
        return json(res, 400, {
          error: 'Member ID, name and phone are required.'
        });
      }

      const normalizedPhone = phone.replace(/\s/g, '');

      const duplicate = data.members.find(
        x =>
          x.id !== id &&
          String(x.phone || '').replace(/\s/g, '') === normalizedPhone
      );

      if (duplicate) {
        return json(res, 409, {
          error: '这个电话号码已经注册，请直接 Login'
        });
      }

      const existing = data.members.find(x => x.id === id);

      const member = {
        ...(existing || {}),
        id,
        name,
        phone,

        email: String(
          m.email ?? existing?.email ?? ''
        ).trim().toLowerCase(),

        password: String(
          m.password ?? existing?.password ?? ''
        ),

        address: String(
          m.address ?? existing?.address ?? ''
        ),

        // VERY IMPORTANT:
        // Do not reset existing Credit when editing member.
        credit: Number(
          existing?.credit ?? m.credit ?? 0
        )
      };

      if (existing) {
        data.members = data.members.map(
          x => x.id === id ? member : x
        );
      } else {
        data.members.push(member);
      }

      await sql`
        INSERT INTO musco_store (id, data)
        VALUES (
          'main',
          ${JSON.stringify(data)}::jsonb
        )
        ON CONFLICT (id)
        DO UPDATE SET
          data = EXCLUDED.data
      `;

      return json(res, 200, safeMember(member));
    }

    // =========================
    // ADD / REMOVE CREDIT
    // =========================
    if (body.action === 'credit') {
      const c = body.credit || {};

      const memberId = String(
        c.memberId || ''
      ).trim();

      const amount = Number(c.amount || 0);

      const m = data.members.find(
        x => x.id === memberId
      );

      if (!m) {
        return json(res, 404, {
          error: 'Member not found in cloud store'
        });
      }

      if (!Number.isFinite(amount) || amount === 0) {
        return json(res, 400, {
          error: 'Invalid credit amount'
        });
      }

      const currentCredit = Number(
        m.credit || 0
      );

      const newCredit =
        currentCredit + amount;

      if (newCredit < 0) {
        return json(res, 400, {
          error:
            `Credit balance cannot be negative. Current balance: RM${currentCredit.toFixed(2)}`
        });
      }

      m.credit = newCredit;

      await sql`
        INSERT INTO musco_store (id, data)
        VALUES (
          'main',
          ${JSON.stringify(data)}::jsonb
        )
        ON CONFLICT (id)
        DO UPDATE SET
          data = EXCLUDED.data
      `;

      return json(res, 200, {
        ...c,
        amount,
        memberId,
        balanceBefore: currentCredit,
        balanceAfter: newCredit,
        member: safeMember(m)
      });
    }

    return json(res, 400, {
      error: 'Unknown action.'
    });

  } catch (e) {
    console.error(
      'Members API error:',
      e
    );

    return json(res, 500, {
      error:
        e?.message ||
        'Database error'
    });
  }
}
