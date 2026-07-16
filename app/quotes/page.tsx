"use client";

import { useEffect, useState } from "react";
import { EurRates, formatEur, formatMoney, toEur } from "@/lib/currency";

type QuoteStatus = "quoted" | "won" | "lost" | "shipped";

const QUOTE_STATUSES: QuoteStatus[] = ["quoted", "won", "lost", "shipped"];

const STATUS_STYLES: Record<QuoteStatus, string> = {
  quoted: "bg-blue-50 text-blue-700 border-blue-200",
  won: "bg-green-50 text-green-700 border-green-200",
  lost: "bg-gray-100 text-gray-500 border-gray-200",
  shipped: "bg-purple-50 text-purple-700 border-purple-200",
};

type QuoteSummary = {
  id: number;
  customerName: string;
  customerType: string | null;
  region: string | null;
  status: QuoteStatus;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
};

type QuoteItem = {
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
  createdAt: string;
};

type Quote = QuoteSummary & { notes: string | null; items: QuoteItem[] };

// Internal-use quote export - this file is for Maria/the team, not the
// customer, so it includes full sourcing detail: supplier, cost
// price/currency, and margin (in EUR, converted via the same rates used
// on-screen) alongside the sell price quoted to the customer. Never hand
// this file to a customer directly - it exposes exactly who the supplier
// is and what margin is being made.
async function downloadQuoteXlsx(quote: Quote, eurRates: EurRates) {
  const XLSX = await import("xlsx");

  const rows: (string | number)[][] = [];
  rows.push([`Quote for ${quote.customerName} (internal - includes supplier/cost/margin)`]);
  const infoParts = [
    quote.customerType ? `Type: ${quote.customerType}` : null,
    quote.region ? `Region: ${quote.region}` : null,
    `Date: ${new Date(quote.createdAt).toLocaleDateString()}`,
  ].filter(Boolean) as string[];
  rows.push([infoParts.join("   ")]);
  rows.push([]);
  rows.push([
    "Product",
    "Brand",
    "SKU",
    "Qty",
    "Supplier",
    "Cost price",
    "Cost currency",
    "Sell price",
    "Sell currency",
    "Line total (sell)",
    "Margin (EUR)",
  ]);

  const totalsByCurrency: Record<string, number> = {};
  let marginEurTotal = 0;
  for (const it of quote.items) {
    const qty = it.qty ?? 1;
    const currency = it.sellCurrency ?? "";
    const lineTotal = it.sellPrice !== null ? it.sellPrice * qty : null;
    if (lineTotal !== null && currency) {
      totalsByCurrency[currency] = (totalsByCurrency[currency] ?? 0) + lineTotal;
    }
    const costEur = it.costPrice !== null ? toEur(it.costPrice, it.costCurrency, eurRates) * qty : null;
    const sellEur = it.sellPrice !== null ? toEur(it.sellPrice, it.sellCurrency, eurRates) * qty : null;
    const marginEur = costEur !== null && sellEur !== null ? sellEur - costEur : null;
    if (marginEur !== null) marginEurTotal += marginEur;

    rows.push([
      it.product,
      it.brand ?? "",
      it.sku ?? "",
      it.qty ?? "",
      it.supplier ?? "",
      it.costPrice ?? "",
      it.costCurrency ?? "",
      it.sellPrice ?? "",
      currency,
      lineTotal !== null ? Number(lineTotal.toFixed(2)) : "",
      marginEur !== null ? Number(marginEur.toFixed(2)) : "",
    ]);
  }

  rows.push([]);
  rows.push(["", "", "", "", "", "", "", "", "", "Total margin (EUR)", Number(marginEurTotal.toFixed(2))]);
  const currencyTotals = Object.entries(totalsByCurrency);
  for (const [currency, total] of currencyTotals) {
    rows.push(["", "", "", "", "", "", "", "", "", `Total sell (${currency})`, Number(total.toFixed(2))]);
  }

  if (quote.notes) {
    rows.push([]);
    rows.push([`Notes: ${quote.notes}`]);
  }

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [
    { wch: 32 }, // Product
    { wch: 18 }, // Brand
    { wch: 16 }, // SKU
    { wch: 8 }, // Qty
    { wch: 20 }, // Supplier
    { wch: 12 }, // Cost price
    { wch: 12 }, // Cost currency
    { wch: 12 }, // Sell price
    { wch: 12 }, // Sell currency
    { wch: 16 }, // Line total
    { wch: 14 }, // Margin
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Quote");
  const safeName = quote.customerName.trim().replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "customer";
  XLSX.writeFile(workbook, `quote-internal-${safeName}-${new Date(quote.createdAt).toISOString().slice(0, 10)}.xlsx`);
}

export default function QuotesPage() {
  const [quotes, setQuotes] = useState<QuoteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<number, Quote>>({});
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [eurRates, setEurRates] = useState<EurRates>({ EUR: 1 });

  const load = () => {
    setLoading(true);
    fetch("/api/quotes")
      .then((r) => r.json())
      .then((data) => setQuotes(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    fetch("/api/fx-rates")
      .then((r) => r.json())
      .then((data) => setEurRates((prev) => (data && typeof data === "object" ? data : prev)));
  }, []);

  const toggleExpand = async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (expanded[id]) return;
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/quotes/${id}`);
      const data = await res.json();
      setExpanded((prev) => ({ ...prev, [id]: data }));
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleStatusChange = async (id: number, status: QuoteStatus) => {
    setQuotes((prev) => prev.map((q) => (q.id === id ? { ...q, status } : q)));
    await fetch(`/api/quotes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this quote?")) return;
    await fetch(`/api/quotes/${id}`, { method: "DELETE" });
    setQuotes((prev) => prev.filter((q) => q.id !== id));
    setExpanded((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (expandedId === id) setExpandedId(null);
  };

  // Per-quote totals: sums cost/sell across items in EUR, so a mixed-currency
  // quote (e.g. costed in USD, sold in AED) still shows one meaningful margin.
  const quoteTotals = (items: QuoteItem[]) => {
    let costEur = 0;
    let sellEur = 0;
    for (const it of items) {
      const qty = it.qty ?? 1;
      if (it.costPrice !== null) costEur += toEur(it.costPrice, it.costCurrency, eurRates) * qty;
      if (it.sellPrice !== null) sellEur += toEur(it.sellPrice, it.sellCurrency, eurRates) * qty;
    }
    const marginEur = sellEur - costEur;
    const marginPct = sellEur > 0 ? (marginEur / sellEur) * 100 : null;
    return { costEur, sellEur, marginEur, marginPct };
  };

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold">Sales Pipeline</h1>
        <p className="mt-1 text-sm text-gray-500">
          Quotes built from the Sourcing Inquiry page - customer, sourced cost, proposed sell
          price, and margin, tracked through to won/lost/shipped.
        </p>
      </section>

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : quotes.length === 0 ? (
        <p className="text-sm text-gray-400">
          No quotes yet. Build one from the Sourcing Inquiry page by entering a sell price on a
          matched item and saving.
        </p>
      ) : (
        <div className="space-y-3">
          {quotes.map((q) => {
            const detail = expanded[q.id];
            const totals = detail ? quoteTotals(detail.items) : null;
            return (
              <div key={q.id} className="rounded-xl border border-gray-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <button
                    onClick={() => toggleExpand(q.id)}
                    className="flex flex-1 flex-wrap items-center gap-3 text-left"
                  >
                    <span className="font-medium">{q.customerName}</span>
                    {q.customerType && <span className="text-xs text-gray-400">{q.customerType}</span>}
                    {q.region && <span className="text-xs text-gray-400">· {q.region}</span>}
                    <span className="text-xs text-gray-400">
                      · {q.itemCount} item{q.itemCount === 1 ? "" : "s"}
                    </span>
                    <span className="text-xs text-gray-400">
                      · {new Date(q.createdAt).toLocaleDateString()}
                    </span>
                  </button>
                  <div className="flex items-center gap-2">
                    <select
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[q.status]}`}
                      value={q.status}
                      onChange={(e) => handleStatusChange(q.id, e.target.value as QuoteStatus)}
                    >
                      {QUOTE_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleDelete(q.id)}
                      className="text-xs text-gray-400 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {expandedId === q.id && (
                  <div className="border-t border-gray-100 p-4">
                    {!detail && loadingDetail ? (
                      <p className="text-sm text-gray-400">Loading…</p>
                    ) : detail ? (
                      <>
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                          {totals && (
                            <div className="flex flex-wrap gap-4 text-sm text-gray-600">
                              <span>
                                Cost ≈ <strong className="text-gray-900">{formatEur(totals.costEur)} EUR</strong>
                              </span>
                              <span>
                                Sell ≈ <strong className="text-gray-900">{formatEur(totals.sellEur)} EUR</strong>
                              </span>
                              <span>
                                Margin:{" "}
                                <strong className={totals.marginEur < 0 ? "text-red-600" : "text-green-700"}>
                                  {totals.marginEur >= 0 ? "+" : ""}
                                  {formatEur(totals.marginEur)} EUR
                                  {totals.marginPct !== null ? ` (${totals.marginPct.toFixed(0)}%)` : ""}
                                </strong>
                              </span>
                            </div>
                          )}
                          <button
                            onClick={() => downloadQuoteXlsx(detail, eurRates)}
                            title="Internal use only: includes supplier, cost, sell price, and margin. Do not send this file to the customer."
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-gray-400"
                          >
                            Download quote (.xlsx)
                          </button>
                        </div>
                        {detail.notes && <p className="mb-3 text-sm text-gray-500">Notes: {detail.notes}</p>}
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-sm">
                            <thead className="border-b border-gray-200 text-xs uppercase text-gray-500">
                              <tr>
                                <th className="py-2 pr-4">Product</th>
                                <th className="py-2 pr-4">Qty</th>
                                <th className="py-2 pr-4">Supplier</th>
                                <th className="py-2 pr-4">Cost</th>
                                <th className="py-2 pr-4">Sell</th>
                                <th className="py-2 pr-4">Margin</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.items.map((it) => {
                                const costEur = it.costPrice !== null ? toEur(it.costPrice, it.costCurrency, eurRates) : null;
                                const sellEur = it.sellPrice !== null ? toEur(it.sellPrice, it.sellCurrency, eurRates) : null;
                                const marginEur = costEur !== null && sellEur !== null ? sellEur - costEur : null;
                                const marginPct = marginEur !== null && sellEur ? (marginEur / sellEur) * 100 : null;
                                return (
                                  <tr key={it.id} className="border-b border-gray-100 last:border-0">
                                    <td className="py-2 pr-4 font-medium">
                                      {it.product}
                                      {it.brand && <span className="ml-1.5 font-normal text-gray-400">{it.brand}</span>}
                                    </td>
                                    <td className="py-2 pr-4">{it.qty ?? "—"}</td>
                                    <td className="py-2 pr-4">{it.supplier ?? "—"}</td>
                                    <td className="py-2 pr-4">
                                      {it.costPrice !== null ? `${formatMoney(it.costPrice)} ${it.costCurrency}` : "—"}
                                    </td>
                                    <td className="py-2 pr-4">
                                      {it.sellPrice !== null ? `${formatMoney(it.sellPrice)} ${it.sellCurrency}` : "—"}
                                    </td>
                                    <td className="py-2 pr-4">
                                      {marginEur !== null ? (
                                        <span className={marginEur < 0 ? "text-red-600" : "text-green-700"}>
                                          {marginEur >= 0 ? "+" : ""}
                                          {formatEur(marginEur)} EUR
                                          {marginPct !== null ? ` (${marginPct.toFixed(0)}%)` : ""}
                                        </span>
                                      ) : (
                                        "—"
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
