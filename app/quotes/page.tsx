"use client";

import { useEffect, useState } from "react";
import { EurRates, formatEur, formatMoney, toEur, SUPPORTED_CURRENCIES } from "@/lib/currency";
import type { QuoteItemInput } from "@/lib/db";

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
  // Currency (and %, for the discount columns) is baked directly into each
  // cell's text rather than split into a separate column - a bare number
  // next to the wrong column header is easy to misread once you're scanning
  // fast, and this is meant to be readable at a glance.
  rows.push([
    "Product",
    "Brand",
    "SKU",
    "Qty",
    "Supplier",
    "Cost price",
    "RRP",
    "Buying disc. vs RRP",
    "Sell price",
    "Selling disc. vs RRP",
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
      it.costPrice !== null ? `${formatMoney(it.costPrice)} ${it.costCurrency ?? ""}`.trim() : "",
      it.rrp !== null ? `${formatMoney(it.rrp)} ${it.costCurrency ?? ""}`.trim() : "",
      buyingDiscPct !== null ? `${buyingDiscPct.toFixed(1)}%` : "",
      it.sellPrice !== null ? `${formatMoney(it.sellPrice)} ${currency}`.trim() : "",
      sellingDiscPct !== null ? `${sellingDiscPct.toFixed(1)}%` : "",
      lineTotal !== null ? `${formatMoney(lineTotal)} ${currency}`.trim() : "",
      marginEur !== null ? `${marginEur >= 0 ? "+" : ""}${formatMoney(marginEur)} EUR` : "",
    ]);
  }

  const blankRow = (label: string, value: string | number) => {
    const r: (string | number)[] = new Array(10).fill("");
    r.push(label);
    r.push(value);
    return r;
  };

  rows.push([]);
  rows.push(blankRow("Total margin (EUR)", `${formatMoney(marginEurTotal)} EUR`));
  const currencyTotals = Object.entries(totalsByCurrency);
  for (const [currency, total] of currencyTotals) {
    rows.push(blankRow(`Total sell (${currency})`, `${formatMoney(total)} ${currency}`));
  }

  // Expanded pricing-intelligence summary block - RRP value, discount to
  // client, sourcing margin, and net margin after deal-level logistics costs.
  rows.push([]);
  rows.push(["Summary"]);
  if (rrpEurTotal > 0) {
    const avgDiscountToClientPct = ((rrpEurTotal - sellEurForRrpTotal) / rrpEurTotal) * 100;
    const sourcingMarginEur = rrpEurTotal - costEurForRrpTotal;
    const sourcingMarginPct = (sourcingMarginEur / rrpEurTotal) * 100;
    rows.push(["Total RRP value (EUR)", `${formatMoney(rrpEurTotal)} EUR`]);
    rows.push(["Average discount to client vs RRP", `${avgDiscountToClientPct.toFixed(1)}%`]);
    rows.push([
      "Sourcing margin (RRP vs cost, EUR)",
      `${formatMoney(sourcingMarginEur)} EUR (${sourcingMarginPct.toFixed(1)}%)`,
    ]);
  }
  rows.push([
    "Gross margin (sell - cost, EUR)",
    `${formatMoney(marginEurTotal)} EUR (${sellEurTotal > 0 ? ((marginEurTotal / sellEurTotal) * 100).toFixed(1) : "0.0"}%)`,
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
        `${formatMoney(shippingInEur)} EUR (${formatMoney(quote.shippingInCost)} ${quote.shippingInCurrency ?? ""})`,
      ]);
    }
    if (quote.shippingOutCost !== null) {
      rows.push([
        "Shipping out (EUR)",
        `${formatMoney(shippingOutEur)} EUR (${formatMoney(quote.shippingOutCost)} ${quote.shippingOutCurrency ?? ""})`,
      ]);
    }
    if (quote.samplesCost !== null) {
      rows.push([
        "Samples (EUR)",
        `${formatMoney(samplesEur)} EUR (${formatMoney(quote.samplesCost)} ${quote.samplesCurrency ?? ""})`,
      ]);
    }
    const netMarginEur = marginEurTotal - shippingInEur - shippingOutEur - samplesEur;
    const netMarginPct = sellEurTotal > 0 ? (netMarginEur / sellEurTotal) * 100 : null;
    rows.push([
      "Net margin (after shipping + samples, EUR)",
      `${netMarginEur >= 0 ? "+" : ""}${formatMoney(netMarginEur)} EUR${netMarginPct !== null ? ` (${netMarginPct.toFixed(1)}%)` : ""}`,
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
    { wch: 16 }, // Cost price
    { wch: 16 }, // RRP
    { wch: 16 }, // Buying disc. vs RRP
    { wch: 16 }, // Sell price
    { wch: 16 }, // Selling disc. vs RRP
    { wch: 18 }, // Line total
    { wch: 16 }, // Margin
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

  // Editable line items - a saved quote's product/qty/supplier/cost/sell/RRP
  // can be corrected after the fact (typo fixes, supplier swaps mid-deal,
  // customer adds/drops a product) without deleting and re-saving the whole
  // quote. Free-text form state per field, same pattern as ShipForm above.
  type ItemForm = {
    product: string;
    brand: string;
    sku: string;
    qty: string;
    supplier: string;
    costPrice: string;
    costCurrency: string;
    sellPrice: string;
    sellCurrency: string;
    rrp: string;
  };
  const emptyItemForm = (): ItemForm => ({
    product: "",
    brand: "",
    sku: "",
    qty: "",
    supplier: "",
    costPrice: "",
    costCurrency: "EUR",
    sellPrice: "",
    sellCurrency: "EUR",
    rrp: "",
  });
  const itemFormFromItem = (it: QuoteItem): ItemForm => ({
    product: it.product,
    brand: it.brand ?? "",
    sku: it.sku ?? "",
    qty: it.qty !== null ? String(it.qty) : "",
    supplier: it.supplier ?? "",
    costPrice: it.costPrice !== null ? String(it.costPrice) : "",
    costCurrency: it.costCurrency ?? "EUR",
    sellPrice: it.sellPrice !== null ? String(it.sellPrice) : "",
    sellCurrency: it.sellCurrency ?? "EUR",
    rrp: it.rrp !== null ? String(it.rrp) : "",
  });

  const [editingItem, setEditingItem] = useState<{ quoteId: number; itemId: number } | null>(null);
  const [itemForm, setItemForm] = useState<ItemForm | null>(null);
  const [savingItem, setSavingItem] = useState(false);
  const [itemError, setItemError] = useState<Record<number, string>>({});
  const [addingItemQuoteId, setAddingItemQuoteId] = useState<number | null>(null);
  const [newItemForm, setNewItemForm] = useState<ItemForm>(emptyItemForm());

  const parseItemForm = (form: ItemForm): { input?: QuoteItemInput; error?: string } => {
    if (!form.product.trim()) return { error: "Product is required." };
    const parseNum = (v: string): number | null | undefined => {
      const t = v.trim();
      if (t === "") return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : undefined;
    };
    const qty = parseNum(form.qty);
    const costPrice = parseNum(form.costPrice);
    const sellPrice = parseNum(form.sellPrice);
    const rrp = parseNum(form.rrp);
    if (qty === undefined || costPrice === undefined || sellPrice === undefined || rrp === undefined) {
      return { error: "Enter valid numbers, or leave a field blank to clear it." };
    }
    return {
      input: {
        product: form.product.trim(),
        brand: form.brand.trim() || null,
        sku: form.sku.trim() || null,
        qty,
        supplier: form.supplier.trim() || null,
        costPrice,
        costCurrency: form.costCurrency,
        sellPrice,
        sellCurrency: form.sellCurrency,
        rrp,
      },
    };
  };

  const startEditItem = (quoteId: number, it: QuoteItem) => {
    setEditingItem({ quoteId, itemId: it.id });
    setItemForm(itemFormFromItem(it));
    setItemError((prev) => ({ ...prev, [quoteId]: "" }));
  };

  const cancelEditItem = () => {
    setEditingItem(null);
    setItemForm(null);
  };

  const handleSaveItem = async (quoteId: number, itemId: number) => {
    if (!itemForm) return;
    const parsed = parseItemForm(itemForm);
    if (parsed.error || !parsed.input) {
      setItemError((prev) => ({ ...prev, [quoteId]: parsed.error ?? "Invalid item." }));
      return;
    }
    setSavingItem(true);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/items/${itemId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.input),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save item.");
      setExpanded((prev) => {
        const q = prev[quoteId];
        if (!q) return prev;
        return { ...prev, [quoteId]: { ...q, items: q.items.map((i) => (i.id === itemId ? data : i)) } };
      });
      setItemError((prev) => ({ ...prev, [quoteId]: "" }));
      cancelEditItem();
    } catch (err) {
      setItemError((prev) => ({
        ...prev,
        [quoteId]: err instanceof Error ? err.message : "Failed to save item.",
      }));
    } finally {
      setSavingItem(false);
    }
  };

  const handleDeleteItem = async (quoteId: number, itemId: number) => {
    if (!confirm("Remove this line item?")) return;
    const res = await fetch(`/api/quotes/${quoteId}/items/${itemId}`, { method: "DELETE" });
    if (!res.ok) {
      setItemError((prev) => ({ ...prev, [quoteId]: "Failed to remove item." }));
      return;
    }
    setExpanded((prev) => {
      const q = prev[quoteId];
      if (!q) return prev;
      return { ...prev, [quoteId]: { ...q, items: q.items.filter((i) => i.id !== itemId) } };
    });
    setQuotes((prev) => prev.map((q) => (q.id === quoteId ? { ...q, itemCount: Math.max(0, q.itemCount - 1) } : q)));
    if (editingItem?.quoteId === quoteId && editingItem.itemId === itemId) cancelEditItem();
  };

  const handleAddItem = async (quoteId: number) => {
    const parsed = parseItemForm(newItemForm);
    if (parsed.error || !parsed.input) {
      setItemError((prev) => ({ ...prev, [quoteId]: parsed.error ?? "Invalid item." }));
      return;
    }
    setSavingItem(true);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.input),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add item.");
      setExpanded((prev) => {
        const q = prev[quoteId];
        if (!q) return prev;
        return { ...prev, [quoteId]: { ...q, items: [...q.items, data] } };
      });
      setQuotes((prev) => prev.map((q) => (q.id === quoteId ? { ...q, itemCount: q.itemCount + 1 } : q)));
      setItemError((prev) => ({ ...prev, [quoteId]: "" }));
      setNewItemForm(emptyItemForm());
      setAddingItemQuoteId(null);
    } catch (err) {
      setItemError((prev) => ({
        ...prev,
        [quoteId]: err instanceof Error ? err.message : "Failed to add item.",
      }));
    } finally {
      setSavingItem(false);
    }
  };

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
                                <th className="py-2 pr-2"></th>
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
                                const isEditing = editingItem?.quoteId === q.id && editingItem.itemId === it.id;

                                if (isEditing && itemForm) {
                                  return (
                                    <tr key={it.id} className="border-b border-gray-100 last:border-0">
                                      <td colSpan={8} className="bg-gray-50 px-3 py-3">
                                        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                                          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                                            Editing line item
                                          </p>
                                          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
                                            <label className="block text-xs font-medium text-gray-500">
                                              Product
                                              <input
                                                className="input mt-1 w-full"
                                                value={itemForm.product}
                                                onChange={(e) => setItemForm({ ...itemForm, product: e.target.value })}
                                              />
                                            </label>
                                            <label className="block text-xs font-medium text-gray-500">
                                              Brand
                                              <input
                                                className="input mt-1 w-full"
                                                value={itemForm.brand}
                                                onChange={(e) => setItemForm({ ...itemForm, brand: e.target.value })}
                                              />
                                            </label>
                                            <label className="block text-xs font-medium text-gray-500">
                                              SKU
                                              <input
                                                className="input mt-1 w-full"
                                                value={itemForm.sku}
                                                onChange={(e) => setItemForm({ ...itemForm, sku: e.target.value })}
                                              />
                                            </label>
                                            <label className="block text-xs font-medium text-gray-500">
                                              Qty
                                              <input
                                                type="number"
                                                className="input mt-1 w-full"
                                                value={itemForm.qty}
                                                onChange={(e) => setItemForm({ ...itemForm, qty: e.target.value })}
                                              />
                                            </label>
                                            <label className="block text-xs font-medium text-gray-500">
                                              Supplier
                                              <input
                                                className="input mt-1 w-full"
                                                value={itemForm.supplier}
                                                onChange={(e) => setItemForm({ ...itemForm, supplier: e.target.value })}
                                              />
                                            </label>
                                            <label className="block text-xs font-medium text-gray-500">
                                              Cost price
                                              <div className="mt-1 flex gap-1.5">
                                                <input
                                                  type="number"
                                                  className="input w-full"
                                                  value={itemForm.costPrice}
                                                  onChange={(e) => setItemForm({ ...itemForm, costPrice: e.target.value })}
                                                />
                                                <select
                                                  className="input w-20 shrink-0"
                                                  value={itemForm.costCurrency}
                                                  onChange={(e) => setItemForm({ ...itemForm, costCurrency: e.target.value })}
                                                >
                                                  {SUPPORTED_CURRENCIES.map((c) => (
                                                    <option key={c} value={c}>
                                                      {c}
                                                    </option>
                                                  ))}
                                                </select>
                                              </div>
                                            </label>
                                            <label className="block text-xs font-medium text-gray-500">
                                              RRP{" "}
                                              <span className="font-normal normal-case text-gray-400">
                                                (in {itemForm.costCurrency})
                                              </span>
                                              <input
                                                type="number"
                                                className="input mt-1 w-full"
                                                value={itemForm.rrp}
                                                onChange={(e) => setItemForm({ ...itemForm, rrp: e.target.value })}
                                              />
                                            </label>
                                            <label className="block text-xs font-medium text-gray-500">
                                              Sell price
                                              <div className="mt-1 flex gap-1.5">
                                                <input
                                                  type="number"
                                                  className="input w-full"
                                                  value={itemForm.sellPrice}
                                                  onChange={(e) => setItemForm({ ...itemForm, sellPrice: e.target.value })}
                                                />
                                                <select
                                                  className="input w-20 shrink-0"
                                                  value={itemForm.sellCurrency}
                                                  onChange={(e) => setItemForm({ ...itemForm, sellCurrency: e.target.value })}
                                                >
                                                  {SUPPORTED_CURRENCIES.map((c) => (
                                                    <option key={c} value={c}>
                                                      {c}
                                                    </option>
                                                  ))}
                                                </select>
                                              </div>
                                            </label>
                                          </div>
                                          <div className="mt-4 flex items-center gap-2 border-t border-gray-100 pt-3">
                                            <button
                                              onClick={() => handleSaveItem(q.id, it.id)}
                                              disabled={savingItem}
                                              className="rounded-md bg-gray-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                                            >
                                              {savingItem ? "Saving…" : "Save changes"}
                                            </button>
                                            <button
                                              onClick={cancelEditItem}
                                              className="rounded-md border border-gray-300 px-4 py-1.5 text-xs text-gray-600 hover:border-gray-400"
                                            >
                                              Cancel
                                            </button>
                                          </div>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                }

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
                                    <td className="py-2 pr-2">
                                      <div className="flex gap-2 text-xs">
                                        <button
                                          onClick={() => startEditItem(q.id, it)}
                                          className="text-gray-400 hover:text-gray-700"
                                        >
                                          Edit
                                        </button>
                                        <button
                                          onClick={() => handleDeleteItem(q.id, it.id)}
                                          className="text-gray-400 hover:text-red-600"
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        {itemError[q.id] && <p className="mt-2 text-xs text-red-600">{itemError[q.id]}</p>}

                        <div className="mt-3">
                          {addingItemQuoteId === q.id ? (
                            <div className="rounded-lg border border-gray-200 p-3">
                              <p className="mb-2 text-xs font-medium uppercase text-gray-500">Add item</p>
                              <div className="flex flex-wrap items-end gap-2">
                                <label className="block text-xs text-gray-600">
                                  Product
                                  <input
                                    className="input mt-1 w-36"
                                    value={newItemForm.product}
                                    onChange={(e) => setNewItemForm({ ...newItemForm, product: e.target.value })}
                                  />
                                </label>
                                <label className="block text-xs text-gray-600">
                                  Brand
                                  <input
                                    className="input mt-1 w-24"
                                    value={newItemForm.brand}
                                    onChange={(e) => setNewItemForm({ ...newItemForm, brand: e.target.value })}
                                  />
                                </label>
                                <label className="block text-xs text-gray-600">
                                  SKU
                                  <input
                                    className="input mt-1 w-20"
                                    value={newItemForm.sku}
                                    onChange={(e) => setNewItemForm({ ...newItemForm, sku: e.target.value })}
                                  />
                                </label>
                                <label className="block text-xs text-gray-600">
                                  Qty
                                  <input
                                    type="number"
                                    className="input mt-1 w-16"
                                    value={newItemForm.qty}
                                    onChange={(e) => setNewItemForm({ ...newItemForm, qty: e.target.value })}
                                  />
                                </label>
                                <label className="block text-xs text-gray-600">
                                  Supplier
                                  <input
                                    className="input mt-1 w-24"
                                    value={newItemForm.supplier}
                                    onChange={(e) => setNewItemForm({ ...newItemForm, supplier: e.target.value })}
                                  />
                                </label>
                                <label className="block text-xs text-gray-600">
                                  RRP
                                  <input
                                    type="number"
                                    className="input mt-1 w-20"
                                    value={newItemForm.rrp}
                                    onChange={(e) => setNewItemForm({ ...newItemForm, rrp: e.target.value })}
                                  />
                                </label>
                                <label className="block text-xs text-gray-600">
                                  Cost
                                  <div className="mt-1 flex gap-1">
                                    <input
                                      type="number"
                                      className="input w-20"
                                      value={newItemForm.costPrice}
                                      onChange={(e) => setNewItemForm({ ...newItemForm, costPrice: e.target.value })}
                                    />
                                    <select
                                      className="input w-16"
                                      value={newItemForm.costCurrency}
                                      onChange={(e) => setNewItemForm({ ...newItemForm, costCurrency: e.target.value })}
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
                                  Sell
                                  <div className="mt-1 flex gap-1">
                                    <input
                                      type="number"
                                      className="input w-20"
                                      value={newItemForm.sellPrice}
                                      onChange={(e) => setNewItemForm({ ...newItemForm, sellPrice: e.target.value })}
                                    />
                                    <select
                                      className="input w-16"
                                      value={newItemForm.sellCurrency}
                                      onChange={(e) => setNewItemForm({ ...newItemForm, sellCurrency: e.target.value })}
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
                                  onClick={() => handleAddItem(q.id)}
                                  disabled={savingItem}
                                  className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                                >
                                  {savingItem ? "Adding…" : "Add"}
                                </button>
                                <button
                                  onClick={() => {
                                    setAddingItemQuoteId(null);
                                    setItemError((prev) => ({ ...prev, [q.id]: "" }));
                                  }}
                                  className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:border-gray-400"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                setAddingItemQuoteId(q.id);
                                setNewItemForm(emptyItemForm());
                                setItemError((prev) => ({ ...prev, [q.id]: "" }));
                              }}
                              className="text-xs font-medium text-gray-500 hover:text-gray-900"
                            >
                              + Add item
                            </button>
                          )}
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
