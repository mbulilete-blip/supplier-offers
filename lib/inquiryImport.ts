// ---------------------------------------------------------------------------
// Sourcing inquiry import: turn a client's "who has this and at what price"
// list into structured items we can match against our own offers table.
//
// Deliberately mirrors the smartImport.ts pattern (detect columns, let the
// user confirm/edit the mapping, then build rows) rather than a separate
// "structured file" vs "plain list" code path — a plain pasted list is just
// a one-column table with no recognizable header, which the same detection
// + mapping table handles naturally, and it keeps the UX consistent with
// the "Check New Prices" importer the user already knows.
// ---------------------------------------------------------------------------

export type InquiryColumnRole =
  | "ignore"
  | "brand"
  | "product"
  | "sku"
  | "qty"
  | "targetPrice"
  | "currency"
  | "extra";

export const INQUIRY_ROLE_LABELS: Record<InquiryColumnRole, string> = {
  ignore: "Ignore",
  brand: "Brand",
  product: "Product name",
  sku: "SKU / EAN / Barcode",
  qty: "Quantity",
  // A client's target/asking price for this line - lets a whole price list
  // be uploaded and pre-fill the sell-price field on every matched item
  // instead of typing it in by hand (see buildInquiryItems below).
  targetPrice: "Target price (client's)",
  currency: "Currency",
  extra: "Extra (kept as note)",
};

export type InquiryColumnMapping = {
  index: number;
  header: string;
  role: InquiryColumnRole;
};

const KEYWORDS: Partial<Record<InquiryColumnRole, string[]>> = {
  sku: ["ean", "gtin", "barcode", "upc", "sku", "codigo", "código", "product code", "item code", "reference", "ref"],
  brand: ["brand", "marca"],
  qty: ["qty", "quantity", "units", "pieces", "pcs", "amount", "cantidad"],
  currency: ["currency", "curr", "ccy", "moneda", "divisa"],
  targetPrice: [
    "target price",
    "target",
    "asking price",
    "asking",
    "sell price",
    "sale price",
    "client price",
    "buyer price",
    "precio objetivo",
    "precio",
    "price",
  ],
  product: ["product", "description", "name", "article", "item", "title"],
};

// Product is checked last since it's the most generic keyword set and would
// otherwise swallow columns that are actually SKU/brand/qty/price/currency.
// currency/targetPrice are checked before the generic product fallback but
// after the more specific sku/brand/qty roles.
const ROLE_PRIORITY: InquiryColumnRole[] = ["sku", "brand", "qty", "currency", "targetPrice", "product"];

function normalize(h: string): string {
  return h
    .toLowerCase()
    .trim()
    .replace(/[_\-/]+/g, " ")
    .replace(/\s+/g, " ");
}

export function detectInquiryColumns(header: string[]): InquiryColumnMapping[] {
  const used = new Set<InquiryColumnRole>();
  return header.map((raw, index) => {
    const h = normalize(raw);
    if (h === "") return { index, header: raw, role: "ignore" as InquiryColumnRole };
    for (const role of ROLE_PRIORITY) {
      if (used.has(role)) continue;
      const keywords = KEYWORDS[role] ?? [];
      if (keywords.some((kw) => h.includes(kw))) {
        used.add(role);
        return { index, header: raw, role };
      }
    }
    return { index, header: raw, role: "ignore" as InquiryColumnRole };
  });
}

// Unlike smartImport's findHeaderRow (which always returns a best-guess row),
// this returns -1 when nothing looks like a real header — a plain pasted
// list of product names has no header row at all, and treating its first
// item as a "header" would silently drop a real product from the results.
export function findInquiryHeaderRow(rows: string[][]): number {
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

// Default mapping for a file with no detected header: first column is the
// product (every plain list has at least that), any other column that looks
// numeric across a sample of rows is guessed as quantity, everything else is
// left as "ignore" — safe default since the mapping table is always shown
// for the user to correct before matching runs.
export function guessMappingWithoutHeader(rows: string[][]): InquiryColumnMapping[] {
  const colCount = Math.max(...rows.slice(0, 20).map((r) => r.length), 1);
  const sample = rows.slice(0, 20);
  const mapping: InquiryColumnMapping[] = [];
  for (let index = 0; index < colCount; index++) {
    if (index === 0) {
      mapping.push({ index, header: "", role: "product" });
      continue;
    }
    const values = sample.map((r) => (r[index] ?? "").trim()).filter((v) => v !== "");
    const numericCount = values.filter((v) => /^\d+([.,]\d+)?$/.test(v)).length;
    const looksNumeric = values.length > 0 && numericCount / values.length >= 0.8;
    mapping.push({ index, header: "", role: looksNumeric ? "qty" : "ignore" });
  }
  return mapping;
}

export type InquiryItem = {
  raw: string;
  brand: string | null;
  product: string;
  sku: string | null;
  qty: number | null;
  // Client's target/asking price for this line, if the uploaded list had a
  // price column - pre-fills the sell price on the Inquiry results so quoting
  // a whole list doesn't mean typing in every price by hand.
  targetPrice: number | null;
  targetCurrency: string | null;
};

export type BuildInquiryResult = {
  items: InquiryItem[];
  errors: { line: number; message: string }[];
};

export function buildInquiryItems(
  rows: string[][],
  headerRowIndex: number,
  mapping: InquiryColumnMapping[]
): BuildInquiryResult {
  const errors: BuildInquiryResult["errors"] = [];
  const items: InquiryItem[] = [];

  const firstByRole = (role: InquiryColumnRole) => mapping.find((m) => m.role === role);
  const productCol = firstByRole("product");
  const brandCol = firstByRole("brand");
  const skuCol = firstByRole("sku");
  const qtyCol = firstByRole("qty");
  const targetPriceCol = firstByRole("targetPrice");
  const currencyCol = firstByRole("currency");

  const dataRows = headerRowIndex >= 0 ? rows.slice(headerRowIndex + 1) : rows;

  dataRows.forEach((r, i) => {
    const line = (headerRowIndex >= 0 ? headerRowIndex + 2 : 1) + i;
    if (r.every((c) => c.trim() === "")) return;

    const product = (productCol ? r[productCol.index] : r[0])?.trim();
    if (!product) {
      errors.push({ line, message: "No product text found — row skipped." });
      return;
    }
    const brand = brandCol ? r[brandCol.index]?.trim() || null : null;
    const sku = skuCol ? r[skuCol.index]?.trim() || null : null;
    const qtyRaw = qtyCol ? r[qtyCol.index]?.trim() : "";
    const qty = qtyRaw ? Number(qtyRaw.replace(",", ".")) : null;

    // Target price cells often come with currency symbols/thousands
    // separators attached (e.g. "€12,50", "$ 8.00") - strip anything that
    // isn't a digit, dot, or comma before parsing, same tolerant approach
    // smartImport.ts uses for supplier prices.
    const targetPriceRaw = targetPriceCol ? r[targetPriceCol.index]?.trim() : "";
    const targetPriceCleaned = targetPriceRaw ? targetPriceRaw.replace(/[^\d.,]/g, "").replace(",", ".") : "";
    const targetPrice = targetPriceCleaned ? Number(targetPriceCleaned) : null;
    const targetCurrency = currencyCol ? r[currencyCol.index]?.trim().toUpperCase() || null : null;

    items.push({
      raw: r.join(" "),
      brand,
      product,
      sku,
      qty: qty !== null && Number.isFinite(qty) ? qty : null,
      targetPrice: targetPrice !== null && Number.isFinite(targetPrice) ? targetPrice : null,
      targetCurrency,
    });
  });

  return { items, errors };
}
