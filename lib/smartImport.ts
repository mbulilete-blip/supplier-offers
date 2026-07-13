import { OfferInput, CSV_HEADERS } from "./types";

// ---------------------------------------------------------------------------
// Smart import: turn an arbitrary real-world supplier file (.xlsx, .xls,
// .csv with any delimiter, .tsv, plain text) into our canonical offer rows,
// by auto-detecting which column is which. The user confirms/edits the
// detected mapping before anything is compared or imported, so we never
// silently mis-map a column the way the original bulk import once did.
// ---------------------------------------------------------------------------

export type ColumnRole =
  | "ignore"
  | "supplier"
  | "brand"
  | "product"
  | "sku"
  | "price"
  | "currency"
  | "rrp"
  | "moq"
  | "leadTimeDays"
  | "paymentTerms"
  | "region"
  | "incoterm"
  | "marketOrigin"
  | "availability"
  | "extra";

export const ROLE_LABELS: Record<ColumnRole, string> = {
  ignore: "Ignore",
  supplier: "Supplier",
  brand: "Brand",
  product: "Product name",
  sku: "SKU / EAN / Barcode",
  price: "Price",
  currency: "Currency",
  rrp: "RRP",
  moq: "MOQ",
  leadTimeDays: "Lead time",
  paymentTerms: "Payment terms",
  region: "Region",
  incoterm: "Incoterm / shipping terms (e.g. EXW)",
  marketOrigin: "EU / Non-EU origin",
  availability: "Availability (In Stock / Preorder)",
  extra: "Extra (kept as note)",
};

export type ColumnMapping = {
  index: number;
  header: string;
  role: ColumnRole;
  // For wide-format sheets, each "price" column gets its own supplier label
  // (defaults to the column header, e.g. a supplier name used as a header).
  supplierLabel?: string;
};

export type SheetData = {
  rows: string[][];
  headerRowIndex: number;
};

const KEYWORDS: Partial<Record<ColumnRole, string[]>> = {
  sku: ["ean", "gtin", "barcode", "upc", "sku", "codigo", "código", "product code", "item code", "reference", "ref"],
  brand: ["brand", "marca"],
  supplier: ["supplier", "vendor", "proveedor", "seller", "distributor"],
  rrp: ["rrp", "msrp", "srp", "retail price", "recommended retail"],
  moq: ["moq", "minimum order", "min order", "min qty", "minimum quantity"],
  leadTimeDays: ["lead time", "eta", "delivery time", "dispatch", "shipping time"],
  paymentTerms: ["payment terms", "payment", "terms"],
  region: ["region", "market", "country", "territory"],
  currency: ["currency", "curr", "moneda"],
  // Incoterm / shipping-term columns (often just "EXW" or "FOB" with a
  // location as the value, like the Huda Beauty file's "EXW" -> "DUBAI").
  incoterm: ["incoterm", "exw", "fob", "ddp", "cif", "fca", "cpt", "terms of sale", "shipping terms"],
  marketOrigin: ["eu goods", "non eu", "non-eu", "eu stock", "market origin", "eu origin", "eu/non eu"],
  // Deliberately no bare "stock" keyword - too many unrelated headers
  // ("Stock Code", "Stock Qty") contain that word and would be misclaimed.
  availability: ["availability", "stock status", "preorder", "pre-order", "in stock", "stock availability"],
  price: ["price", "cost", "rate", "precio", "importe", "wholesale", "offer"],
  product: ["product", "description", "name", "article", "item", "title"],
};

// Order matters: more specific/identifying roles are matched before the
// generic ones (product/price), so e.g. "Price Offer" doesn't get treated
// as a product just because it contains no product keyword, and "EXW"
// isn't mistaken for a second price column.
const ROLE_PRIORITY: ColumnRole[] = [
  "sku",
  "brand",
  "supplier",
  "rrp",
  "moq",
  "leadTimeDays",
  "paymentTerms",
  "region",
  "currency",
  "incoterm",
  "marketOrigin",
  "availability",
  "price",
  "product",
];

function normalize(h: string): string {
  return h
    .toLowerCase()
    .trim()
    .replace(/[_\-\/]+/g, " ")
    .replace(/\s+/g, " ");
}

export function detectColumns(header: string[]): ColumnMapping[] {
  const used = new Set<ColumnRole>();
  return header.map((raw, index) => {
    const h = normalize(raw);
    if (h === "") return { index, header: raw, role: "ignore" as ColumnRole };

    for (const role of ROLE_PRIORITY) {
      if (role !== "price" && used.has(role)) continue; // price can repeat (wide format signal)
      const keywords = KEYWORDS[role] ?? [];
      if (keywords.some((kw) => h.includes(kw))) {
        used.add(role);
        return { index, header: raw, role };
      }
    }
    return { index, header: raw, role: "extra" as ColumnRole };
  });
}

// Scans the first few rows to find the most likely header row (some
// supplier files have a title/logo row or two before the real header).
export function findHeaderRow(rows: string[][]): number {
  const allKeywords = Object.values(KEYWORDS).flat();
  let bestIndex = 0;
  let bestScore = -1;
  const scanLimit = Math.min(10, rows.length);
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
  return bestScore > 0 ? bestIndex : 0;
}

