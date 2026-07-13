import { Pool } from "pg";
import { Offer, OfferInput } from "./types";
import { groupSuppliers, SupplierGroup } from "./supplierNormalize";

// Vercel Postgres (Neon) sets POSTGRES_URL automatically once you add the
// Storage integration in the Vercel dashboard. DATABASE_URL is supported
// as a fallback for any other Postgres provider.
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

const globalForPg = globalThis as unknown as { pgPool?: Pool };

function getPool(): Pool {
  if (!connectionString) {
    throw new Error(
      "No database connection string found. Set POSTGRES_URL (added automatically when you " +
        "attach Vercel Postgres storage) or DATABASE_URL."
    );
  }
  if (!globalForPg.pgPool) {
    globalForPg.pgPool = new Pool({
      connectionString,
      ssl: connectionString.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
      max: 5,
    });
  }
  return globalForPg.pgPool;
}

// Lazily create the table on first use so deployment is just: add Postgres
// storage in Vercel, deploy — no separate migration step.
let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS offers (
          id SERIAL PRIMARY KEY,
          supplier TEXT NOT NULL,
          brand TEXT NOT NULL,
          product TEXT NOT NULL,
          sku TEXT,
          price NUMERIC NOT NULL,
          currency TEXT NOT NULL DEFAULT 'EUR',
          rrp NUMERIC,
          moq TEXT,
          lead_time_days TEXT,
          payment_terms TEXT,
          region TEXT,
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- Added later: Incoterm/shipping-term (e.g. "EXW Dubai") and an
        -- EU / Non-EU origin flag. The latter matters for grey-market
        -- compliance — parallel-import trademark exhaustion in the EU
        -- depends on whether goods were first placed on the EU/EEA market
        -- with the trademark owner's consent, so knowing whether a batch is
        -- EU-origin or not is a real legal signal, not just metadata.
        ALTER TABLE offers ADD COLUMN IF NOT EXISTS incoterm TEXT;
        ALTER TABLE offers ADD COLUMN IF NOT EXISTS market_origin TEXT;
        -- Lead time started out as a whole-number day count, but suppliers
        -- routinely quote it as "6 weeks", "10-15 days", "immediate", etc. -
        -- widen the existing column to free text (a no-op if this has
        -- already run once, since ALTER ... TYPE TEXT on a column that's
        -- already TEXT succeeds without changing anything).
        ALTER TABLE offers ALTER COLUMN lead_time_days TYPE TEXT USING lead_time_days::text;
        -- Stock status (e.g. "In Stock", "Preorder", "Backorder", "Out of
        -- Stock") captured at import time so offers can be filtered by
        -- availability instead of just price.
        ALTER TABLE offers ADD COLUMN IF NOT EXISTS availability TEXT;
        -- MOQ started out as a whole-number quantity, but suppliers routinely
        -- quote it as "500 (neg.)", "2-3 cartons", "no minimum", etc. - widen
        -- to free text, same treatment as lead_time_days above (a no-op once
        -- the column is already TEXT).
        ALTER TABLE offers ALTER COLUMN moq TYPE TEXT USING moq::text;`
      )
      .then(() => undefined);
  }
  return schemaReady;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(row: any): Offer {
  return {
    id: row.id,
    supplier: row.supplier,
    brand: row.brand,
    product: row.product,
    sku: row.sku,
    price: Number(row.price),
    currency: row.currency,
    rrp: row.rrp === null ? null : Number(row.rrp),
    moq: row.moq,
    leadTimeDays: row.lead_time_days,
    paymentTerms: row.payment_terms,
    region: row.region,
    incoterm: row.incoterm,
    marketOrigin: row.market_origin,
    availability: row.availability,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export type ListOffersParams = {
  search?: string;
  brand?: string;
  supplier?: string;
  // Exact-match against any of these raw supplier values at once - used by
  // the History page to pull every offer for a fuzzy-matched group of
  // supplier name variants (see lib/supplierNormalize.ts) in one query.
  // Takes precedence over `supplier` when both are set.
  supplierIn?: string[];
  limit?: number;
  offset?: number;
};

export type ListOffersResult = {
  offers: Offer[];
  total: number;
};

// Paginated + server-side filtered listing. Loading the whole table into the
// browser stopped being viable once the table grew into the tens of
// thousands of rows (it was crashing the tab), so the API now always returns
// a bounded page plus a total count for building pager controls.
const DEFAULT_PAGE_SIZE = 100;
// High enough to pull every offer for a single brand in one shot (for the
// price matrix view) without going back to a fully unpaginated table scan.
const MAX_PAGE_SIZE = 5000;

export async function listOffers(params: ListOffersParams = {}): Promise<ListOffersResult> {
  await ensureSchema();
  const pool = getPool();

  const limit = Math.min(Math.max(params.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const offset = Math.max(params.offset ?? 0, 0);
  const search = params.search?.trim();
  const brand = params.brand?.trim();
  const supplier = params.supplier?.trim();
  const supplierIn = params.supplierIn?.map((s) => s.trim()).filter(Boolean);

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (brand) {
    values.push(brand);
    conditions.push(`brand = $${values.length}`);
  }
  if (supplierIn && supplierIn.length > 0) {
    values.push(supplierIn);
    conditions.push(`supplier = ANY($${values.length}::text[])`);
  } else if (supplier) {
    values.push(supplier);
    conditions.push(`supplier = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    conditions.push(
      `(product ILIKE $${idx} OR brand ILIKE $${idx} OR supplier ILIKE $${idx} OR sku ILIKE $${idx})`
    );
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM offers ${whereClause};`,
    values
  );
  const total = countRows[0]?.count ?? 0;

  const { rows } = await pool.query(
    `SELECT * FROM offers ${whereClause}
     ORDER BY product ASC, price ASC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2};`,
    [...values, limit, offset]
  );

  return { offers: rows.map(mapRow), total };
}

export type DashboardStats = {
  total: number;
  suppliers: number;
  brands: number;
  addedToday: number;
  addedThisWeek: number;
};

// Headline counts for the dashboard's overview cards - one query, so opening
// the dashboard doesn't fire off five separate round trips.
export async function getDashboardStats(): Promise<DashboardStats> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(DISTINCT supplier)::int AS suppliers,
       COUNT(DISTINCT brand)::int AS brands,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '1 day')::int AS added_today,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS added_this_week
     FROM offers;`
  );
  const r = rows[0] ?? {};
  return {
    total: r.total ?? 0,
    suppliers: r.suppliers ?? 0,
    brands: r.brands ?? 0,
    addedToday: r.added_today ?? 0,
    addedThisWeek: r.added_this_week ?? 0,
  };
}

