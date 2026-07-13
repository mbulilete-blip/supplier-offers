"use client";

import { useMemo, useState } from "react";
import {
  ColumnMapping,
  ColumnRole,
  ROLE_LABELS,
  buildOffersFromMapping,
  detectColumns,
  findHeaderRow,
  offersToCsv,
  readFileAsRows,
} from "@/lib/smartImport";

type CompareRow = {
  supplier: string;
  brand: string;
  product: string;
  sku: string | null;
  price: number;
  currency: string;
  marketBestPrice: number | null;
  marketBestSupplier: string | null;
  marketBestCurrency: string | null;
  verdict: "cheaper" | "matches" | "higher" | "new";
};

type CompareResult = {
  rows: CompareRow[];
  summary: { total: number; cheaper: number; matches: number; higher: number; new: number };
  errors: { line: number; message: string }[];
  truncated: boolean;
};

const VERDICT_LABEL: Record<CompareRow["verdict"], string> = {
  cheaper: "Cheaper than market",
  matches: "Matches best price",
  higher: "Higher than market",
  new: "New item",
};

const VERDICT_CLASS: Record<CompareRow["verdict"], string> = {
  cheaper: "bg-green-50 text-green-700",
  matches: "bg-gray-50 text-gray-600",
  higher: "bg-red-50 text-red-700",
  new: "bg-blue-50 text-blue-700",
};

// How far the new price sits from the current market-best price, as a signed
// percentage (negative = cheaper, positive = more expensive). Null when
// there's no market-best price to compare against ("new item" rows) or it's
// zero (would divide by zero). Note: compared as raw numbers, same as the
// verdict logic above - no currency conversion, so this is only meaningful
// when new price and current best are in the same currency.
function diffPercent(r: CompareRow): number | null {
  if (r.marketBestPrice === null || r.marketBestPrice === 0) return null;
  return ((r.price - r.marketBestPrice) / r.marketBestPrice) * 100;
}

