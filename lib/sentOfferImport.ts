// ---------------------------------------------------------------------------
// Bulk "sent offers" import: turn a spreadsheet of prices already offered to
// clients (client, brand/product, SKU/EAN, price sent) into rows that get
// matched against the offers table for a cost/RRP snapshot (reusing
// matchInquiryItem via /api/inquiry/match - same matching logic Sourcing
// Inquiry already uses) and saved as real quotes/quote_items via the
// existing /api/quotes endpoint. Deliberately mirrors inquiryImport.ts's
// detect-columns-then-build-rows shape for UI/behavioral consistency with
// the other importers in this app.
// ---------------------------------------------------------------------------

export type SentOfferColumnRole =
  | "ignore"
  | "client"
  | "brand"
  | "product"
  | "sku"
  | "price"
  | "currency"
  | "qty"
  | "extra";

export const SENT_OFFER_ROLE_LABELS: Record<SentOfferColumnRole, string> = {
  ignore: "Ignore",
  client: "Client",
  brand: "Brand",
  product: "Product name",
  sku: "SKU / EAN / Barcode",
  price: "Price sent to client",
  currency: "Currency",
  qty: "Quantity",
  extra: "Extra (kept as note)",
};

export type SentOfferColumnMapping = {
  index: number;
  header: string;
  role: SentOfferColumnRole;
};

const KEYWORDS: Partial<Record<SentOfferColumnRole, string[]>> = {
  client: ["client", "customer", "buyer", "account", "cliente"],
  sku: ["ean", "gtin", "barcode", "upc", "sku", "codigo", "código", "product code", "item code", "reference", "ref"],
  brand: ["brand", "marca"],
  qty: ["qty", "quantity", "units", "pieces", "pcs", "amount", "cantidad"],
  currency: ["currency", "curr", "ccy", "moneda", "divisa"],
  // "sent"/"offered"/"quoted" checked as compound phrases before the bare
  // "price" keyword, same reasoning as inquiryImport.ts's cost-vs-targetPrice
  // split - otherwise a generic "Price" header would win by keyword order
  // alone regardless of which is actually the more specific match.
  price: [
    "price sent",
    "price offered",
    "price quoted",
    "sell price",
    "sale price",
    "client price",
    "offer price",
    "quoted price",
    "precio",
    "price",
  ],
  product: ["product", "description", "name", "article", "item", "title"],
};

const ROLE_PRIORITY: SentOfferColumnRole[] = ["client", "sku", "brand", "qty", "currency", "price", "product"];

function normalize(h: string): string {
  return h
    .toLowerCase()
    .trim()
    .replace(/[_\-/]+/g, " ")
    .replace(/\s+/g, " ");
}

export function detectSentOfferColumns(header: string[]): SentOfferColumnMapping[] {
  const used = new Set<SentOfferColumnRole>();
  return header.map((raw, index) => {
    const h = normalize(raw);
    if (h === "") return { index, header: raw, role: "ignore" as SentOfferColumnRole };
    for (const role of ROLE_PRIORITY) {
      if (used.has(role)) continue;
      const keywords = KEYWORDS[role] ?? [];
      if (keywords.some((kw) => h.includes(kw))) {
        used.add(role);
        return { index, header: raw, role };
      }
    }
    return { index, header: raw, role: "ignore" as SentOfferColumnRole };
  });
}

// Same reasoning as inquiryImport's findInquiryHeaderRow: scores the first
// few rows by how many cells match a known keyword, returns -1 (no header)
// rather than guessing wrong on a file that's just raw data from row one.
export function findSentOfferHeaderRow(rows: string[][]): number {
  const allKeywords = Object.values(KEYWORDS).flat();
  let bestIndex = -1;
  let bestScore = 0;
  const scanLimit = Math.min(5, rows.length);
  for (let i = 0; i < scanLimit; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c.trim() === "")) continue;
    let score = 0;
    for (const cell of row) {
      const h = normalize(cell);
      if (h && allKeywords.some((kw) => h.includes(kw))) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

export type SentOfferItem = {
  raw: string;
  client: string;
  brand: string | null;
  product: string;
  sku: string | null;
  qty: number | null;
  price: number;
  currency: string | null;
};

export type BuildSentOfferResult = {
  items: SentOfferItem[];
  errors: { line: number; message: string }[];
};

export function buildSentOfferItems(
  rows: string[][],
  headerRowIndex: number,
  mapping: SentOfferColumnMapping[]
): BuildSentOfferResult {
  const errors: BuildSentOfferResult["errors"] = [];
  const items: SentOfferItem[] = [];

  const firstByRole = (role: SentOfferColumnRole) => mapping.find((m) => m.role === role);
  const clientCol = firstByRole("client");
  const productCol = firstByRole("product");
  const brandCol = firstByRole("brand");
  const skuCol = firstByRole("sku");
  const qtyCol = firstByRole("qty");
  const priceCol = firstByRole("price");
  const currencyCol = firstByRole("currency");

  const dataRows = headerRowIndex >= 0 ? rows.slice(headerRowIndex + 1) : rows;

  dataRows.forEach((r, i) => {
    const line = (headerRowIndex >= 0 ? headerRowIndex + 2 : 1) + i;
    if (r.every((c) => c.trim() === "")) return;

    const client = clientCol ? r[clientCol.index]?.trim() : "";
    if (!client) {
      errors.push({ line, message: "No client name found — row skipped." });
      return;
    }

    const product = (productCol ? r[productCol.index] : null)?.trim() || "";
    const sku = skuCol ? r[skuCol.index]?.trim() || null : null;
    if (!product && !sku) {
      errors.push({ line, message: "No product name or SKU/EAN found — row skipped." });
      return;
    }

    const priceRaw = priceCol ? r[priceCol.index]?.trim() : "";
    const priceCleaned = priceRaw ? priceRaw.replace(/[^\d.,]/g, "").replace(",", ".") : "";
    const price = priceCleaned ? Number(priceCleaned) : NaN;
    if (!Number.isFinite(price)) {
      errors.push({ line, message: "No valid price found — row skipped." });
      return;
    }

    const brand = brandCol ? r[brandCol.index]?.trim() || null : null;
    const qtyRaw = qtyCol ? r[qtyCol.index]?.trim() : "";
    const qty = qtyRaw ? Number(qtyRaw.replace(",", ".")) : null;
    const currency = currencyCol ? r[currencyCol.index]?.trim().toUpperCase() || null : null;

    items.push({
      raw: r.join(" "),
      client,
      brand,
      // Fall back to the SKU itself as a display label when there's no
      // product name column - quote_items.product is NOT NULL, so an
      // EAN-only upload still needs something to save there.
      product: product || sku || "Unnamed product",
      sku,
      qty: qty !== null && Number.isFinite(qty) ? qty : null,
      price,
      currency,
    });
  });

  return { items, errors };
}