// Most recently added offers, newest first - powers the "Latest offers"
// panel on the dashboard so what just came in is visible at a glance instead
// of being buried in the full list (which sorts by product name, not date).
export async function getRecentOffers(limit = 10): Promise<Offer[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM offers ORDER BY created_at DESC LIMIT $1;`,
    [Math.min(Math.max(limit, 1), 100)]
  );
  return rows.map(mapRow);
}

// Distinct brand names + offer counts, used to power the "browse by brand"
// dropdown/list in the UI instead of making users type a brand out by hand.
export async function listBrands(): Promise<{ brand: string; count: number }[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    // Case-insensitive so e.g. "Malibu C" sorts next to "MAISON MARGIELA"
    // instead of every ALL-CAPS brand grouping before any mixed-case one
    // (plain ASCII/byte ordering puts uppercase letters before lowercase).
    `SELECT brand, COUNT(*)::int AS count FROM offers GROUP BY brand ORDER BY lower(brand) ASC, brand ASC;`
  );
  return rows.map((r) => ({ brand: r.brand, count: r.count }));
}

// Same idea, one row per distinct supplier - powers the "view one supplier"
// filter.
export async function listSuppliers(): Promise<{ supplier: string; count: number }[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    // Case-insensitive - see the matching comment in listBrands().
    `SELECT supplier, COUNT(*)::int AS count FROM offers GROUP BY supplier ORDER BY lower(supplier) ASC, supplier ASC;`
  );
  return rows.map((r) => ({ supplier: r.supplier, count: r.count }));
}

// Same distinct-supplier list as listSuppliers(), but fuzzy-grouped so that
// e.g. "AVOLTA 30.04.26", "AVOLTA PROMO 2506", "AVOLTA SPECIAL 250526" all
// collapse into one "AVOLTA" entry with its raw variants attached. Used by
// the History page's supplier picker so one real-world supplier shows up
// once instead of as dozens of near-duplicate batch-labeled rows.
export async function listSupplierGroups(): Promise<SupplierGroup[]> {
  const suppliers = await listSuppliers();
  return groupSuppliers(suppliers);
}

// Bulk-renames every offer currently filed under one exact supplier string to
// a new one - used from the Matrix page so a corrupted/messy supplier name
// spotted in a column header (e.g. a sheet name or promo label that got used
// as the literal supplier value on import) can be fixed in one action instead
// of editing every affected offer individually.
export async function renameSupplier(from: string, to: string): Promise<number> {
  await ensureSchema();
  const trimmedFrom = from.trim();
  const trimmedTo = to.trim();
  if (!trimmedFrom || !trimmedTo) return 0;
  const { rowCount } = await getPool().query(
    `UPDATE offers SET supplier = $1, updated_at = now() WHERE supplier = $2;`,
    [trimmedTo, trimmedFrom]
  );
  return rowCount ?? 0;
}

// Bulk-renames every offer currently filed under one exact brand string to a
// new one - the brand-level equivalent of renameSupplier, used to fix a
// mistyped or corrupted brand name (or just standardize casing/spelling)
// everywhere it appears in one action, across every supplier.
export async function renameBrand(from: string, to: string): Promise<number> {
  await ensureSchema();
  const trimmedFrom = from.trim();
  const trimmedTo = to.trim();
  if (!trimmedFrom || !trimmedTo) return 0;
  const { rowCount } = await getPool().query(
    `UPDATE offers SET brand = $1, updated_at = now() WHERE brand = $2;`,
    [trimmedTo, trimmedFrom]
  );
  return rowCount ?? 0;
}

// Deletes every offer from one exact supplier string within one brand - the
// "delete this column" action on the Matrix page. Scoped to the brand
// currently being viewed (not every offer that supplier has ever quoted
// across other brands), matching what a matrix column actually represents.
export async function deleteOffersBySupplierAndBrand(
  supplier: string,
  brand: string
): Promise<number> {
  await ensureSchema();
  const trimmedSupplier = supplier.trim();
  const trimmedBrand = brand.trim();
  if (!trimmedSupplier || !trimmedBrand) return 0;
  const { rowCount } = await getPool().query(
    `DELETE FROM offers WHERE supplier = $1 AND brand = $2;`,
    [trimmedSupplier, trimmedBrand]
  );
  return rowCount ?? 0;
}

export type MarketMatch = {
  supplier: string;
  price: number;
  currency: string;
  rrp: number | null;
  createdAt: string;
};

// SKU/EAN/barcode is the most reliable match key when a new price list has
// one, because it's the one field that's actually consistent across
// suppliers even when brand/product text isn't (e.g. a supplier's own file
// abbreviating "HUDA" for "Huda Beauty", or slightly different product
// wording). Matched exact (trimmed, case-insensitive) against the existing
// offers' sku column.
export async function getMarketMatchesBySku(
  skus: string[]
): Promise<Map<string, MarketMatch[]>> {
  const map = new Map<string, MarketMatch[]>();
  const cleaned = Array.from(
    new Set(skus.map((s) => s.trim().toLowerCase()).filter((s) => s !== ""))
  );
  if (cleaned.length === 0) return map;

  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT o.sku, o.supplier, o.price, o.currency, o.rrp, o.created_at
     FROM offers o
     WHERE o.sku IS NOT NULL AND lower(trim(o.sku)) = ANY($1::text[]);`,
    [cleaned]
  );

  for (const row of rows) {
    const key = String(row.sku).trim().toLowerCase();
    const list = map.get(key) ?? [];
    list.push({
      supplier: row.supplier,
      price: Number(row.price),
      currency: row.currency,
      rrp: row.rrp === null ? null : Number(row.rrp),
      createdAt: new Date(row.created_at).toISOString(),
    });
    map.set(key, list);
  }

  return map;
}