function formatDiffPercent(pct: number | null): string {
  if (pct === null) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

// Exports whichever verdict tab is currently active (e.g. just the "cheaper
// than market" rows), not the full unfiltered result set - the filter tabs
// already narrow to what the user is looking at, and the download should
// match what's on screen. Real .xlsx (via the SheetJS "xlsx" package already
// used elsewhere in this file to read uploads), not CSV, so it opens
// straight into Excel with proper column widths and numeric price cells.
async function downloadCompareXlsx(filename: string, rows: CompareRow[]) {
  const XLSX = await import("xlsx");

  const data = rows.map((r) => ({
    Product: r.product,
    Brand: r.brand,
    SKU: r.sku ?? "",
    Supplier: r.supplier,
    "New price": r.price,
    Currency: r.currency,
    "Current best price": r.marketBestPrice ?? "",
    "Best currency": r.marketBestCurrency ?? "",
    "Best supplier": r.marketBestSupplier ?? "",
    "Diff %": formatDiffPercent(diffPercent(r)),
    Verdict: VERDICT_LABEL[r.verdict],
  }));

  const sheet = XLSX.utils.json_to_sheet(data);
  sheet["!cols"] = [
    { wch: 32 }, // Product
    { wch: 20 }, // Brand
    { wch: 16 }, // SKU
    { wch: 20 }, // Supplier
    { wch: 12 }, // New price
    { wch: 10 }, // Currency
    { wch: 16 }, // Current best price
    { wch: 12 }, // Best currency
    { wch: 20 }, // Best supplier
    { wch: 10 }, // Diff %
    { wch: 18 }, // Verdict
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Price check");
  XLSX.writeFile(workbook, filename);
}

const ROLE_OPTIONS: ColumnRole[] = [
  "ignore",
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
  "extra",
];

const MARKET_ORIGIN_OPTIONS = ["Unknown", "EU", "Non-EU"] as const;

// Recognized Incoterm codes, used to build a nicer default guess like
// "EXW Dubai" when the column header itself is the Incoterm code and the
// cell value is just a location.
const INCOTERM_CODE_RE = /^(exw|fob|fca|cpt|cip|dap|dpu|ddp|cif|fas|cfr)$/i;

export default function ImportCheckPage() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [headerRowIndex, setHeaderRowIndex] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);
  const [readError, setReadError] = useState<string | null>(null);

  // Confirmed by the user for every upload — takes priority over whatever a
  // supplier column in the file says, so naming stays consistent across
  // uploads from the same counterparty.
  const [supplierName, setSupplierName] = useState("");
  const [defaultBrand, setDefaultBrand] = useState("");
  const [defaultCurrency, setDefaultCurrency] = useState("EUR");

  // Same "confirm once, applies to the whole upload" treatment as supplier:
  // shipping terms and EU/Non-EU origin are almost always uniform across an
  // entire supplier price list, so an override beats any per-row column value.
  const [incotermName, setIncotermName] = useState("");
  const [marketOrigin, setMarketOrigin] = useState<(typeof MARKET_ORIGIN_OPTIONS)[number]>("Unknown");

  // Lead time and MOQ vary more often row-to-row (different products can have
  // different stock/lead times), so these are fallback defaults only — used
  // when a row doesn't have its own value.
  const [defaultLeadTimeDays, setDefaultLeadTimeDays] = useState("");
  const [defaultMoq, setDefaultMoq] = useState("");
  // Same fallback-default treatment: availability genuinely varies row to
  // row within one list, so this only fills in rows with no value of their
  // own ("Unknown" means "don't set a default, leave it to the column/blank").
  const [defaultAvailability, setDefaultAvailability] = useState<"Unknown" | "In Stock" | "Preorder">(
    "Unknown"
  );

  const [comparing, setComparing] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<number | null>(null);
  const [filter, setFilter] = useState<CompareRow["verdict"] | "all">("all");

  const handleFile = async (file: File) => {
    setReadError(null);
    setResult(null);
    setImported(null);
    setFileName(file.name);
    try {
      const grid = await readFileAsRows(file);
      if (grid.length === 0) {
        setReadError("This file appears to be empty.");
        setRows([]);
        setMapping([]);
        return;
      }
      const hIdx = findHeaderRow(grid);
      const detectedMapping = detectColumns(grid[hIdx]);
      setRows(grid);
      setHeaderRowIndex(hIdx);
      setMapping(detectedMapping);

      // Ask for (pre-fill a guess at) the supplier for this list: prefer a
      // detected supplier column's own value, otherwise fall back to the
      // file name as a starting point — either way the user confirms it.
      const supplierCol = detectedMapping.find((m) => m.role === "supplier");
      const sampleSupplier = supplierCol ? grid[hIdx + 1]?.[supplierCol.index]?.trim() : "";
      setSupplierName(sampleSupplier || file.name.replace(/\.[^.]+$/, ""));

      // Pre-fill a guess at the Incoterm/shipping terms: if the column header
      // is itself a known Incoterm code (e.g. "EXW"), pair it with the sample
      // value (often just a city, e.g. "Dubai") for a friendlier default.
      const incotermCol = detectedMapping.find((m) => m.role === "incoterm");
      if (incotermCol) {
        const header = incotermCol.header?.trim() ?? "";
        const sample = grid[hIdx + 1]?.[incotermCol.index]?.trim() ?? "";
        const guess = INCOTERM_CODE_RE.test(header) ? `${header.toUpperCase()} ${sample}`.trim() : sample;
        setIncotermName(guess);
      } else {
        setIncotermName("");
      }

      const marketOriginCol = detectedMapping.find((m) => m.role === "marketOrigin");
      const sampleOrigin = marketOriginCol
        ? grid[hIdx + 1]?.[marketOriginCol.index]?.trim().toLowerCase()
        : "";
      if (sampleOrigin?.includes("non")) setMarketOrigin("Non-EU");
      else if (sampleOrigin?.includes("eu")) setMarketOrigin("EU");
      else setMarketOrigin("Unknown");
    } catch (err) {
      setReadError(err instanceof Error ? err.message : "Could not read this file.");
      setRows([]);
      setMapping([]);
    }
  };

  const handleHeaderRowChange = (idx: number) => {
    setHeaderRowIndex(idx);
    if (rows[idx]) setMapping(detectColumns(rows[idx]));
    setResult(null);
    setImported(null);
  };

  const setRole = (index: number, role: ColumnRole) => {
    setMapping((prev) => prev.map((m) => (m.index === index ? { ...m, role } : m)));
    setResult(null);
    setImported(null);
  };

  const setSupplierLabel = (index: number, label: string) => {
    setMapping((prev) => prev.map((m) => (m.index === index ? { ...m, supplierLabel: label } : m)));
  };

  const priceColCount = mapping.filter((m) => m.role === "price").length;
  const hasSupplierCol = mapping.some((m) => m.role === "supplier");
  const hasBrandCol = mapping.some((m) => m.role === "brand");
  const isWideFormat = priceColCount > 1 && !hasSupplierCol;

  const built = useMemo(() => {
    if (rows.length === 0 || mapping.length === 0) return null;
    const leadTimeTrimmed = defaultLeadTimeDays.trim();
    const moqTrimmed = defaultMoq.trim();
    return buildOffersFromMapping(rows, headerRowIndex, mapping, {
      supplierOverride: isWideFormat ? undefined : supplierName || undefined,
      defaultBrand: defaultBrand || undefined,
      defaultCurrency: defaultCurrency || undefined,
      incotermOverride: incotermName || undefined,
      marketOriginOverride: marketOrigin === "Unknown" ? undefined : marketOrigin,
      defaultLeadTimeDays: leadTimeTrimmed === "" ? undefined : leadTimeTrimmed,
      defaultMoq: moqTrimmed === "" ? undefined : moqTrimmed,
      defaultAvailability: defaultAvailability === "Unknown" ? undefined : defaultAvailability,
    });
  }, [
    rows,
    headerRowIndex,
    mapping,
    supplierName,
    defaultBrand,
    defaultCurrency,
    isWideFormat,
    incotermName,
    marketOrigin,
    defaultLeadTimeDays,
    defaultMoq,
    defaultAvailability,
  ]);

  const handleCompare = async () => {
    if (!built || built.offers.length === 0) return;
    setComparing(true);
    setResult(null);
    setImported(null);
    const csv = offersToCsv(built.offers);
    const res = await fetch("/api/offers/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv }),
    });
    const data = await res.json();
    setComparing(false);
    setResult(data);
  };

  const handleImport = async () => {
    if (!built || built.offers.length === 0) return;
    setImporting(true);
    const csv = offersToCsv(built.offers);
    const res = await fetch("/api/offers/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv }),
    });
    const data = await res.json();
    setImporting(false);
    setImported(data.imported ?? 0);
  };

  const filteredRows = result ? result.rows.filter((r) => filter === "all" || r.verdict === filter) : [];

  const handleExportFiltered = () => {
    if (filteredRows.length === 0) return;
    const suffix = filter === "all" ? "all" : filter;
    downloadCompareXlsx(`price-check-${suffix}-${new Date().toISOString().slice(0, 10)}.xlsx`, filteredRows);
  };

  const headerRowPreview = rows.slice(0, Math.min(10, rows.length));

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold">Check New Prices</h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload a supplier price list in whatever format it comes in — Excel (.xlsx/.xls) or
          CSV/text with any delimiter and any column headers. Columns are detected automatically;
          confirm or correct the mapping below before comparing or importing.
        </p>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <input
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          className="block text-sm"
        />
        {fileName && <p className="mt-2 text-xs text-gray-500">Loaded: {fileName}</p>}
        {readError && <p className="mt-2 text-sm text-red-600">{readError}</p>}
      </section>

      {rows.length > 0 && !isWideFormat && (
        <section className="rounded-xl border border-blue-200 bg-blue-50 p-6 space-y-4">
          <div>
            <label className="block text-sm font-semibold text-gray-800">Which supplier is this list from?</label>
            <p className="mt-1 text-xs text-gray-600">
              This name is used for every offer imported from this file, so it stays consistent with
              your supplier records even if the file itself labels the supplier differently (or not at
              all).
            </p>
            <input
              className="input mt-3 w-full max-w-md text-sm"
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
              placeholder="e.g. Royal Luxury"
            />
            {hasSupplierCol && (
              <p className="mt-2 text-xs text-gray-500">
                We found a supplier column in the file — clear this field to use its values instead.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 border-t border-blue-100 pt-4">
            <div>
              <label className="block text-sm font-semibold text-gray-800">Shipping terms (Incoterm)</label>
              <p className="mt-1 text-xs text-gray-600">
                e.g. &quot;EXW Dubai&quot;, &quot;FOB Rotterdam&quot;, &quot;DDP&quot;. Applies to every row from this
                file — matters for comparing true landed cost, not just sticker price.
              </p>
              <input
                className="input mt-2 w-full text-sm"
                value={incotermName}
                onChange={(e) => setIncotermName(e.target.value)}
                placeholder="e.g. EXW Dubai"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-800">EU / Non-EU origin</label>
              <p className="mt-1 text-xs text-gray-600">
                Was this stock placed on the EU/EEA market with the brand&apos;s consent? This is the
                key fact for trademark-exhaustion risk on parallel imports into the EU.
              </p>
              <select
                className="input mt-2 w-full text-sm"
                value={marketOrigin}
                onChange={(e) => setMarketOrigin(e.target.value as (typeof MARKET_ORIGIN_OPTIONS)[number])}
              >
                {MARKET_ORIGIN_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      )}

      {rows.length > 0 && (
        <section className="rounded-xl border border-gray-200 bg-white p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Header row</label>
            <p className="mt-1 text-xs text-gray-500">
              We picked the row that looks most like column headers. Change it if that&apos;s wrong.
            </p>
            <select
              className="input mt-2 w-full max-w-2xl font-mono text-xs"
              value={headerRowIndex}
              onChange={(e) => handleHeaderRowChange(Number(e.target.value))}
            >
              {headerRowPreview.map((r, i) => (
                <option key={i} value={i}>
                  Row {i + 1}: {r.slice(0, 6).join(" | ")}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Column mapping</label>
            <p className="mt-1 text-xs text-gray-500">
              Auto-detected from the header text. Fix anything that&apos;s wrong — required fields are
              supplier, brand, product, and price.
            </p>
            <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2">Column header</th>
                    <th className="px-3 py-2">Sample value</th>
                    <th className="px-3 py-2">Maps to</th>
                    {priceColCount > 1 && !hasSupplierCol && <th className="px-3 py-2">Supplier label</th>}
                  </tr>
                </thead>
                <tbody>
                  {mapping.map((col) => {
                    const sample = rows[headerRowIndex + 1]?.[col.index] ?? "";
                    return (
                      <tr key={col.index} className="border-b border-gray-100 last:border-0">
                        <td className="px-3 py-2 font-medium">{col.header || `Column ${col.index + 1}`}</td>
                        <td className="px-3 py-2 text-gray-500">{sample}</td>
                        <td className="px-3 py-2">
                          <select
                            className="input text-xs"
                            value={col.role}
                            onChange={(e) => setRole(col.index, e.target.value as ColumnRole)}
                          >
                            {ROLE_OPTIONS.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        </td>
                        {priceColCount > 1 && !hasSupplierCol && (
                          <td className="px-3 py-2">
                            {col.role === "price" && (
                              <input
                                className="input text-xs"
                                placeholder={col.header}
                                value={col.supplierLabel ?? ""}
                                onChange={(e) => setSupplierLabel(col.index, e.target.value)}
                              />
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {priceColCount > 1 && !hasSupplierCol && (
              <p className="mt-2 text-xs text-blue-600">
                Multiple price columns and no supplier column detected — treating this as one row per
                product with one price column per supplier. Edit the supplier labels above if the
                column headers aren&apos;t the supplier names.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {!hasBrandCol && (
              <div>
                <label className="block text-xs font-medium text-gray-700">Default brand (no brand column found)</label>
                <input
                  className="input mt-1 w-full text-sm"
                  value={defaultBrand}
                  onChange={(e) => setDefaultBrand(e.target.value)}
                  placeholder="e.g. Huda Beauty"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-700">Default currency</label>
              <input
                className="input mt-1 w-full text-sm"
                value={defaultCurrency}
                onChange={(e) => setDefaultCurrency(e.target.value)}
                placeholder="EUR"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700">
                Default lead time{" "}
                <span className="font-normal text-gray-400">— fallback only</span>
              </label>
              <input
                className="input mt-1 w-full text-sm"
                type="text"
                value={defaultLeadTimeDays}
                onChange={(e) => setDefaultLeadTimeDays(e.target.value)}
                placeholder="e.g. 6 weeks"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700">
                Default MOQ <span className="font-normal text-gray-400">— fallback only</span>
              </label>
              <input
                className="input mt-1 w-full text-sm"
                type="text"
                value={defaultMoq}
                onChange={(e) => setDefaultMoq(e.target.value)}
                placeholder="e.g. 10 or 500 (neg.)"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700">
                Default availability <span className="font-normal text-gray-400">— fallback only</span>
              </label>
              <select
                className="input mt-1 w-full text-sm"
                value={defaultAvailability}
                onChange={(e) => setDefaultAvailability(e.target.value as typeof defaultAvailability)}
              >
                <option value="Unknown">Unknown (leave blank)</option>
                <option value="In Stock">In Stock</option>
                <option value="Preorder">Preorder</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-400">
            Lead time, MOQ, and availability defaults only fill in rows that don&apos;t already have their
            own value — unlike supplier, Incoterm, and EU origin above, which apply to every row.
          </p>

          {built && (
            <div className="rounded-lg bg-gray-50 p-4 text-sm">
              <p>
                <span className="font-semibold">{built.offers.length}</span> offer(s) ready to compare
                {built.errors.length > 0 && (
                  <span className="text-amber-600"> · {built.errors.length} row(s) skipped</span>
                )}
              </p>
              {built.errors.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-xs text-amber-700">
                  {built.errors.slice(0, 8).map((e, i) => (
                    <li key={i}>
                      Line {e.line}: {e.message}
                    </li>
                  ))}
                  {built.errors.length > 8 && <li>…and {built.errors.length - 8} more</li>}
                </ul>
              )}
              {built.offers.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-gray-400">
                      <tr>
                        <th className="pr-4 py-1">Supplier</th>
                        <th className="pr-4 py-1">Brand</th>
                        <th className="pr-4 py-1">Product</th>
                        <th className="pr-4 py-1">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {built.offers.slice(0, 5).map((o, i) => (
                        <tr key={i} className="text-gray-600">
                          <td className="pr-4 py-1">{o.supplier}</td>
                          <td className="pr-4 py-1">{o.brand}</td>
                          <td className="pr-4 py-1">{o.product}</td>
                          <td className="pr-4 py-1">
                            {o.price.toFixed(2)} {o.currency}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {built.offers.length > 5 && (
                    <p className="mt-1 text-gray-400">…and {built.offers.length - 5} more</p>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={handleCompare}
              disabled={comparing || !built || built.offers.length === 0}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {comparing ? "Comparing…" : "Compare against current offers"}
            </button>
            {result && result.rows.length > 0 && (
              <button
                onClick={handleImport}
                disabled={importing || imported !== null}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {importing ? "Importing…" : imported !== null ? "Imported" : "Import these offers"}
              </button>
            )}
            {imported !== null && <span className="text-sm text-gray-600">Imported {imported} offer(s).</span>}
          </div>
        </section>
      )}

      {result && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2 text-sm">
              {(["all", "cheaper", "matches", "higher", "new"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setFilter(v)}
                  className={`rounded-full border px-3 py-1.5 ${
                    filter === v
                      ? "border-gray-900 bg-gray-900 text-white"
                      : "border-gray-300 text-gray-600 hover:border-gray-400"
                  }`}
                >
                  {v === "all"
                    ? `All (${result.summary.total})`
                    : `${VERDICT_LABEL[v]} (${result.summary[v]})`}
                </button>
              ))}
            </div>
            <button
              onClick={handleExportFiltered}
              disabled={filteredRows.length === 0}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Download Excel — {filter === "all" ? "all" : VERDICT_LABEL[filter].toLowerCase()} ({filteredRows.length})
            </button>
          </div>

          {result.truncated && (
            <p className="text-xs text-amber-600">
              This file has more rows than fit in one comparison pass. Only the first{" "}
              {result.rows.length.toLocaleString()} rows are shown.
            </p>
          )}

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">New price</th>
                  <th className="px-4 py-3">Current best</th>
                  <th className="px-4 py-3">Diff %</th>
                  <th className="px-4 py-3">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r, i) => (
                  <tr key={i} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 font-medium">
                      {r.product}
                      {r.sku && <div className="text-xs text-gray-400">{r.sku}</div>}
                      <div className="text-xs text-gray-400">{r.brand}</div>
                    </td>
                    <td className="px-4 py-3">{r.supplier}</td>
                    <td className="px-4 py-3">
                      {r.price.toFixed(2)} {r.currency}
                    </td>
                    <td className="px-4 py-3">
                      {r.marketBestPrice !== null
                        ? `${r.marketBestPrice.toFixed(2)} ${r.marketBestCurrency} (${r.marketBestSupplier})`
                        : "—"}
                    </td>
                    <td
                      className={`px-4 py-3 font-medium ${
                        r.verdict === "cheaper"
                          ? "text-green-700"
                          : r.verdict === "higher"
                          ? "text-red-700"
                          : "text-gray-400"
                      }`}
                    >
                      {formatDiffPercent(diffPercent(r))}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${VERDICT_CLASS[r.verdict]}`}
                      >
                        {VERDICT_LABEL[r.verdict]}
                      </span>
                    </td>
                  </tr>
                ))}
                {filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                      No rows match this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
