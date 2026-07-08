"use client";

import { useMemo, useState } from "react";
import { Offer } from "@/lib/types";
import EditOfferModal from "@/components/EditOfferModal";
import {
  InquiryColumnMapping,
  InquiryColumnRole,
  INQUIRY_ROLE_LABELS,
  buildInquiryItems,
  detectInquiryColumns,
  findInquiryHeaderRow,
  guessMappingWithoutHeader,
} from "@/lib/inquiryImport";
import { detectDelimiter, parseDelimited, readFileAsRows } from "@/lib/smartImport";

type InquiryItem = {
  raw: string;
  brand: string | null;
  product: string;
  sku: string | null;
  qty: number | null;
};

type InquiryResultRow = {
  item: InquiryItem;
  offers: Offer[];
};

type MatchResponse = {
  results: InquiryResultRow[];
  summary: { total: number; matched: number; unmatched: number };
  truncated: boolean;
};

const ROLE_OPTIONS: InquiryColumnRole[] = ["product", "brand", "sku", "qty", "ignore"];

const isToday = (iso: string): boolean => {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
};

const shortDate = (iso: string): string => {
  if (isToday(iso)) return "Today";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

// Same clickable-price hover detail shown on the Compare page - MOQ, lead
// time, terms, etc. don't fit in the results table, so they're a hover away
// instead of forcing a click into the edit modal just to see them.
const offerTooltip = (o: Offer): string => {
  const parts = [
    `Added ${new Date(o.createdAt).toLocaleString()}`,
    o.moq ? `MOQ ${o.moq}` : null,
    o.leadTimeDays ? `Lead time ${o.leadTimeDays}d` : null,
    o.paymentTerms ? `Terms: ${o.paymentTerms}` : null,
    o.region ? `Region: ${o.region}` : null,
    o.incoterm ? `Incoterm: ${o.incoterm}` : null,
    o.marketOrigin ? `Origin: ${o.marketOrigin}` : null,
    o.notes ? `Notes: ${o.notes}` : null,
  ].filter(Boolean);
  return `${parts.join(" · ")}\nClick to edit full details`;
};

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const csvEscape = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function buildResultsCsv(results: InquiryResultRow[]): string {
  const headers = [
    "Requested product",
    "Requested brand",
    "Requested SKU",
    "Requested qty",
    "Supplier",
    "Price",
    "Currency",
    "Added",
    "Best price",
    "RRP",
    "Discount vs RRP %",
    "MOQ",
    "Lead time (days)",
    "Payment terms",
    "Region",
    "Incoterm",
    "Market origin",
    "Notes",
  ];
  const lines = [headers.join(",")];

  for (const { item, offers } of results) {
    if (offers.length === 0) {
      lines.push(
        [item.product, item.brand ?? "", item.sku ?? "", item.qty ?? "", "No match found", "", "", "", "", "", "", "", "", "", "", "", "", ""]
          .map(csvEscape)
          .join(",")
      );
      continue;
    }
    const sorted = offers.slice().sort((a, b) => a.price - b.price);
    const bestPrice = sorted[0].price;
    for (const o of sorted) {
      const discount = o.rrp && o.rrp > 0 ? (((o.rrp - o.price) / o.rrp) * 100).toFixed(0) + "%" : "";
      lines.push(
        [
          item.product,
          item.brand ?? "",
          item.sku ?? "",
          item.qty ?? "",
          o.supplier,
          o.price.toFixed(2),
          o.currency,
          new Date(o.createdAt).toLocaleDateString(),
          o.price === bestPrice ? "Yes" : "",
          o.rrp ?? "",
          discount,
          o.moq ?? "",
          o.leadTimeDays ?? "",
          o.paymentTerms ?? "",
          o.region ?? "",
          o.incoterm ?? "",
          o.marketOrigin ?? "",
          o.notes ?? "",
        ]
          .map(csvEscape)
          .join(",")
      );
    }
  }

  return lines.join("\n");
}

export default function InquiryPage() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [headerRowIndex, setHeaderRowIndex] = useState(-1);
  const [mapping, setMapping] = useState<InquiryColumnMapping[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");

  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [response, setResponse] = useState<MatchResponse | null>(null);
  const [filter, setFilter] = useState<"all" | "matched" | "unmatched">("all");
  const [editingOffer, setEditingOffer] = useState<Offer | null>(null);

  const resetResults = () => {
    setResponse(null);
    setMatchError(null);
  };

  const loadGrid = (grid: string[][], name: string) => {
    if (grid.length === 0) {
      setReadError("This file appears to be empty.");
      setRows([]);
      setMapping([]);
      return;
    }
    const hIdx = findInquiryHeaderRow(grid);
    const detectedMapping = hIdx >= 0 ? detectInquiryColumns(grid[hIdx]) : guessMappingWithoutHeader(grid);
    setFileName(name);
    setRows(grid);
    setHeaderRowIndex(hIdx);
    setMapping(detectedMapping);
    resetResults();
  };

  const handleFile = async (file: File) => {
    setReadError(null);
    setPasteText("");
    try {
      const grid = await readFileAsRows(file);
      loadGrid(grid, file.name);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : "Could not read this file.");
      setRows([]);
      setMapping([]);
    }
  };

  const handlePasteParse = () => {
    setReadError(null);
    if (!pasteText.trim()) return;
    const firstLine = pasteText.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
    const delimiter = detectDelimiter(firstLine);
    const grid = parseDelimited(pasteText, delimiter);
    loadGrid(grid, "Pasted list");
  };

  const handleHeaderRowChange = (idx: number) => {
    setHeaderRowIndex(idx);
    setMapping(idx >= 0 ? detectInquiryColumns(rows[idx]) : guessMappingWithoutHeader(rows));
    resetResults();
  };

  const setRole = (index: number, role: InquiryColumnRole) => {
    setMapping((prev) => prev.map((m) => (m.index === index ? { ...m, role } : m)));
    resetResults();
  };

  const built = useMemo(() => {
    if (rows.length === 0 || mapping.length === 0) return null;
    return buildInquiryItems(rows, headerRowIndex, mapping);
  }, [rows, headerRowIndex, mapping]);

  const handleMatch = async () => {
    if (!built || built.items.length === 0) return;
    setMatching(true);
    setMatchError(null);
    setResponse(null);
    try {
      const res = await fetch("/api/inquiry/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: built.items }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to match inquiry.");
      setResponse(data);
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : "Failed to match inquiry.");
    } finally {
      setMatching(false);
    }
  };

  const handleExport = () => {
    if (!response) return;
    downloadCsv(`inquiry-quote-${new Date().toISOString().slice(0, 10)}.csv`, buildResultsCsv(response.results));
  };

  const filteredResults = response
    ? response.results.filter((r) => {
        if (filter === "matched") return r.offers.length > 0;
        if (filter === "unmatched") return r.offers.length === 0;
        return true;
      })
    : [];

  const headerRowPreview = rows.slice(0, Math.min(10, rows.length));

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold">Sourcing Inquiry</h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload or paste a client&apos;s wanted list - mixed brands, one product per line or a
          spreadsheet - and see every supplier, price, and term already on file for each item.
          Lowest price per item is highlighted.
        </p>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Upload a file</label>
          <p className="mt-1 text-xs text-gray-500">
            Excel (.xlsx/.xls) or CSV/text, with or without column headers.
          </p>
          <input
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            className="mt-2 block text-sm"
          />
          {fileName && <p className="mt-2 text-xs text-gray-500">Loaded: {fileName}</p>}
          {readError && <p className="mt-2 text-sm text-red-600">{readError}</p>}
        </div>

        <div className="border-t border-gray-100 pt-4">
          <label className="block text-sm font-medium text-gray-700">…or paste a list</label>
          <p className="mt-1 text-xs text-gray-500">
            One item per line, straight from an email or WhatsApp message - e.g. &quot;Dior Sauvage
            EDT 100ml&quot;. Add a brand or quantity column too if you have one.
          </p>
          <textarea
            className="input mt-2 w-full font-mono text-xs"
            rows={5}
            placeholder={"Dior Sauvage EDT 100ml\nChanel No 5 EDP 50ml, 10\nHuda Beauty Rose Gold Palette"}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <button
            onClick={handlePasteParse}
            disabled={!pasteText.trim()}
            className="mt-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            Parse pasted list
          </button>
        </div>
      </section>

      {rows.length > 0 && (
        <section className="rounded-xl border border-gray-200 bg-white p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Header row</label>
            <p className="mt-1 text-xs text-gray-500">
              {headerRowIndex >= 0
                ? "We found what looks like a column header. Change it if that's wrong, or pick \"No header row\" for a plain list."
                : "No column header detected - treating every row as an item. Pick a row below if this file does have one."}
            </p>
            <select
              className="input mt-2 w-full max-w-2xl font-mono text-xs"
              value={headerRowIndex}
              onChange={(e) => handleHeaderRowChange(Number(e.target.value))}
            >
              <option value={-1}>No header row - every row is an item</option>
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
              Confirm which column is which - only &quot;Product name&quot; is required.
            </p>
            <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2">Column</th>
                    <th className="px-3 py-2">Sample value</th>
                    <th className="px-3 py-2">Maps to</th>
                  </tr>
                </thead>
                <tbody>
                  {mapping.map((col) => {
                    const sampleRowIdx = headerRowIndex >= 0 ? headerRowIndex + 1 : 0;
                    const sample = rows[sampleRowIdx]?.[col.index] ?? "";
                    return (
                      <tr key={col.index} className="border-b border-gray-100 last:border-0">
                        <td className="px-3 py-2 font-medium">{col.header || `Column ${col.index + 1}`}</td>
                        <td className="px-3 py-2 text-gray-500">{sample}</td>
                        <td className="px-3 py-2">
                          <select
                            className="input text-xs"
                            value={col.role}
                            onChange={(e) => setRole(col.index, e.target.value as InquiryColumnRole)}
                          >
                            {ROLE_OPTIONS.map((r) => (
                              <option key={r} value={r}>
                                {INQUIRY_ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {built && (
            <div className="rounded-lg bg-gray-50 p-4 text-sm">
              <p>
                <span className="font-semibold">{built.items.length}</span> item(s) ready to match
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
            </div>
          )}

          <button
            onClick={handleMatch}
            disabled={matching || !built || built.items.length === 0}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {matching ? "Matching…" : "Match against current offers"}
          </button>
          {matchError && <p className="text-sm text-red-600">{matchError}</p>}
        </section>
      )}

      {response && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2 text-sm">
              {(["all", "matched", "unmatched"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-full border px-3 py-1.5 ${
                    filter === f
                      ? "border-gray-900 bg-gray-900 text-white"
                      : "border-gray-300 text-gray-600 hover:border-gray-400"
                  }`}
                >
                  {f === "all"
                    ? `All (${response.summary.total})`
                    : f === "matched"
                      ? `Matched (${response.summary.matched})`
                      : `No match (${response.summary.unmatched})`}
                </button>
              ))}
            </div>
            <button
              onClick={handleExport}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:border-gray-400"
            >
              Export results (CSV)
            </button>
          </div>

          {response.truncated && (
            <p className="text-xs text-amber-600">
              This list has more items than fit in one pass. Only the first{" "}
              {response.results.length.toLocaleString()} are shown.
            </p>
          )}

          <div className="space-y-6">
            {filteredResults.map(({ item, offers }, i) => {
              const sorted = offers.slice().sort((a, b) => a.price - b.price);
              const bestPrice = sorted[0]?.price;
              return (
                <div key={i} className="rounded-xl border border-gray-200 bg-white p-5">
                  <div className="mb-3 flex items-baseline justify-between gap-3">
                    <h2 className="text-lg font-medium">
                      {item.product}{" "}
                      {item.brand && <span className="text-sm font-normal text-gray-400">{item.brand}</span>}
                    </h2>
                    <span className="text-xs text-gray-400">
                      {item.qty ? `Qty ${item.qty} · ` : ""}
                      {sorted.length} offer{sorted.length === 1 ? "" : "s"}
                    </span>
                  </div>

                  {sorted.length === 0 ? (
                    <p className="text-sm text-gray-400">No matching offers found for this item.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="border-b border-gray-200 text-xs uppercase text-gray-500">
                          <tr>
                            <th className="py-2 pr-4">Supplier</th>
                            <th className="py-2 pr-4">Price</th>
                            <th className="py-2 pr-4">Added</th>
                            <th className="py-2 pr-4">Margin vs RRP</th>
                            <th className="py-2 pr-4">MOQ</th>
                            <th className="py-2 pr-4">Lead time</th>
                            <th className="py-2 pr-4">Terms</th>
                            <th className="py-2 pr-4">Region</th>
                            <th className="py-2 pr-4"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {sorted.map((o) => {
                            const isBest = o.price === bestPrice && sorted.length > 1;
                            const margin = o.rrp && o.rrp > 0 ? ((o.rrp - o.price) / o.rrp) * 100 : null;
                            return (
                              <tr
                                key={o.id}
                                className={`border-b border-gray-100 last:border-0 ${isBest ? "bg-green-50" : ""}`}
                              >
                                <td className="py-2 pr-4 font-medium">
                                  {o.supplier}
                                  {isBest && (
                                    <span className="ml-2 rounded-full bg-green-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                                      BEST PRICE
                                    </span>
                                  )}
                                </td>
                                <td
                                  onClick={() => setEditingOffer(o)}
                                  title={offerTooltip(o)}
                                  className="cursor-pointer py-2 pr-4 font-medium text-gray-900 hover:underline"
                                >
                                  {o.price.toFixed(2)} {o.currency}
                                </td>
                                <td
                                  title={new Date(o.createdAt).toLocaleString()}
                                  className={`py-2 pr-4 whitespace-nowrap ${
                                    isToday(o.createdAt) ? "text-blue-500" : "text-gray-500"
                                  }`}
                                >
                                  {shortDate(o.createdAt)}
                                </td>
                                <td className="py-2 pr-4">{margin !== null ? `${margin.toFixed(0)}%` : "—"}</td>
                                <td className="py-2 pr-4">{o.moq ?? "—"}</td>
                                <td className="py-2 pr-4">{o.leadTimeDays ? `${o.leadTimeDays}d` : "—"}</td>
                                <td className="py-2 pr-4">{o.paymentTerms ?? "—"}</td>
                                <td className="py-2 pr-4">{o.region ?? "—"}</td>
                                <td className="py-2 pr-4 text-right">
                                  <button
                                    onClick={() => setEditingOffer(o)}
                                    className="text-xs text-gray-500 hover:underline"
                                  >
                                    Edit
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {editingOffer && (
        <EditOfferModal
          offer={editingOffer}
          onClose={() => setEditingOffer(null)}
          onSaved={() => setEditingOffer(null)}
        />
      )}
    </div>
  );
}