// For the "check new prices" upload-and-compare flow: given a list of
// (brand, product) pairs from a freshly uploaded price list, find every
// existing offer for those same brand+product combinations so the caller can
// work out, per row, whether the new price beats what's already on file.
// This is the fallback used when a row has no SKU to match on (see
// getMarketMatchesBySku, which is preferred whenever a SKU is present).
export async function getMarketMatches(
  pairs: { brand: string; product: string }[]
): Promise<Map<string, MarketMatch[]>> {
  const map = new Map<string, MarketMatch[]>();
  if (pairs.length === 0) return map;

  await ensureSchema();
  const brands = pairs.map((p) => p.brand.trim().toLowerCase());
  const products = pairs.map((p) => p.product.trim().toLowerCase());

  const { rows } = await getPool().query(
    `SELECT o.supplier, o.brand, o.product, o.price, o.currency, o.rrp, o.created_at
     FROM offers o
     JOIN (SELECT unnest($1::text[]) AS brand, unnest($2::text[]) AS product) AS keys
       ON lower(o.brand) = keys.brand AND lower(o.product) = keys.product;`,
    [brands, products]
  );

  for (const row of rows) {
    const key = `${String(row.brand).trim().toLowerCase()}|${String(row.product).trim().toLowerCase()}`;
    const list = map.get(key) ?? [];
    list.push({
      supplier: row.supplier,
      price: Number(row.price),
      currency: row.currency,
      rrp: row.rrp === null ? null : Number(row.rrp),
      createdAt: new Date(row.created_at).toISOString(),
    });
    map.set(key, list);
  }

  return map;
}

