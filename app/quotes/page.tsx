"use client";

import { useEffect, useState } from "react";
import { EurRates, formatEur, formatMoney, toEur, SUPPORTED_CURRENCIES } from "@/lib/currency";

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
  // Snapshotted from the sourced offer at save time - null when that offer
  // had no RRP on file. Lets a line show how far below RRP both the buy and
  // the sell sit, not just the buy-to-sell margin.
  rrp: number | null;
  createdAt: string;
};

type Quote = QuoteSummary & {
  notes: string | null;
  items: QuoteItem[];
  // Deal-level logistics costs - one lump sum for the whole shipment, not
  // per line item. Nullable since usually only known after the quote is
  // first saved.
  shippingInCost: number | null;
  shippingInCurrency: string | null;
  shippingOutCost: number | null;
  shippingOutCurrency: string | null;
  samplesCost: number | null;
  samplesCurrency: string | null;
};

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
    "RRP",
    "Buying disc. vs RRP %",
    "Sell price",
    "Sell currency",
    "Selling disc. vs RRP %",
    "Line total (sell)",
    "Margin (EUR)",
  ]);

  const totalsByCurrency: Record<string, number> = {};
  let marginEurTotal = 0;
  let costEurTotal = 0;
  let sellEurTotal = 0;
  // RRP-based totals only cover lines that actually have an RRP on file -
  // mixing in RRP-less lines would silently understate the "vs RRP" figures.
  let rrpEurTotal = 0;
  let costEurForRrpTotal = 0;
  let sellEurForRrpTotal = 0;

  for (const it of quote.items) {
    const qty = it.qty ?? 1;
    const currency = it.sellCurrency ?? "";
    const lineTotal = it.sellPrice !== null ? it.sellPrice * qty : null;
    if (lineTotal !== null && currency) {
      totalsByCurrency[currency] = (totalsByCurrency[currency] ?? 0) + lineTotal;
    }
    const costEurUnit = it.costPrice !== null ? toEur(it.costPrice, it.costCurrency, eurRates) : null;
    const sellEurUnit = it.sellPrice !== null ? toEur(it.sellPrice, it.sellCurrency, eurRates) : null;
    // RRP is snapshotted from the same offer as cost price, so it shares the
    // cost currency - see the Matrix page's identical assumption.
    const rrpEurUnit = it.rrp !== null ? toEur(it.rrp, it.costCurrency, eurRates) : null;

    const costEur = costEurUnit !== null ? costEurUnit * qty : null;
    const sellEur = sellEurUnit !== null ? sellEurUnit * qty : null;
    const marginEur = costEur !== null && sellEur !== null ? sellEur - costEur : null;
    if (costEur !== null) costEurTotal += costEur;
    if (sellEur !== null) sellEurTotal += sellEur;
    if (marginEur !== null) marginEurTotal += marginEur;

    const buyingDiscPct =
      rrpEurUnit && rrpEurUnit > 0 && costEurUnit !== null ? ((rrpEurUnit - costEurUnit) / rrpEurUnit) * 100 : null;
    const sellingDiscPct =
      rrpEurUnit && rrpEurUnit > 0 && sellEurUnit !== null ? ((rrpEurUnit - sellEurUnit) / rrpEurUnit) * 100 : null;

    if (rrpEurUnit !== null) {
      rrpEurTotal += rrpEurUnit * qty;
      if (costEur !== null) costEurForRrpTotal += costEur;
      if (sellEur !== null) sellEurForRrpTotal += sellEur;
    }

    rows.push([
      it.product,
      it.brand ?? "",
      it.sku ?? "",
      it.qty ?? "",
      it.supplier ?? "",
      it.costPrice ?? "",
      it.costCurrency ?? "",
      it.rrp ?? "",
      buyingDiscPct !== null ? Number(buyingDiscPct.toFixed(1)) : "",
      it.sellPrice ?? "",
      currency,
      sellingDiscPct !== null ? Number(sellingDiscPct.toFixed(1)) : "",
      lineTotal !== null ? Number(lineTotal.toFixed(2)) : "",
      marginEur !== null ? Number(marginEur.toFixed(2)) : "",
    ]);
  }

  const blankRow = (label: string, value: string | number) => {
    const r: (string | number)[] = new Array(13).fill("");
    r.push(label);
    r.push(value);
    return r;
  };

  rows.push([]);
  rows.push(blankRow("Total margin (EUR)", Number(marginEurTotal.toFixed(2))));
  const currencyTotals = Object.entries(totalsByCurrency);
  for (const [currency, total] of currencyTotals) {
    rows.push(blankRow(`Total sell (${currency})`, Number(total.toFixed(2))));
  }

  // Expanded pricing-intelligence summary block - RRP value, discount to
  // client, sourcing margin, and net margin after deal-level logistics costs.
  rows.push([]);
  rows.push(["Summary"]);
  if (rrpEurTotal > 0) {
    const avgDiscountToClientPct = ((rrpEurTotal - sellEurForRrpTotal) / rrpEurTotal) * 100;
    const sourcingMarginEur = rrpEurTotal - costEurForRrpTotal;
    const sourcingMarginPct = (sourcingMarginEur / rrpEurTotal) * 100;
    rows.push(["Total RRP value (EUR)", Number(rrpEurTotal.toFixed(2))]);
    rows.push(["Average discount to client vs RRP", `${avgDiscountToClientPct.toFixed(1)}%`]);
    rows.push([
      "Sourcing margin (RRP vs cost, EUR)",
      `${Number(sourcingMarginEur.toFixed(2))} (${sourcingMarginPct.toFixed(1)}%)`,
    ]);
  }
  rows.push([
    "Gross margin (sell - cost, EUR)",
    `${Number(marginEurTotal.toFixed(2))} (${sellEurTotal > 0 ? ((marginEurTotal / sellEurTotal) * 100).toFixed(1) : "0.0"}%)`,
  ]);

  const shippingInEur =
    quote.shippingInCost !== null ? toEur(quote.shippingInCost, quote.shippingInCurrency, eurRates) : 0;
  const shippingOutEur =
    quote.shippingOutCost !== null ? toEur(quote.shippingOutCost, quote.shippingOutCurrency, eurRates) : 0;
  const samplesEur = quote.samplesCost !== null ? toEur(quote.samplesCost, quote.samplesCurrency, eurRates) : 0;
  const hasLogisticsCosts = quote.shippingInCost !== null || quote.shippingOutCost !== null || quote.samplesCost !== null;

  if (hasLogisticsCosts) {
    if (quote.shippingInCost !== null) {
      rows.push([
        "Shipping in (EUR)",
        `${Number(shippingInEur.toFixed(2))} (${formatMoney(quote.shippingInCost)} ${quote.shippingInCurrency ?? ""})`,
      ]);
    }
    if (quote.shippingOutCost !== null) {
      rows.push([
        "Shipping out (EUR)",
        `${Number(shippingOutEur.toFixed(2))} (${formatMoney(quote.shippingOutCost)} ${quote.shippingOutCurrency ?? ""})`,
      ]);
    }
    if (quote.samplesCost !== null) {
      rows.push([
        "Samples (EUR)",
        `${Number(samplesEur.toFixed(2))} (${formatMoney(quote.samplesCost)} ${quote.samplesCurrency ?? ""})`,
      ]);
    }
    const netMarginEur = marginEurTotal - shippingInEur - shippingOutEur - samplesEur;
    const netMarginPct = sellEurTotal > 0 ? (netMarginEur / sellEurTotal) * 100 : null;
    rows.push([
      "Net margin (after shipping + samples, EUR)",
      `${Number(netMarginEur.toFixed(2))}${netMarginPct !== null ? ` (${netMarginPct.toFixed(1)}%)` : ""}`,
    ]);
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
    { wch: 10 }, // RRP
    { wch: 14 }, // Buying disc. vs RRP %
    { wch: 12 }, // Sell price
    { wch: 12 }, // Sell currency
    { wch: 14 }, // Selling disc. vs RRP %
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

  // Editable deal-level logistics costs (shipping in/out, samples) - kept as
  // free-text form state per quote so the amount/currency inputs don't fight
  // the user while typing, saved explicitly via the button below.
  type ShipForm = {
    shippingInCost: string;
    shippingInCurrency: string;
    shippingOutCost: string;
    shippingOutCurrency: string;
    samplesCost: string;
    samplesCurrency: string;
  };
  const [shipForm, setShipForm] = useState<Record<number, ShipForm>>({});
  const [savingShipping, setSavingShipping] = useState<number | null>(null);
  const [shipError, setShipError] = useState<Record<number, string>>({});

  const shipFormFromQuote = (q: Quote): ShipForm => ({
    shippingInCost: q.shippingInCost !== null ? String(q.shippingInCost) : "",
    shippingInCurrency: q.shippingInCurrency ?? "EUR",
    shippingOutCost: q.shippingOutCost !== null ? String(q.shippingOutCost) : "",
    shippingOutCurrency: q.shippingOutCurrency ?? "EUR",
    samplesCost: q.samplesCost !== null ? String(q.samplesCost) : "",
    samplesCurrency: q.samplesCurrency ?? "EUR",
  });

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
      const data: Quote = await res.json();
      setExpanded((prev) => ({ ...prev, [id]: data }));
      setShipForm((prev) => (prev[id] ? prev : { ...prev, [id]: shipFormFromQuote(data) }));
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleSaveShipping = async (id: number) => {
    const form = shipForm[id];
    if (!form) return;
    setShipError((prev) => ({ ...prev, [id]: "" }));

    const parseCost = (v: string): number | null | undefined => {
      const t = v.trim();
      if (t === "") return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : undefined;
    };
    const shippingInCost = parseCost(form.shippingInCost);
    const shippingOutCost = parseCost(form.shippingOutCost);
    const samplesCost = parseCost(form.samplesCost);
    if (shippingInCost === undefined || shippingOutCost === undefined || samplesCost === undefined) {
      setShipError((prev) => ({ ...prev, [id]: "Enter valid numbers, or leave a field blank to clear it." }));
      return;
    }

    setSavingShipping(id);
    try {
      const res = await fetch(`/api/quotes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingInCost,
          shippingInCurrency: form.shippingInCurrency,
          shippingOutCost,
          shippingOutCurrency: form.shippingOutCurrency,
          samplesCost,
          samplesCurrency: form.samplesCurrency,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save logistics costs.");
      setExpanded((prev) => ({ ...prev, [id]: data }));
      setShipForm((prev) => ({ ...prev, [id]: shipFormFromQuote(data) }));
    } catch (err) {
      setShipError((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : "Failed to save logistics costs.",
      }));
    } finally {
      setSavingShipping(null);
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
  // Also rolls up RRP-based sourcing/discount metrics (only over lines that
  // actually have an RRP on file) and, once deal-level shipping/samples costs
  // are set, a net margin after those logistics costs.
  const quoteTotals = (quote: Quote) => {
    let costEur = 0;
    let sellEur = 0;
    let rrpEur = 0;
    let costEurForRrp = 0;
    let sellEurForRrp = 0;
    for (const it of quote.items) {
      const qty = it.qty ?? 1;
      const costEurUnit = it.costPrice !== null ? toEur(it.costPrice, it.costCurrency, eurRates) : null;
      const sellEurUnit = it.sellPrice !== null ? toEur(it.sellPrice, it.sellCurrency, eurRates) : null;
      const rrpEurUnit = it.rrp !== null ? toEur(it.rrp, it.costCurrency, eurRates) : null;
      if (costEurUnit !== null) costEur += costEurUnit * qty;
      if (sellEurUnit !== null) sellEur += sellEurUnit * qty;
      if (rrpEurUnit !== null) {
        rrpEur += rrpEurUnit * qty;
        if (costEurUnit !== null) costEurForRrp += costEurUnit * qty;
        if (sellEurUnit !== null) sellEurForRrp += sellEurUnit * qty;
      }
    }
    const marginEur = sellEur - costEur;
    const marginPct = sellEur > 0 ? (marginEur / sellEur) * 100 : null;

    const sourcingMarginEur = rrpEur > 0 ? rrpEur - costEurForRrp : null;
    const sourcingMarginPct = rrpEur > 0 ? (sourcingMarginEur! / rrpEur) * 100 : null;
    const avgDiscountToClientPct = rrpEur > 0 ? ((rrpEur - sellEurForRrp) / rrpEur) * 100 : null;

    const shippingInEur =
      quote.shippingInCost !== null ? toEur(quote.shippingInCost, quote.shippingInCurrency, eurRates) : 0;
    const shippingOutEur =
      quote.shippingOutCost !== null ? toEur(quote.shippingOutCost, quote.shippingOutCurrency, eurRates) : 0;
    const samplesEur = quote.samplesCost !== null ? toEur(quote.samplesCost, quote.samplesCurrency, eurRates) : 0;
    const hasLogisticsCosts =
      quote.shippingInCost !== null || quote.shippingOutCost !== null || quote.samplesCost !== null;
    const netMarginEur = marginEur - shippingInEur - shippingOutEur - samplesEur;
    const netMarginPct = sellEur > 0 ? (netMarginEur / sellEur) * 100 : null;

    return {
      costEur,
      sellEur,
      marginEur,
      marginPct,
      rrpEur,
      sourcingMarginEur,
      sourcingMarginPct,
      avgDiscountToClientPct,
      hasLogisticsCosts,
      shippingInEur,
      shippingOutEur,
      samplesEur,
      netMarginEur,
      netMarginPct,
    };
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
            const totals = detail ? quoteTotals(detail) : null;
            const form = shipForm[q.id];
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
                              {totals.hasLogisticsCosts && (
                                <span>
                                  Net margin:{" "}
                                  <strong className={totals.netMarginEur < 0 ? "text-red-600" : "text-green-700"}>
                                    {totals.netMarginEur >= 0 ? "+" : ""}
                                    {formatEur(totals.netMarginEur)} EUR
                                    {totals.netMarginPct !== null ? ` (${totals.netMarginPct.toFixed(0)}%)` : ""}
                                  </strong>
                                </span>
                              )}
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
                        {totals && totals.rrpEur > 0 && (
                          <div className="mb-3 flex flex-wrap gap-4 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                            <span>
                              RRP value ≈ <strong className="text-gray-900">{formatEur(totals.rrpEur)} EUR</strong>
                            </span>
                            {totals.sourcingMarginEur !== null && (
                              <span>
                                Sourcing margin vs RRP:{" "}
                                <strong className="text-gray-900">
                                  {formatEur(totals.sourcingMarginEur)} EUR
                                  {totals.sourcingMarginPct !== null
                                    ? ` (${totals.sourcingMarginPct.toFixed(0)}%)`
                                    : ""}
                                </strong>
                              </span>
                            )}
                            {totals.avgDiscountToClientPct !== null && (
                              <span>
                                Avg. discount to client vs RRP:{" "}
                                <strong className="text-gray-900">{totals.avgDiscountToClientPct.toFixed(0)}%</strong>
                              </span>
                            )}
                          </div>
                        )}
                        {detail.notes && <p className="mb-3 text-sm text-gray-500">Notes: {detail.notes}</p>}

                        <div className="mb-4 rounded-lg border border-gray-200 p-3">
                          <p className="mb-2 text-xs font-medium uppercase text-gray-500">
                            Shipping &amp; samples (deal-level)
                          </p>
                          {form && (
                            <div className="flex flex-wrap items-end gap-3">
                              <label className="block text-xs text-gray-600">
                                Shipping in
                                <div className="mt-1 flex gap-1">
                                  <input
                                    type="number"
                                    className="input w-24"
                                    value={form.shippingInCost}
                                    onChange={(e) =>
                                      setShipForm((prev) => ({
                                        ...prev,
                                        [q.id]: { ...form, shippingInCost: e.target.value },
                                      }))
                                    }
                                  />
                                  <select
                                    className="input w-20"
                                    value={form.shippingInCurrency}
                                    onChange={(e) =>
                                      setShipForm((prev) => ({
                                        ...prev,
                                        [q.id]: { ...form, shippingInCurrency: e.target.value },
                                      }))
                                    }
                                  >
                                    {SUPPORTED_CURRENCIES.map((c) => (
                                      <option key={c} value={c}>
                                        {c}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </label>
                              <label className="block text-xs text-gray-600">
                                Shipping out
                                <div className="mt-1 flex gap-1">
                                  <input
                                    type="number"
                                    className="input w-24"
                                    value={form.shippingOutCost}
                                    onChange={(e) =>
                                      setShipForm((prev) => ({
                                        ...prev,
                                        [q.id]: { ...form, shippingOutCost: e.target.value },
                                      }))
                                    }
                                  />
                                  <select
                                    className="input w-20"
                                    value={form.shippingOutCurrency}
                                    onChange={(e) =>
                                      setShipForm((prev) => ({
                                        ...prev,
                                        [q.id]: { ...form, shippingOutCurrency: e.target.value },
                                      }))
                                    }
                                  >
                                    {SUPPORTED_CURRENCIES.map((c) => (
                                      <option key={c} value={c}>
                                        {c}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </label>
                              <label className="block text-xs text-gray-600">
                                Samples
                                <div className="mt-1 flex gap-1">
                                  <input
                                    type="number"
                                    className="input w-24"
                                    value={form.samplesCost}
                                    onChange={(e) =>
                                      setShipForm((prev) => ({
                                        ...prev,
                                        [q.id]: { ...form, samplesCost: e.target.value },
                                      }))
                                    }
                                  />
                                  <select
                                    className="input w-20"
                                    value={form.samplesCurrency}
                                    onChange={(e) =>
                                      setShipForm((prev) => ({
                                        ...prev,
                                        [q.id]: { ...form, samplesCurrency: e.target.value },
                                      }))
                                    }
                                  >
                                    {SUPPORTED_CURRENCIES.map((c) => (
                                      <option key={c} value={c}>
                                        {c}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </label>
                              <button
                                onClick={() => handleSaveShipping(q.id)}
                                disabled={savingShipping === q.id}
                                className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                              >
                                {savingShipping === q.id ? "Saving…" : "Save"}
                              </button>
                            </div>
                          )}
                          {shipError[q.id] && <p className="mt-2 text-xs text-red-600">{shipError[q.id]}</p>}
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-sm">
                            <thead className="border-b border-gray-200 text-xs uppercase text-gray-500">
                              <tr>
                                <th className="py-2 pr-4">Product</th>
                                <th className="py-2 pr-4">Qty</th>
                                <th className="py-2 pr-4">Supplier</th>
                                <th className="py-2 pr-4">RRP</th>
                                <th className="py-2 pr-4">Cost</th>
                                <th className="py-2 pr-4">Sell</th>
                                <th className="py-2 pr-4">Margin</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.items.map((it) => {
                                const costEur = it.costPrice !== null ? toEur(it.costPrice, it.costCurrency, eurRates) : null;
                                const sellEur = it.sellPrice !== null ? toEur(it.sellPrice, it.sellCurrency, eurRates) : null;
                                const rrpEur = it.rrp !== null ? toEur(it.rrp, it.costCurrency, eurRates) : null;
                                const marginEur = costEur !== null && sellEur !== null ? sellEur - costEur : null;
                                const marginPct = marginEur !== null && sellEur ? (marginEur / sellEur) * 100 : null;
                                const buyingDiscPct =
                                  rrpEur && rrpEur > 0 && costEur !== null ? ((rrpEur - costEur) / rrpEur) * 100 : null;
                                const sellingDiscPct =
                                  rrpEur && rrpEur > 0 && sellEur !== null ? ((rrpEur - sellEur) / rrpEur) * 100 : null;
                                return (
                                  <tr key={it.id} className="border-b border-gray-100 last:border-0">
                                    <td className="py-2 pr-4 font-medium">
                                      {it.product}
                                      {it.brand && <span className="ml-1.5 font-normal text-gray-400">{it.brand}</span>}
                                    </td>
                                    <td className="py-2 pr-4">{it.qty ?? "—"}</td>
                                    <td className="py-2 pr-4">{it.supplier ?? "—"}</td>
                                    <td className="py-2 pr-4">
                                      {it.rrp !== null ? `${formatMoney(it.rrp)} ${it.costCurrency}` : "—"}
                                    </td>
                                    <td className="py-2 pr-4">
                                      {it.costPrice !== null ? `${formatMoney(it.costPrice)} ${it.costCurrency}` : "—"}
                                      {buyingDiscPct !== null && (
                                        <span className="ml-1 text-xs text-gray-400">
                                          ({buyingDiscPct.toFixed(0)}% vs RRP)
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-2 pr-4">
                                      {it.sellPrice !== null ? `${formatMoney(it.sellPrice)} ${it.sellCurrency}` : "—"}
                                      {sellingDiscPct !== null && (
                                        <span className="ml-1 text-xs text-gray-400">
                                          ({sellingDiscPct.toFixed(0)}% vs RRP)
                                        </span>
                                      )}
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
