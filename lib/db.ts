import { Pool } from "pg";
import { Offer, OfferInput } from "./types";

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
          moq INTEGER,
          lead_time_days INTEGER,
          payment_terms TEXT,
          region TEXT,
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );`
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
    moq: row.moq === null ? null : Number(row.moq),
    leadTimeDays: row.lead_time_days === null ? null : Number(row.lead_time_days),
    paymentTerms: row.payment_terms,
    region: row.region,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listOffers(): Promise<Offer[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM offers ORDER BY product ASC, price ASC;`
  );
  return rows.map(mapRow);
}

export async function createOffer(input: OfferInput): Promise<Offer> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `INSERT INTO offers
       (supplier, brand, product, sku, price, currency, rrp, moq, lead_time_days, payment_terms, region, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
      input.notes ?? null,
    ]
  );
  return mapRow(rows[0]);
}

export async function createOffers(inputs: OfferInput[]): Promise<number> {
  await ensureSchema();
  const pool = getPool();
  let count = 0;
  for (const input of inputs) {
    await pool.query(
      `INSERT INTO offers
         (supplier, brand, product, sku, price, currency, rrp, moq, lead_time_days, payment_terms, region, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12);`,
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
        input.notes ?? null,
      ]
    );
    count++;
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
    notes: input.notes !== undefined ? input.notes : current.notes,
  };

  const { rows } = await pool.query(
    `UPDATE offers SET
       supplier = $1, brand = $2, product = $3, sku = $4, price = $5, currency = $6,
       rrp = $7, moq = $8, lead_time_days = $9, payment_terms = $10, region = $11,
       notes = $12, updated_at = now()
     WHERE id = $13
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