// Splits free text into the significant words used to fuzzy-match a
// requested inquiry line against the offers table: lowercased, alphanumeric
// tokens of length >= 3 (long enough to be discriminating — "ml", "of", "no"
// would otherwise match almost everything), a short stopword list dropped,
// and capped so a long product description doesn't turn into an
// impossibly-strict AND-of-ten-words query.
const INQUIRY_STOPWORDS = new Set(["the", "and", "for", "with", "new", "set", "pack"]);
const MAX_MATCH_WORDS = 6;

function tokenizeForMatch(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !INQUIRY_STOPWORDS.has(w));
  return Array.from(new Set(words)).slice(0, MAX_MATCH_WORDS);
}

// Cap on offers returned per inquiry line — plenty to compare suppliers on
// one product, without pulling in an unbounded result for a very generic
// search term.
const MAX_MATCHES_PER_ITEM = 50;

// For the sourcing-inquiry matcher: given one requested line (a product a
// client wants a quote for, with an optional brand/SKU), find every existing
// offer that's a plausible match. SKU is checked first and, when found, is
// treated as authoritative (an exact SKU match beats any text guess) — same
// precedence as getMarketMatchesBySku. Falls back to a fuzzy AND-of-words
// text match otherwise, which is the best we can do without a fuzzy-search
// extension: no pg_trgm/full-text index is assumed here, just plain ILIKE.
export async function matchInquiryItem(item: {
  brand?: string | null;
  product: string;
  sku?: string | null;
}): Promise<Offer[]> {
  await ensureSchema();
  const pool = getPool();

  const sku = item.sku?.trim();
  if (sku) {
    const { rows } = await pool.query(
      `SELECT * FROM offers WHERE sku IS NOT NULL AND lower(trim(sku)) = lower($1)
       ORDER BY price ASC LIMIT $2;`,
      [sku, MAX_MATCHES_PER_ITEM]
    );
    if (rows.length > 0) return rows.map(mapRow);
  }

  const brand = item.brand?.trim();
  // When the caller already knows the brand (a real column in their file),
  // match product words against the product field alone and add brand as a
  // separate filter. Without a known brand, the requested text might have
  // the brand folded into the product string (e.g. a plain pasted line like
  // "Chanel No 5 EDP 100ml"), so match against product+brand combined
  // instead — otherwise a brand name sitting in position one of the text
  // would just fail to match anything.
  const words = tokenizeForMatch(item.product);
  if (words.length === 0) return [];

  const values: unknown[] = [];
  const wordConditions = words.map((w) => {
    values.push(`%${w}%`);
    return brand
      ? `product ILIKE $${values.length}`
      : `(product || ' ' || brand) ILIKE $${values.length}`;
  });

  let brandCondition = "";
  if (brand) {
    values.push(`%${brand}%`);
    brandCondition = ` AND brand ILIKE $${values.length}`;
  }

  values.push(MAX_MATCHES_PER_ITEM);
  const { rows } = await pool.query(
    `SELECT * FROM offers WHERE ${wordConditions.join(" AND ")}${brandCondition}
     ORDER BY price ASC LIMIT $${values.length};`,
    values
  );
  return rows.map(mapRow);
}

