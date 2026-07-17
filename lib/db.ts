import { Pool } from "pg";
import { Offer, OfferInput } from "./types";
import { groupSuppliers, SupplierGroup } from "./supplierNormalize";
import { groupBrands, BrandGroup } from "./brandNormalize";

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
        ALTER TABLE offers ALTER COLUMN moq TYPE TEXT USING moq::text;
        -- Link to the original uploaded price-list file this batch of offers
        -- came from (e.g. a Dropbox/Drive share link), so the source
        -- document can be pulled up later from an offer's detail view
        -- instead of hunting through downloads. Set per-import-batch, but
        -- editable per-offer afterward like any other field.
        ALTER TABLE offers ADD COLUMN IF NOT EXISTS source_file_url TEXT;
        -- Free-text stock quantity (e.g. "500 units", "1200 pcs", "limited"),
        -- same treatment as moq/lead_time_days - only meaningful alongside
        -- availability = 'In Stock', but left free text since suppliers
        -- phrase it inconsistently and a preorder/backorder row may still
        -- carry a note here.
        ALTER TABLE offers ADD COLUMN IF NOT EXISTS stock_qty TEXT;
        -- Sales side: a quote is a customer-facing offer built from one or
        -- more sourced items (each optionally tied back to the supplier
        -- offer it was costed from). Kept as its own table rather than
        -- reusing "offers" since the direction, parties, and fields (sell
        -- price, margin, deal status) are fundamentally different.
        CREATE TABLE IF NOT EXISTS quotes (
          id SERIAL PRIMARY KEY,
          customer_name TEXT NOT NULL,
          customer_type TEXT,
          region TEXT,
          status TEXT NOT NULL DEFAULT 'quoted',
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS quote_items (
          id SERIAL PRIMARY KEY,
          quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
          -- Soft reference to the sourced offer this line was costed from.
          -- ON DELETE SET NULL so deleting/editing an old offer later never
          -- breaks a saved quote - cost_price/cost_currency below are
          -- snapshotted at save time precisely so the quote stays accurate
          -- even if the underlying offer changes or disappears.
          offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL,
          brand TEXT,
          product TEXT NOT NULL,
          sku TEXT,
          qty NUMERIC,
          supplier TEXT,
          cost_price NUMERIC,
          cost_currency TEXT,
          sell_price NUMERIC,
          sell_currency TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- RRP snapshotted from the sourced offer at save time (same
        -- snapshot treatment as cost_price - stays accurate even if the
        -- underlying offer's RRP is edited later). Lets a quote line show
        -- how far below RRP both the buy and the sell sit, not just the
        -- buy-to-sell margin.
        ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS rrp NUMERIC;
        -- Deal-level logistics costs (not per line item - a shipment's
        -- inbound/outbound freight and any samples sent are one lump cost
        -- for the whole quote, not attributable to one product). Filled in
        -- once terms firm up, so nullable and edited after the quote is
        -- first saved from Sourcing Inquiry.
        ALTER TABLE quotes ADD COLUMN IF NOT EXISTS shipping_in_cost NUMERIC;
        ALTER TABLE quotes ADD COLUMN IF NOT EXISTS shipping_in_currency TEXT;
        ALTER TABLE quotes ADD COLUMN IF NOT EXISTS shipping_out_cost NUMERIC;
        ALTER TABLE quotes ADD COLUMN IF NOT EXISTS shipping_out_currency TEXT;
        ALTER TABLE quotes ADD COLUMN IF NOT EXISTS samples_cost NUMERIC;
        ALTER TABLE quotes ADD COLUMN IF NOT EXISTS samples_currency TEXT;
        -- Real audit trail for offer pricing. Before this table existed,
        -- editing a price via EditOfferModal silently overwrote the offers
        -- row in place with no trace of what it used to be - the "History"
        -- page only ever showed history to the extent that a *re-import*
        -- created a brand-new offers row for the same SKU. This table
        -- captures a snapshot every time a single offer is created or has
        -- its price/currency/RRP changed via updateOffer, so a manual edit
        -- is no longer a silent overwrite. Deliberately NOT populated by the
        -- bulk createOffers() import path - each import already creates its
        -- own new offers row, which the existing History page already
        -- surfaces as a historical entry, so duplicating that here would
        -- just slow down large imports for no new information.
        CREATE TABLE IF NOT EXISTS offer_price_history (
          id SERIAL PRIMARY KEY,
          offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
          price NUMERIC NOT NULL,
          currency TEXT NOT NULL,
          rrp NUMERIC,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS offer_price_history_offer_id_idx ON offer_price_history(offer_id);`
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
    stockQty: row.stock_qty,
    notes: row.notes,
    sourceFileUrl: row.source_file_url,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export type ListOffersParams = {
  search?: string;
  brand?: string;
  // Exact-match against any of these raw brand values at once - used by the
  // Matrix page to pull every offer for a fuzzy-matched group of brand name
  // variants (see lib/brandNormalize.ts, e.g. "ANNEMARIE BORLIND" vs.
  // "Annemarie Börlind") in one query. Takes precedence over `brand` when
  // both are set.
  brandIn?: string[];
  supplier?: string;
  // Exact-match against any of these raw supplier values at once - used by
  // the History page to pull every offer for a fuzzy-matched group of
  // supplier name variants (see lib/supplierNormalize.ts) in one query.
  // Takes precedence over `supplier` when both are set.
  supplierIn?: string[];
  // When true, excludes rows from the original one-off bulk CSV import. Those
  // rows all carry a `notes` value of the form "Source: <brand tab name>"
  // (see fixNumericBrands below) - a marker that normal day-to-day imports
  // (Check New Prices, manual entry, edits) never produce organically. Used
  // by the All Offers page so the old bulk import doesn't clutter the main
  // table by default.
  excludeBulkImport?: boolean;
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
  const brandIn = params.brandIn?.map((b) => b.trim()).filter(Boolean);
  const supplier = params.supplier?.trim();
  const supplierIn = params.supplierIn?.map((s) => s.trim()).filter(Boolean);
  const excludeBulkImport = params.excludeBulkImport === true;

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (brandIn && brandIn.length > 0) {
    values.push(brandIn);
    conditions.push(`brand = ANY($${values.length}::text[])`);
  } else if (brand) {
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
  if (excludeBulkImport) {
    // Rows from the original one-off bulk CSV import all carry a notes value
    // of "Source: <brand tab name>" - see fixNumericBrands below.
    conditions.push(`(notes IS NULL OR notes NOT ILIKE 'Source:%')`);
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

// Same distinct-brand list as listBrands(), but fuzzy-grouped so that e.g.
// "ANNEMARIE BORLIND", "Annemarie Börlind", and "annemarie borlind" all
// collapse into one entry with its raw case/diacritic variants attached.
// Used by the Matrix page's brand picker so one real-world brand shows up
// once instead of as several near-duplicate spelling variants.
export async function listBrandGroups(): Promise<BrandGroup[]> {
  const brands = await listBrands();
  return groupBrands(brands);
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
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO offers
       (supplier, brand, product, sku, price, currency, rrp, moq, lead_time_days, payment_terms, region, incoterm, market_origin, availability, stock_qty, notes, source_file_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
      input.stockQty ?? null,
      input.notes ?? null,
      input.sourceFileUrl ?? null,
    ]
  );
  const offer = mapRow(rows[0]);
  // Baseline entry for the price-history trail - see offer_price_history in
  // ensureSchema for why this only covers single-offer creation, not bulk
  // import.
  await pool.query(
    `INSERT INTO offer_price_history (offer_id, price, currency, rrp) VALUES ($1, $2, $3, $4);`,
    [offer.id, offer.price, offer.currency, offer.rrp]
  );
  return offer;
}

// Insert many rows with a single multi-row INSERT statement per batch,
// instead of one round-trip per row. This is what makes large CSV imports
// (tens of thousands of rows) finish inside a serverless function's time
// limit instead of timing out.
const IMPORT_BATCH_SIZE = 1000;
const COLS_PER_ROW = 17;

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
        input.stockQty ?? null,
        input.notes ?? null,
        input.sourceFileUrl ?? null
      );
    });

    await pool.query(
      `INSERT INTO offers
         (supplier, brand, product, sku, price, currency, rrp, moq, lead_time_days, payment_terms, region, incoterm, market_origin, availability, stock_qty, notes, source_file_url)
       VALUES ${placeholders.join(",")};`,
      values
    );
    count += batch.length;
  }

  return count;
}

export type DailyReportBrand = { brand: string; count: number };
export type DailyReportSupplier = { supplier: string; offerCount: number; brands: DailyReportBrand[] };
export type DailyReport = {
  date: string;
  totalOffers: number;
  supplierCount: number;
  brandCount: number;
  suppliers: DailyReportSupplier[];
};

// Report of what came in on one calendar day - for each supplier active that
// day, which brands they quoted and how many offers, busiest supplier first.
// Powers the "Daily report" panel on the All Offers page so the user can see
// "what came in today, from whom, for which brands" without paging through
// the full offers table (which sorts by product name, not date, and can run
// into the tens of thousands of rows). `date` compares against
// created_at::date, i.e. the database session's timezone (UTC on Neon by
// default) - close enough for a daily digest.
export async function getDailyReport(date: string): Promise<DailyReport> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT supplier, brand, COUNT(*)::int AS count
     FROM offers
     WHERE created_at::date = $1::date
     GROUP BY supplier, brand
     ORDER BY supplier ASC, brand ASC;`,
    [date]
  );

  const bySupplier = new Map<string, DailyReportBrand[]>();
  const brandSet = new Set<string>();
  for (const row of rows) {
    const brands = bySupplier.get(row.supplier) ?? [];
    brands.push({ brand: row.brand, count: row.count });
    bySupplier.set(row.supplier, brands);
    brandSet.add(row.brand);
  }

  const suppliers: DailyReportSupplier[] = Array.from(bySupplier.entries())
    .map(([supplier, brands]) => ({
      supplier,
      offerCount: brands.reduce((sum, b) => sum + b.count, 0),
      brands,
    }))
    // Busiest supplier first - whoever sent the most today is the one worth
    // checking in on, not just whoever sorts first alphabetically.
    .sort((a, b) => b.offerCount - a.offerCount);

  return {
    date,
    totalOffers: suppliers.reduce((sum, s) => sum + s.offerCount, 0),
    supplierCount: suppliers.length,
    brandCount: brandSet.size,
    suppliers,
  };
}

export type ReportDateCount = { date: string; count: number };

// Distinct calendar days that have at least one offer, newest first - powers
// the daily-report date picker's "days with data" hint, so picking a day
// that turns out empty doesn't leave the user guessing what range actually
// has anything in it. Capped well past any realistic lookback window.
const MAX_REPORT_DATES = 180;

export async function listReportDates(): Promise<ReportDateCount[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
     FROM offers
     GROUP BY created_at::date
     ORDER BY created_at::date DESC
     LIMIT $1;`,
    [MAX_REPORT_DATES]
  );
  return rows.map((r) => ({ date: r.date, count: r.count }));
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
    stockQty: input.stockQty !== undefined ? input.stockQty : current.stockQty,
    notes: input.notes !== undefined ? input.notes : current.notes,
    sourceFileUrl: input.sourceFileUrl !== undefined ? input.sourceFileUrl : current.sourceFileUrl,
  };

  const { rows } = await pool.query(
    `UPDATE offers SET
       supplier = $1, brand = $2, product = $3, sku = $4, price = $5, currency = $6,
       rrp = $7, moq = $8, lead_time_days = $9, payment_terms = $10, region = $11,
       incoterm = $12, market_origin = $13, availability = $14, stock_qty = $15, notes = $16, source_file_url = $17, updated_at = now()
     WHERE id = $18
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
      merged.stockQty ?? null,
      merged.notes ?? null,
      merged.sourceFileUrl ?? null,
      id,
    ]
  );
  const updated = mapRow(rows[0]);

  // Only log a new history entry when something price-relevant actually
  // changed - editing, say, just the notes or MOQ on every save would
  // otherwise flood the trail with identical price/RRP entries.
  const priceChanged =
    updated.price !== current.price || updated.currency !== current.currency || updated.rrp !== current.rrp;
  if (priceChanged) {
    await pool.query(
      `INSERT INTO offer_price_history (offer_id, price, currency, rrp) VALUES ($1, $2, $3, $4);`,
      [updated.id, updated.price, updated.currency, updated.rrp]
    );
  }

  return updated;
}

