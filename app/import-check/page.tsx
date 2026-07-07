"use client";

import { useState } from "react";

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

export default function ImportCheckPage() {
  const [csvText, setCsvText] = useState("");
  const [comparing, setComparing] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<number | null>(null);
  const [filter, setFilter] = useState<CompareRow["verdict"] | "all">("all");

  const handleFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
    setResult(null);
    setImported(null);
  };

  const handleCompare = async () => {
    if (!csvText.trim()) return;
    setComparing(true);
    setResult(null);
    setImported(null);
    const res = await fetch("/api/offers/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: csvText }),
    });
    const data = await res.json();
    setComparing(false);
    setResult(data);
  };

  const handleImport = async () => {
    if (!csvText.trim()) return;
    setImporting(true);
    const res = await fetch("/api/offers/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: csvText }),
    });
    const data = await res.json();
    setImporting(false);
    setImported(data.imported ?? 0);
  };

  const filteredRows = result ? result.rows.filter((r) => filter === "all" || r.verdict === filter) : [];

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold">Check New Prices</h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload a new supplier price list (same CSV format as regular import) to see which
          items would be cheaper, higher, or new compared to what&apos;s already on file — before
          committing anything to the database.
        </p>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <p className="mb-3 text-sm text-gray-500">
          Headers: <code>supplier, brand, product, sku, price, currency, rrp, moq,
          leadTimeDays, paymentTerms, region, notes</code>. Only supplier, brand, product, and
          price are required.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          className="mb-3 block text-sm"
        />
        <textarea
          className="input h-32 w-full font-mono text-xs"
          placeholder="Paste CSV here, or upload a file above"
          value={csvText}
          onChange={(e) => {
            setCsvText(e.target.value);
            setResult(null);
            setImported(null);
          }}
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={handleCompare}
            disabled={comparing || !csvText.trim()}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {comparing ? "Comparing…" : "Compare"}
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
          {imported !== null && (
            <span className="text-sm text-gray-600">Imported {imported} offer(s).</span>
          )}
        </div>
        {result && result.errors.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-xs text-red-600">
            {result.errors.slice(0, 10).map((e, i) => (
              <li key={i}>
                Line {e.line}: {e.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      {result && (
        <section className="space-y-4">
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
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
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