// One-off data-repair helper: the original bulk import came from a workbook
// where each tab was named after the brand it held, and every row stores
// that tab name as "Source: <tab name>" in `notes`. A handful of source
// sheets had misaligned columns, so the "brand" field ended up with the
// wrong value in several different ways — a barcode number, the full
// product name duplicated in, or just a fragment of the product/line name
// (e.g. "5th Ave NYC Downtown" instead of "Elizabeth Arden"). Rather than
// detect each corruption shape individually, this trusts the tab-derived
// source unconditionally: whenever it disagrees with the current brand, the
// source wins. Safe to run more than once: once brand matches source
// everywhere, it's a no-op.
export async function fixNumericBrands(): Promise<{ fixed: number; brands: string[] }> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `UPDATE offers
       SET brand = trim(regexp_replace(notes, '^Source: ', '')),
           updated_at = now()
     WHERE notes ~ '^Source: '
       AND lower(trim(brand)) <> lower(trim(regexp_replace(notes, '^Source: ', '')))
     RETURNING brand;`
  );
  const brands = Array.from(new Set(rows.map((r) => r.brand as string))).sort();
  return { fixed: rows.length, brands };
}

export async function createOffer(input: OfferInput): Promise<Offer> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `INSERT INTO offers
       (supplier, brand, product, sku, price, currency, rrp, moq, lead_time_days, payment_terms, region, incoterm, market_origin, availability, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *;`,
    [
      input.supplier,
      input.brand,
      input.product,
      input.sku ?? null,
      input.price,
      input.currency ?? "EUR",
      input.rrp ?? null,
      input.moq ?? null,
      input.leadTimeDays ?? null,
      input.paymentTerms ?? null,
      input.region ?? null,
      input.incoterm ?? null,
      input.marketOrigin ?? null,
      input.availability ?? null,
      input.notes ?? null,
    ]
  );
  return mapRow(rows[0]);
}

// Insert many rows with a single multi-row INSERT statement per batch,
// instead of one round-trip per row. This is what makes large CSV imports
// (tens of thousands of rows) finish inside a serverless function's time
// limit instead of timing out.
const IMPORT_BATCH_SIZE = 1000;
const COLS_PER_ROW = 15;