export type OfferPriceHistoryEntry = {
  id: number;
  price: number;
  currency: string;
  rrp: number | null;
  recordedAt: string;
};

// Chronological (oldest first) price/RRP trail for a single offer - see
// offer_price_history in ensureSchema. Powers the "Price history" section in
// EditOfferModal so a price edit is no longer a silent, unrecoverable
// overwrite.
export async function getOfferPriceHistory(offerId: number): Promise<OfferPriceHistoryEntry[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM offer_price_history WHERE offer_id = $1 ORDER BY recorded_at ASC, id ASC;`,
    [offerId]
  );
  return rows.map((r) => ({
    id: r.id,
    price: Number(r.price),
    currency: r.currency,
    rrp: r.rrp === null ? null : Number(r.rrp),
    recordedAt: new Date(r.recorded_at).toISOString(),
  }));
}

export async function deleteOffer(id: number): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(`DELETE FROM offers WHERE id = $1;`, [id]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Sales side: quotes built from the Sourcing Inquiry flow. A quote is a
// customer-facing offer with one or more line items, each snapshotting the
// sourced cost (supplier/price/currency, optionally tied back to the offer
// it came from) alongside the proposed sell price, so margin stays visible
// and accurate even as the underlying supplier offers keep changing.
// ---------------------------------------------------------------------------

export const QUOTE_STATUSES = ["quoted", "won", "lost", "shipped"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export type QuoteItemInput = {
  offerId?: number | null;
  brand?: string | null;
  product: string;
  sku?: string | null;
  qty?: number | null;
  supplier?: string | null;
  costPrice?: number | null;
  costCurrency?: string | null;
  sellPrice?: number | null;
  sellCurrency?: string | null;
  // Snapshotted from the sourced offer at save time - see the schema
  // comment above. Null when the offer had no RRP on file.
  rrp?: number | null;
};

export type QuoteItem = {
  id: number;
  offerId: number | null;
  brand: string | null;
  product: string;
  sku: string | null;
  qty: number | null;
  supplier: string | null;
  costPrice: number | null;
  costCurrency: string | null;
  sellPrice: number | null;
  sellCurrency: string | null;
  rrp: number | null;
  createdAt: string;
};

export type QuoteInput = {
  customerName: string;
  customerType?: string | null;
  region?: string | null;
  status?: QuoteStatus;
  notes?: string | null;
  items: QuoteItemInput[];
  // Deal-level logistics costs - see schema comment above. Optional/nullable
  // since these are usually only known after the initial quote is saved.
  shippingInCost?: number | null;
  shippingInCurrency?: string | null;
  shippingOutCost?: number | null;
  shippingOutCurrency?: string | null;
  samplesCost?: number | null;
  samplesCurrency?: string | null;
};

export type Quote = {
  id: number;
  customerName: string;
  customerType: string | null;
  region: string | null;
  status: QuoteStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  items: QuoteItem[];
  shippingInCost: number | null;
  shippingInCurrency: string | null;
  shippingOutCost: number | null;
  shippingOutCurrency: string | null;
  samplesCost: number | null;
  samplesCurrency: string | null;
};

export type QuoteSummary = {
  id: number;
  customerName: string;
  customerType: string | null;
  region: string | null;
  status: QuoteStatus;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapQuoteItemRow(row: any): QuoteItem {
  return {
    id: row.id,
    offerId: row.offer_id,
    brand: row.brand,
    product: row.product,
    sku: row.sku,
    qty: row.qty === null ? null : Number(row.qty),
    supplier: row.supplier,
    costPrice: row.cost_price === null ? null : Number(row.cost_price),
    costCurrency: row.cost_currency,
    sellPrice: row.sell_price === null ? null : Number(row.sell_price),
    sellCurrency: row.sell_currency,
    rrp: row.rrp === null ? null : Number(row.rrp),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapQuoteRow(q: any, items: QuoteItem[]): Quote {
  return {
    id: q.id,
    customerName: q.customer_name,
    customerType: q.customer_type,
    region: q.region,
    status: q.status,
    notes: q.notes,
    createdAt: new Date(q.created_at).toISOString(),
    updatedAt: new Date(q.updated_at).toISOString(),
    items,
    shippingInCost: q.shipping_in_cost === null || q.shipping_in_cost === undefined ? null : Number(q.shipping_in_cost),
    shippingInCurrency: q.shipping_in_currency ?? null,
    shippingOutCost:
      q.shipping_out_cost === null || q.shipping_out_cost === undefined ? null : Number(q.shipping_out_cost),
    shippingOutCurrency: q.shipping_out_currency ?? null,
    samplesCost: q.samples_cost === null || q.samples_cost === undefined ? null : Number(q.samples_cost),
    samplesCurrency: q.samples_currency ?? null,
  };
}

export async function createQuote(input: QuoteInput): Promise<Quote> {
  await ensureSchema();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: quoteRows } = await client.query(
      `INSERT INTO quotes
         (customer_name, customer_type, region, status, notes,
          shipping_in_cost, shipping_in_currency, shipping_out_cost, shipping_out_currency,
          samples_cost, samples_currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *;`,
      [
        input.customerName.trim(),
        input.customerType?.trim() || null,
        input.region?.trim() || null,
        input.status ?? "quoted",
        input.notes?.trim() || null,
        input.shippingInCost ?? null,
        input.shippingInCurrency ?? null,
        input.shippingOutCost ?? null,
        input.shippingOutCurrency ?? null,
        input.samplesCost ?? null,
        input.samplesCurrency ?? null,
      ]
    );
    const quoteId = quoteRows[0].id;

    const items: QuoteItem[] = [];
    for (const item of input.items) {
      const { rows: itemRows } = await client.query(
        `INSERT INTO quote_items
           (quote_id, offer_id, brand, product, sku, qty, supplier, cost_price, cost_currency, sell_price, sell_currency, rrp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *;`,
        [
          quoteId,
          item.offerId ?? null,
          item.brand ?? null,
          item.product,
          item.sku ?? null,
          item.qty ?? null,
          item.supplier ?? null,
          item.costPrice ?? null,
          item.costCurrency ?? null,
          item.sellPrice ?? null,
          item.sellCurrency ?? null,
          item.rrp ?? null,
        ]
      );
      items.push(mapQuoteItemRow(itemRows[0]));
    }
    await client.query("COMMIT");

    return mapQuoteRow(quoteRows[0], items);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listQuotes(): Promise<QuoteSummary[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT q.*, COUNT(i.id)::int AS item_count
     FROM quotes q
     LEFT JOIN quote_items i ON i.quote_id = q.id
     GROUP BY q.id
     ORDER BY q.created_at DESC;`
  );
  return rows.map((r) => ({
    id: r.id,
    customerName: r.customer_name,
    customerType: r.customer_type,
    region: r.region,
    status: r.status,
    itemCount: r.item_count,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function getQuote(id: number): Promise<Quote | null> {
  await ensureSchema();
  const pool = getPool();
  const { rows: quoteRows } = await pool.query(`SELECT * FROM quotes WHERE id = $1;`, [id]);
  if (quoteRows.length === 0) return null;
  const { rows: itemRows } = await pool.query(
    `SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY id ASC;`,
    [id]
  );
  const q = quoteRows[0];
  return mapQuoteRow(q, itemRows.map(mapQuoteItemRow));
}

export async function updateQuote(
  id: number,
  input: Partial<
    Pick<
      QuoteInput,
      | "status"
      | "notes"
      | "customerName"
      | "customerType"
      | "region"
      | "shippingInCost"
      | "shippingInCurrency"
      | "shippingOutCost"
      | "shippingOutCurrency"
      | "samplesCost"
      | "samplesCurrency"
    >
  >
): Promise<Quote | null> {
  await ensureSchema();
  const pool = getPool();
  const existing = await pool.query(`SELECT * FROM quotes WHERE id = $1;`, [id]);
  if (existing.rows.length === 0) return null;
  const current = existing.rows[0];

  const merged = {
    customerName: input.customerName ?? current.customer_name,
    customerType: input.customerType !== undefined ? input.customerType : current.customer_type,
    region: input.region !== undefined ? input.region : current.region,
    status: input.status ?? current.status,
    notes: input.notes !== undefined ? input.notes : current.notes,
    shippingInCost: input.shippingInCost !== undefined ? input.shippingInCost : current.shipping_in_cost,
    shippingInCurrency:
      input.shippingInCurrency !== undefined ? input.shippingInCurrency : current.shipping_in_currency,
    shippingOutCost: input.shippingOutCost !== undefined ? input.shippingOutCost : current.shipping_out_cost,
    shippingOutCurrency:
      input.shippingOutCurrency !== undefined ? input.shippingOutCurrency : current.shipping_out_currency,
    samplesCost: input.samplesCost !== undefined ? input.samplesCost : current.samples_cost,
    samplesCurrency: input.samplesCurrency !== undefined ? input.samplesCurrency : current.samples_currency,
  };

  await pool.query(
    `UPDATE quotes SET
       customer_name = $1, customer_type = $2, region = $3, status = $4, notes = $5,
       shipping_in_cost = $6, shipping_in_currency = $7, shipping_out_cost = $8, shipping_out_currency = $9,
       samples_cost = $10, samples_currency = $11, updated_at = now()
     WHERE id = $12;`,
    [
      merged.customerName,
      merged.customerType,
      merged.region,
      merged.status,
      merged.notes,
      merged.shippingInCost ?? null,
      merged.shippingInCurrency ?? null,
      merged.shippingOutCost ?? null,
      merged.shippingOutCurrency ?? null,
      merged.samplesCost ?? null,
      merged.samplesCurrency ?? null,
      id,
    ]
  );

  return getQuote(id);
}

export async function deleteQuote(id: number): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(`DELETE FROM quotes WHERE id = $1;`, [id]);
  return (rowCount ?? 0) > 0;
}

// Adds one more line item to an already-saved quote (e.g. the customer asks
// to add a product after the quote went out). Returns null if the quote
// itself doesn't exist, so the route can 404 instead of hitting a foreign
// key error on insert.
export async function addQuoteItem(quoteId: number, input: QuoteItemInput): Promise<QuoteItem | null> {
  await ensureSchema();
  const pool = getPool();
  const quoteExists = await pool.query(`SELECT id FROM quotes WHERE id = $1;`, [quoteId]);
  if (quoteExists.rows.length === 0) return null;

  const { rows } = await pool.query(
    `INSERT INTO quote_items
       (quote_id, offer_id, brand, product, sku, qty, supplier, cost_price, cost_currency, sell_price, sell_currency, rrp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *;`,
    [
      quoteId,
      input.offerId ?? null,
      input.brand ?? null,
      input.product,
      input.sku ?? null,
      input.qty ?? null,
      input.supplier ?? null,
      input.costPrice ?? null,
      input.costCurrency ?? null,
      input.sellPrice ?? null,
      input.sellCurrency ?? null,
      input.rrp ?? null,
    ]
  );
  await pool.query(`UPDATE quotes SET updated_at = now() WHERE id = $1;`, [quoteId]);
  return mapQuoteItemRow(rows[0]);
}

// Edits one line item on a saved quote - e.g. correcting a qty typo, moving
// to a cheaper supplier that was sourced after the quote was first saved, or
// adjusting the sell price mid-negotiation. Scoped to (quoteId, itemId) so a
// stale/guessed item id from a different quote can never be edited by
// mistake. Returns null if the item isn't found under that quote.
export async function updateQuoteItem(
  quoteId: number,
  itemId: number,
  input: Partial<QuoteItemInput>
): Promise<QuoteItem | null> {
  await ensureSchema();
  const pool = getPool();
  const existing = await pool.query(
    `SELECT * FROM quote_items WHERE id = $1 AND quote_id = $2;`,
    [itemId, quoteId]
  );
  if (existing.rows.length === 0) return null;
  const current = existing.rows[0];

  const merged = {
    offerId: input.offerId !== undefined ? input.offerId : current.offer_id,
    brand: input.brand !== undefined ? input.brand : current.brand,
    product: input.product ?? current.product,
    sku: input.sku !== undefined ? input.sku : current.sku,
    qty: input.qty !== undefined ? input.qty : current.qty === null ? null : Number(current.qty),
    supplier: input.supplier !== undefined ? input.supplier : current.supplier,
    costPrice:
      input.costPrice !== undefined ? input.costPrice : current.cost_price === null ? null : Number(current.cost_price),
    costCurrency: input.costCurrency !== undefined ? input.costCurrency : current.cost_currency,
    sellPrice:
      input.sellPrice !== undefined ? input.sellPrice : current.sell_price === null ? null : Number(current.sell_price),
    sellCurrency: input.sellCurrency !== undefined ? input.sellCurrency : current.sell_currency,
    rrp: input.rrp !== undefined ? input.rrp : current.rrp === null ? null : Number(current.rrp),
  };

  const { rows } = await pool.query(
    `UPDATE quote_items SET
       offer_id = $1, brand = $2, product = $3, sku = $4, qty = $5, supplier = $6,
       cost_price = $7, cost_currency = $8, sell_price = $9, sell_currency = $10, rrp = $11
     WHERE id = $12 AND quote_id = $13
     RETURNING *;`,
    [
      merged.offerId ?? null,
      merged.brand ?? null,
      merged.product,
      merged.sku ?? null,
      merged.qty ?? null,
      merged.supplier ?? null,
      merged.costPrice ?? null,
      merged.costCurrency ?? null,
      merged.sellPrice ?? null,
      merged.sellCurrency ?? null,
      merged.rrp ?? null,
      itemId,
      quoteId,
    ]
  );
  await pool.query(`UPDATE quotes SET updated_at = now() WHERE id = $1;`, [quoteId]);
  return mapQuoteItemRow(rows[0]);
}

// Removes one line item from a saved quote (e.g. the customer dropped a
// product). Scoped to (quoteId, itemId) for the same reason as
// updateQuoteItem above.
export async function deleteQuoteItem(quoteId: number, itemId: number): Promise<boolean> {
  await ensureSchema();
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM quote_items WHERE id = $1 AND quote_id = $2;`,
    [itemId, quoteId]
  );
  if ((rowCount ?? 0) > 0) {
    await pool.query(`UPDATE quotes SET updated_at = now() WHERE id = $1;`, [quoteId]);
  }
  return (rowCount ?? 0) > 0;
}