// ---------------------------------------------------------------------------
// Delimiter-sniffing text parser (comma, semicolon, or tab), quote-aware.
// ---------------------------------------------------------------------------

export function detectDelimiter(sampleLine: string): string {
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const count = sampleLine.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      // skip, \n triggers row push
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

// Reads any supported file type (.xlsx/.xls via SheetJS, otherwise
// delimiter-sniffed text) into a plain grid of strings.
export async function readFileAsRows(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false }) as unknown[][];
    return raw
      .map((r) => r.map((c) => String(c ?? "").trim()))
      .filter((r) => r.some((cell) => cell !== ""));
  }

  const text = await file.text();
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const delimiter = detectDelimiter(firstLine);
  return parseDelimited(text, delimiter);
}

// ---------------------------------------------------------------------------
// Tolerant field coercion: locale-aware money parsing, free-text integers,
// currency-symbol detection.
// ---------------------------------------------------------------------------

export function parseMoney(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  let s = raw.trim();
  if (s === "") return undefined;
  // strip currency symbols/letters/spaces, keep digits . , -
  s = s.replace(/[^\d.,-]/g, "");
  if (s === "" || s === "-") return undefined;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    // Whichever separator appears last is the decimal separator.
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    // "4,00" -> decimal comma; "1,234" -> thousands separator.
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (hasDot) {
    const dotCount = (s.match(/\./g) || []).length;
    if (dotCount > 1) s = s.replace(/\./g, "");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function detectCurrency(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.includes("€")) return "EUR";
  if (raw.includes("$")) return "USD";
  if (raw.includes("£")) return "GBP";
  const match = raw.toUpperCase().match(/\b(EUR|USD|GBP|CHF|AED)\b/);
  return match ? match[1] : undefined;
}

export function parseFirstInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/\d+/);
  return match ? parseInt(match[0], 10) : undefined;
}

