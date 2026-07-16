import { OfferInput, CSV_HEADERS } from "./types";

// Minimal RFC 4180-ish CSV parser: handles quoted fields, escaped quotes,
// and commas/newlines inside quotes. No external dependency needed.
export function parseCsv(text: string): string[][] {
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
    } else if (char === ",") {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      // skip, \n will trigger row push
    } else {
      field += char;
    }
  }

  // last field/row if the file doesn't end with a newline
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const str = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
};

export type CsvImportResult = {
  offers: OfferInput[];
  errors: { line: number; message: string }[];
};

// Expects the first row to be a header matching (a subset/superset/any
// order of) CSV_HEADERS. supplier, brand, product, price are required.
export function offersFromCsv(text: string): CsvImportResult {
  const rows = parseCsv(text);
  const errors: CsvImportResult["errors"] = [];
  if (rows.length === 0) return { offers: [], errors: [] };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const colIndex = (name: string) => header.indexOf(name.toLowerCase());

  const required = ["supplier", "brand", "product", "price"];
  const missing = required.filter((r) => colIndex(r) === -1);
  if (missing.length > 0) {
    errors.push({
      line: 1,
      message: `Missing required column(s): ${missing.join(", ")}. Expected headers like: ${CSV_HEADERS.join(", ")}`,
    });
    return { offers: [], errors };
  }

  const offers: OfferInput[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (name: string) => {
      const idx = colIndex(name);
      return idx === -1 ? undefined : r[idx];
    };

    const supplier = str(get("supplier"));
    const brand = str(get("brand"));
    const product = str(get("product"));
    const price = num(get("price"));

    if (!supplier || !brand || !product || price === undefined) {
      errors.push({
        line: i + 1,
        message: "Missing required value (supplier, brand, product, and price are all required).",
      });
      continue;
    }

    offers.push({
      supplier,
      brand,
      product,
      sku: str(get("sku")) ?? null,
      price,
      currency: str(get("currency")) ?? "EUR",
      rrp: num(get("rrp")) ?? null,
      moq: str(get("moq")) ?? null,
      leadTimeDays: str(get("leadtimedays") ?? get("lead time days") ?? get("lead_time_days")) ?? null,
      paymentTerms: str(get("paymentterms") ?? get("payment terms") ?? get("payment_terms")) ?? null,
      region: str(get("region")) ?? null,
      incoterm: str(get("incoterm")) ?? null,
      marketOrigin: str(get("marketorigin") ?? get("market origin") ?? get("market_origin")) ?? null,
      availability: str(get("availability")) ?? null,
      notes: str(get("notes")) ?? null,
      sourceFileUrl: str(get("sourcefileurl") ?? get("source file url") ?? get("source_file_url")) ?? null,
    });
  }

  return { offers, errors };
}
