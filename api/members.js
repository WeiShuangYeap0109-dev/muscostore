import { neon } from "@neondatabase/serverless";

const json = (res, status, body) => res.status(status).json(body);

const safeMember = (m) => {
  if (!m) return null;
  const { password, ...safe } = m;
  return safe;
};

function normalizePhone(value) {
  return String(value || "").replace(/\s/g, "");
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function detectCreditProduct(product) {
  const text = [
    product?.name,
    product?.title,
    product?.productName,
    product?.description,
    product?.id,
    product?.sku,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const amount = Number(
    product?.creditAmount ??
      product?.credit ??
      product?.credit_value ??
      product?.amount ??
      0
  );

  if (amount === 388 || text.includes("388")) {
    return { creditAmount: 388, validityMonths: 12 };
  }

  if (amount === 688 || text.includes("688")) {
    return { creditAmount: 688, validityMonths: 24 };
  }

  if (text.includes("credit")) {
    return {
      creditAmount: Number.isFinite(amount) && amount > 0 ? amount : 0,
      validityMonths: Number(
        product?.validityMonths || product?.validity || 12
      ),
    };
  }

  return null;
}

function getCreditLots(member) {
  const lots = Array.isArray(member.creditLots) ? member.creditLots : [];
  return lots
    .map((lot) => ({
      id: String(
        lot.id || `CREDIT-${member.id}-${lot.purchaseDate || Date.now()}`
      ),
      productId: String(lot.productId || ""),
      productName: String(lot.productName || "Credit"),
      originalAmount: Number(lot.originalAmount || 0),
      balance: Number(lot.balance || 0),
      purchaseDate: lot.purchaseDate || null,
      expiry: lot.expiry || null,
      invoiceNo: lot.invoiceNo || "",
    }))
    .filter((lot) => lot.balance > 0 || lot.originalAmount > 0);
}

function totalCreditBalance(member) {
  return getCreditLots(member)
    .filter((lot) => !lot.expiry || lot.expiry >= formatDateOnly(new Date()))
    .reduce((sum, lot) => sum + Math.max(0, Number(lot.balance || 0)), 0);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    if (!process.env.DATABASE_URL) {
      return json(res, 500, { error: "DATABASE_URL is not configured" });
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
      settings: {},
    };

    data.products = Array.isArray(data.products) ? data.products : [];
    data.members = Array.isArray(data.members) ? data.members : [];
    data.orders = Array.isArray(data.orders) ? data.orders : [];
    data.settings = data.settings || {};

    if (req.method === "GET") {
      const members = data.members.map((m) => {
        const safe = safeMember(m);
        safe.credit = totalCreditBalance(m);
        safe.creditLots = getCreditLots(m).map((lot) => ({
          ...lot,
          balance: Number(lot.balance || 0),
        }));
        return safe;
      });

      const credits = [];
      for (const m of data.members) {
        for (const lot of getCreditLots(m)) {
          if (Number(lot.balance || 0) > 0) {
            credits.push({
              id: lot.id,
              memberId: m.id,
              date: lot.purchaseDate,
              type: "Credit",
              amount: Number(lot.balance || 0),
              originalAmount: Number(lot.originalAmount || 0),
              expiry: lot.expiry,
              productId: lot.productId,
              productName: lot.productName,
              invoiceNo: lot.invoiceNo,
            });
          }
        }
      }

      return json(res, 200, { members, credits });
    }

    if (req.method !== "POST") {
      return json(res, 405, { error: "Method not allowed" });
    }

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    if (body.action === "login") {
      const phone = String(body.phone || "").trim();
      const password = String(body.password || "");

      if (!phone || !password) {
        return json(res, 400, { error: "Phone and password are required." });
      }

      const member = data.members.find(
        (x) => normalizePhone(x.phone) === normalizePhone(phone)
      );

      if (!member) {
        return json(res, 404, {
          error: "电话号码不存在，请先 Create Account",
        });
      }

      if (String(member.password || "") !== password) {
        return json(res, 401, { error: "Password 错误" });
      }

      return json(res, 200, {
        member: {
          ...safeMember(member),
          credit: totalCreditBalance(member),
          creditLots: getCreditLots(member),
        },
        credit: totalCreditBalance(member),
      });
    }

    if (body.action === "member") {
      const m = body.member || {};
      const id = String(m.id || "").trim();
      const name = String(m.name || "").trim();
      const phone = String(m.phone || "").trim();

      if (!id || !name || !phone) {
        return json(res, 400, {
          error: "Member ID, name and phone are required.",
        });
      }

      const normalizedPhone = normalizePhone(phone);
      const duplicate = data.members.find(
        (x) => x.id !== id && normalizePhone(x.phone) === normalizedPhone
      );

      if (duplicate) {
        return json(res, 409, {
          error: "这个电话号码已经注册，请直接 Login",
        });
      }

      const existing = data.members.find((x) => x.id === id);

      const member = {
        ...(existing || {}),
        id,
        name,
        phone,
        email: String(m.email ?? existing?.email ?? "")
          .trim()
          .toLowerCase(),
        password: String(m.password ?? existing?.password ?? ""),
        address: String(m.address ?? existing?.address ?? ""),
        credit: totalCreditBalance(existing || m),
        creditLots: getCreditLots(existing || m),
      };

      if (existing) {
        data.members = data.members.map((x) => (x.id === id ? member : x));
      } else {
        data.members.push(member);
      }

      await sql`
        INSERT INTO musco_store (id, data)
        VALUES ('main', ${JSON.stringify(data)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
      `;

      return json(res, 200, safeMember(member));
    }

    /* CREDIT ACTIONS addCredit: Creates a separate credit lot for a purchased credit product. Expiry is calculated from invoiceDate, not the server date. useCredit: Deducts from the earliest-expiring active credit lots first. */

    if (body.action === "addCredit") {
      const c = body.credit || {};
      const memberId = String(c.memberId || "").trim();
      const member = data.members.find((x) => x.id === memberId);

      if (!member) {
        return json(res, 404, { error: "Member not found in cloud store" });
      }

      const product = c.product || {};
      const detected = detectCreditProduct(product);

      const creditAmount = Number(c.amount ?? detected?.creditAmount ?? 0);

      if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
        return json(res, 400, { error: "Invalid credit amount" });
      }

      const invoiceDate = String(c.invoiceDate || "").slice(0, 10);
      const purchaseDate = parseDate(invoiceDate)
        ? invoiceDate
        : formatDateOnly(new Date());

      const validityMonths = Number(
        c.validityMonths ?? detected?.validityMonths ?? 12
      );

      const expiryDate = addMonths(parseDate(purchaseDate), validityMonths);
      expiryDate.setDate(expiryDate.getDate() - 1);

      const lot = {
        id: String(c.id || `CREDIT-${memberId}-${Date.now()}`),
        productId: String(c.productId || product.id || ""),
        productName: String(
          c.productName || product.name || product.title || "Credit"
        ),
        originalAmount: creditAmount,
        balance: creditAmount,
        purchaseDate,
        expiry: formatDateOnly(expiryDate),
        invoiceNo: String(c.invoiceNo || ""),
      };

      const lots = getCreditLots(member);
      lots.push(lot);
      member.creditLots = lots;
      member.credit = totalCreditBalance(member);

      await sql`
        INSERT INTO musco_store (id, data)
        VALUES ('main', ${JSON.stringify(data)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
      `;

      return json(res, 200, {
        ok: true,
        lot,
        credit: member.credit,
        member: safeMember(member),
      });
    }

    if (body.action === "useCredit") {
      const memberId = String(
        body.memberId || body.credit?.memberId || ""
      ).trim();
      const requestedAmount = Number(body.amount ?? body.credit?.amount ?? 0);
      const member = data.members.find((x) => x.id === memberId);

      if (!member) {
        return json(res, 404, { error: "Member not found in cloud store" });
      }

      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
        return json(res, 400, { error: "Invalid credit amount" });
      }

      const today = formatDateOnly(new Date());
      const lots = getCreditLots(member)
        .filter((lot) => Number(lot.balance || 0) > 0)
        .filter((lot) => !lot.expiry || lot.expiry >= today)
        .sort((a, b) => {
          const ad = a.expiry || "9999-12-31";
          const bd = b.expiry || "9999-12-31";
          return ad.localeCompare(bd);
        });

      let remaining = requestedAmount;
      const deductions = [];

      for (const lot of lots) {
        if (remaining <= 0) break;

        const before = Number(lot.balance || 0);
        const used = Math.min(before, remaining);

        lot.balance = Number((before - used).toFixed(2));
        remaining = Number((remaining - used).toFixed(2));

        deductions.push({
          lotId: lot.id,
          productId: lot.productId,
          productName: lot.productName,
          amountUsed: used,
          balanceAfter: lot.balance,
          expiry: lot.expiry,
        });
      }

      if (remaining > 0) {
        return json(res, 400, {
          error: `Insufficient active credit balance. Short by RM${remaining.toFixed(
            2
          )}`,
        });
      }

      member.creditLots = getCreditLots(member);
      member.credit = totalCreditBalance(member);

      await sql`
        INSERT INTO musco_store (id, data)
        VALUES ('main', ${JSON.stringify(data)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
      `;

      return json(res, 200, {
        ok: true,
        requestedAmount,
        deductions,
        credit: member.credit,
        member: safeMember(member),
      });
    }

    /* Backward-compatible credit action. Keeps the old simple balance API working. */
    if (body.action === "credit") {
      const c = body.credit || {};
      const memberId = String(c.memberId || "").trim();
      const amount = Number(c.amount || 0);
      const m = data.members.find((x) => x.id === memberId);

      if (!m) {
        return json(res, 404, { error: "Member not found in cloud store" });
      }

      if (!Number.isFinite(amount) || amount === 0) {
        return json(res, 400, { error: "Invalid credit amount" });
      }

      const currentCredit = totalCreditBalance(m);
      const newCredit = currentCredit + amount;

      if (newCredit < 0) {
        return json(res, 400, {
          error: `Credit balance cannot be negative. Current balance: RM${currentCredit.toFixed(
            2
          )}`,
        });
      }

      /* Legacy positive credit additions become a non-expiring lot. New purchases should use addCredit so expiry is recorded. */
      if (amount > 0) {
        const lots = getCreditLots(m);
        lots.push({
          id: `LEGACY-${memberId}-${Date.now()}`,
          productId: "",
          productName: "Credit",
          originalAmount: amount,
          balance: amount,
          purchaseDate: formatDateOnly(new Date()),
          expiry: null,
          invoiceNo: "",
        });
        m.creditLots = lots;
      } else {
        let remaining = Math.abs(amount);
        const lots = getCreditLots(m).sort((a, b) =>
          (a.expiry || "9999-12-31").localeCompare(b.expiry || "9999-12-31")
        );

        for (const lot of lots) {
          if (remaining <= 0) break;
          const used = Math.min(Number(lot.balance || 0), remaining);
          lot.balance = Number((Number(lot.balance || 0) - used).toFixed(2));
          remaining = Number((remaining - used).toFixed(2));
        }

        if (remaining > 0) {
          return json(res, 400, {
            error: `Credit balance cannot be negative. Current balance: RM${currentCredit.toFixed(
              2
            )}`,
          });
        }

        m.creditLots = lots;
      }

      m.credit = totalCreditBalance(m);

      await sql`
        INSERT INTO musco_store (id, data)
        VALUES ('main', ${JSON.stringify(data)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
      `;

      return json(res, 200, {
        ...c,
        amount,
        memberId,
        balanceBefore: currentCredit,
        balanceAfter: m.credit,
        member: safeMember(m),
      });
    }

    return json(res, 400, { error: "Unknown action." });
  } catch (e) {
    console.error("Members API error:", e);
    return json(res, 500, { error: e?.message || "Database error" });
    }