function str(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

// ---------------------------------------------------------------------------
// Build canonical offer rows from a confirmed mapping. Supports both
// "long" sheets (one row per offer, a single price column, usually a
// supplier column) and "wide" sheets (one row per product, one price
// column per supplier) — the same two shapes seen across supplier files.
// ---------------------------------------------------------------------------

export type BuildOptions = {
  // Confirmed by the user before comparing/importing (e.g. via an "ask me
  // which supplier this list is from" prompt). Takes priority over whatever
  // is in a detected supplier column, so naming stays consistent across
  // uploads from the same counterparty even if their own files label
  // themselves differently from one file to the next.
  supplierOverride?: string;
  defaultBrand?: string;
  defaultCurrency?: string;
  // These typically don't vary row-to-row within one shipment/price list —
  // an EXW batch is EXW for everything on the list, and it's either all EU
  // stock or it isn't — so, like supplier, a confirmed value here wins over
  // whatever a per-row column says.
  incotermOverride?: string;
  marketOriginOverride?: string;
  // Lead time and MOQ genuinely can vary per product even within one list,
  // so these only fill in when a row has no value of its own. Lead time is
  // free text (e.g. "6 weeks", "10-15 days"), not a strict day count.
  defaultLeadTimeDays?: string;
  defaultMoq?: number;
  // Same fallback-default pattern as lead time/MOQ: availability genuinely
  // varies product-to-product within one list, so a per-row column value
  // always wins and this only fills in rows that have none.
  defaultAvailability?: string;
};

// Canonicalizes common supplier phrasings into one of four buckets so
// filtering by "In Stock" or "Preorder" actually groups things consistently,
// while passing through anything unrecognized unchanged rather than
// discarding information the supplier gave us.
export function normalizeAvailability(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (t === "") return null;
  const low = t.toLowerCase();
  if (/pre.?order/.test(low)) return "Preorder";
  if (/(in stock|available now|ready stock|ex stock|immediate)/.test(low)) return "In Stock";
  if (/back ?order/.test(low)) return "Backorder";
  if (/(out of stock|sold out|no stock)/.test(low)) return "Out of Stock";
  return t;
}

export type BuildResult = {
  offers: OfferInput[];
  errors: { line: number; message: string }[];
  isWideFormat: boolean;
};

export function buildOffersFromMapping(
  rows: string[][],
  headerRowIndex: number,
  mapping: ColumnMapping[],
  options: BuildOptions = {}
): BuildResult {
  const errors: BuildResult["errors"] = [];
  const offers: OfferInput[] = [];

  const byRole = (role: ColumnRole) => mapping.filter((m) => m.role === role);
  const firstByRole = (role: ColumnRole) => byRole(role)[0];

  const priceCols = byRole("price");
  const supplierCol = firstByRole("supplier");
  const brandCol = firstByRole("brand");
  const productCol = firstByRole("product");
  const skuCol = firstByRole("sku");
  const currencyCol = firstByRole("currency");
  const rrpCol = firstByRole("rrp");
  const moqCol = firstByRole("moq");
  const leadCol = firstByRole("leadTimeDays");
  const paymentCol = firstByRole("paymentTerms");
  const regionCol = firstByRole("region");
  const incotermCol = firstByRole("incoterm");
  const marketOriginCol = firstByRole("marketOrigin");
  const availabilityCol = firstByRole("availability");
  const extraCols = byRole("extra");

  const isWideFormat = priceCols.length > 1 && !supplierCol;

  const dataRows = rows.slice(headerRowIndex + 1);

  const buildNotes = (r: string[]): string | undefined => {
    if (extraCols.length === 0) return undefined;
    const parts = extraCols
      .map((c) => {
        const v = str(r[c.index]);
        return v ? `${c.header}: ${v}` : null;
      })
      .filter((p): p is string => p !== null);
    return parts.length > 0 ? parts.join("; ") : undefined;
  };

  dataRows.forEach((r, i) => {
    const line = headerRowIndex + 2 + i; // human-facing line number
    if (r.every((c) => c.trim() === "")) return;

    const brand = str(brandCol ? r[brandCol.index] : undefined) ?? options.defaultBrand;
    const product = str(productCol ? r[productCol.index] : undefined);
    const sku = str(skuCol ? r[skuCol.index] : undefined) ?? null;
    const rrp = parseMoney(rrpCol ? r[rrpCol.index] : undefined) ?? null;
    const moq = parseFirstInt(moqCol ? r[moqCol.index] : undefined) ?? options.defaultMoq ?? null;
    const leadTimeDays =
      str(leadCol ? r[leadCol.index] : undefined) ?? options.defaultLeadTimeDays ?? null;
    const paymentTerms = str(paymentCol ? r[paymentCol.index] : undefined) ?? null;
    const region = str(regionCol ? r[regionCol.index] : undefined) ?? null;
    const incoterm =
      str(options.incotermOverride) ?? str(incotermCol ? r[incotermCol.index] : undefined) ?? null;
    const marketOrigin =
      str(options.marketOriginOverride) ??
      str(marketOriginCol ? r[marketOriginCol.index] : undefined) ??
      null;
    const availability =
      normalizeAvailability(str(availabilityCol ? r[availabilityCol.index] : undefined)) ??
      normalizeAvailability(options.defaultAvailability) ??
      null;
    const notes = buildNotes(r) ?? null;

    if (!product) {
      errors.push({ line, message: "Missing product name — row skipped." });
      return;
    }
    if (!brand) {
      errors.push({ line, message: "Missing brand — row skipped (set a default brand above to fix this)." });
      return;
    }

    if (isWideFormat) {
      for (const col of priceCols) {
        const price = parseMoney(r[col.index]);
        if (price === undefined) continue; // empty cell: this supplier has no price for this product
        const supplier = col.supplierLabel?.trim() || col.header;
        const currency =
          detectCurrency(r[col.index]) ??
          str(currencyCol ? r[currencyCol.index] : undefined) ??
          options.defaultCurrency ??
          "EUR";
        offers.push({
          supplier,
          brand,
          product,
          sku,
          price,
          currency,
          rrp,
          moq,
          leadTimeDays,
          paymentTerms,
          region,
          incoterm,
          marketOrigin,
          availability,
          notes,
        });
      }
    } else {
      const priceCol = priceCols[0];
      const priceRaw = priceCol ? r[priceCol.index] : undefined;
      const price = parseMoney(priceRaw);
      // The confirmed supplier name wins over whatever a supplier column
      // says, so uploads from the same counterparty stay consistently
      // labeled even if their files don't.
      const supplier = str(options.supplierOverride) ?? str(supplierCol ? r[supplierCol.index] : undefined);

      if (!supplier) {
        errors.push({ line, message: "Missing supplier — row skipped (confirm the supplier name above to fix this)." });
        return;
      }
      if (price === undefined) {
        errors.push({ line, message: "Missing or unreadable price — row skipped." });
        return;
      }

      const currency =
        detectCurrency(priceRaw) ??
        str(currencyCol ? r[currencyCol.index] : undefined) ??
        options.defaultCurrency ??
        "EUR";

      offers.push({
        supplier,
        brand,
        product,
        sku,
        price,
        currency,
        rrp,
        moq,
        leadTimeDays,
        paymentTerms,
        region,
        incoterm,
        marketOrigin,
        availability,
        notes,
      });
    }
  });

  return { offers, errors, isWideFormat };
}

// Serializes offers into the canonical CSV our existing /api/offers/compare
// and /api/offers/import endpoints already understand, so no backend
// changes are needed to consume a smart-imported file.
export function offersToCsv(offers: OfferInput[]): string {
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [CSV_HEADERS.join(",")];
  for (const o of offers) {
    lines.push(
      [
        o.supplier,
        o.brand,
        o.product,
        o.sku ?? "",
        o.price,
        o.currency ?? "EUR",
        o.rrp ?? "",
        o.moq ?? "",
        o.leadTimeDays ?? "",
        o.paymentTerms ?? "",
        o.region ?? "",
        o.incoterm ?? "",
        o.marketOrigin ?? "",
        o.availability ?? "",
        o.notes ?? "",
      ]
        .map(escape)
        .join(",")
    );
  }
  return lines.join("\n");
}
