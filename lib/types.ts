export type OfferInput = {
  supplier: string;
  brand: string;
  product: string;
  sku?: string | null;
  price: number;
  currency?: string;
  rrp?: number | null;
  // Free text, not a strict integer - suppliers routinely quote this as
  // "500 (neg.)", "2-3 cartons", "no minimum", etc., not a single number.
  moq?: string | null;
  // Free text, not a strict day count - suppliers routinely quote this as
  // "6 weeks", "10-15 days", "immediate", etc., not a single integer.
  leadTimeDays?: string | null;
  paymentTerms?: string | null;
  region?: string | null;
  // Shipping/pricing term, e.g. "EXW Dubai", "FOB", "DDP" — matters for
  // comparing true landed cost, not just sticker price.
  incoterm?: string | null;
  // "EU" | "Non-EU" | "Unknown" — whether this batch was placed on the
  // EU/EEA market with the brand owner's consent. This is the key fact for
  // trademark-exhaustion risk on parallel imports into the EU.
  marketOrigin?: string | null;
  // Stock status, e.g. "In Stock", "Preorder", "Backorder", "Out of Stock" -
  // free text (like paymentTerms/region) so unusual supplier phrasing isn't
  // lost, but the import wizard normalizes common variants so filtering by
  // "In Stock" or "Preorder" actually groups things consistently.
  availability?: string | null;
  notes?: string | null;
  // Link to the original uploaded price-list file this offer came from (e.g.
  // a Dropbox/Drive share link), so the source document can be pulled up
  // later from any offer detail view instead of hunting through downloads.
  // Applied per-batch at import time (see BuildOptions.sourceFileUrl in
  // lib/smartImport.ts) but editable per-offer afterward too.
  sourceFileUrl?: string | null;
};

export type Offer = {
  id: number;
  supplier: string;
  brand: string;
  product: string;
  sku: string | null;
  price: number;
  currency: string;
  rrp: number | null;
  moq: string | null;
  leadTimeDays: string | null;
  paymentTerms: string | null;
  region: string | null;
  incoterm: string | null;
  marketOrigin: string | null;
  availability: string | null;
  notes: string | null;
  sourceFileUrl: string | null;
  createdAt: string;
};

export const CSV_HEADERS = [
  "supplier",
  "brand",
  "product",
  "sku",
  "price",
  "currency",
  "rrp",
  "moq",
  "leadTimeDays",
  "paymentTerms",
  "region",
  "incoterm",
  "marketOrigin",
  "availability",
  "notes",
  "sourceFileUrl",
] as const;