export async function createOffers(inputs: OfferInput[]): Promise<number> {
  await ensureSchema();
  const pool = getPool();
  let count = 0;

  for (let start = 0; start < inputs.length; start += IMPORT_BATCH_SIZE) {
    const batch = inputs.slice(start, start + IMPORT_BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders: string[] = [];

    batch.forEach((input, idx) => {
      const base = idx * COLS_PER_ROW;
      const p = Array.from({ length: COLS_PER_ROW }, (_, k) => `$${base + k + 1}`);
      placeholders.push(`(${p.join(",")})`);
      values.push(
        input.supplier,
        input.brand,
        input.product,
        input.sku ?? null,
        input.price,
        input.currency ?? "EUR",
        input.rrp ?? null,
        input.moq ?? null,
        input.leadTimeDays ?? null,
        input.paymentTerms ?? null,
        input.region ?? null,
        input.incoterm ?? null,
        input.marketOrigin ?? null,
        input.availability ?? null,
        input.notes ?? null
      );
    });

    await pool.query(
      `INSERT INTO offers
         (supplier, brand, product, sku, price, currency, rrp, moq, lead_time_days, payment_terms, region, incoterm, market_origin, availability, notes)
       VALUES ${placeholders.join(",")};`,
      values
    );
    count += batch.length;
  }

  return count;
}

export async function updateOffer(id: number, input: Partial<OfferInput>): Promise<Offer | null> {
  await ensureSchema();
  const pool = getPool();
  const existing = await pool.query(`SELECT * FROM offers WHERE id = $1;`, [id]);
  if (existing.rows.length === 0) return null;
  const current = mapRow(existing.rows[0]);

  const merged: OfferInput = {
    supplier: input.supplier ?? current.supplier,
    brand: input.brand ?? current.brand,
    product: input.product ?? current.product,
    sku: input.sku !== undefined ? input.sku : current.sku,
    price: input.price ?? current.price,
    currency: input.currency ?? current.currency,
    rrp: input.rrp !== undefined ? input.rrp : current.rrp,
    moq: input.moq !== undefined ? input.moq : current.moq,
    leadTimeDays: input.leadTimeDays !== undefined ? input.leadTimeDays : current.leadTimeDays,
    paymentTerms: input.paymentTerms !== undefined ? input.paymentTerms : current.paymentTerms,
    region: input.region !== undefined ? input.region : current.region,
    incoterm: input.incoterm !== undefined ? input.incoterm : current.incoterm,
    marketOrigin: input.marketOrigin !== undefined ? input.marketOrigin : current.marketOrigin,
    availability: input.availability !== undefined ? input.availability : current.availability,
    notes: input.notes !== undefined ? input.notes : current.notes,
  };

  const { rows } = await pool.query(
    `UPDATE offers SET
       supplier = $1, brand = $2, product = $3, sku = $4, price = $5, currency = $6,
       rrp = $7, moq = $8, lead_time_days = $9, payment_terms = $10, region = $11,
       incoterm = $12, market_origin = $13, availability = $14, notes = $15, updated_at = now()
     WHERE id = $16
     RETURNING *;`,
    [
      merged.supplier,
      merged.brand,
      merged.product,
      merged.sku ?? null,
      merged.price,
      merged.currency ?? "EUR",
      merged.rrp ?? null,
      merged.moq ?? null,
      merged.leadTimeDays ?? null,
      merged.paymentTerms ?? null,
      merged.region ?? null,
      merged.incoterm ?? null,
      merged.marketOrigin ?? null,
      merged.availability ?? null,
      merged.notes ?? null,
      id,
    ]
  );
  return mapRow(rows[0]);
}

export async function deleteOffer(id: number): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(`DELETE FROM offers WHERE id = $1;`, [id]);
  return (rowCount ?? 0) > 0;
}
