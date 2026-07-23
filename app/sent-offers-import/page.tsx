"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Offer } from "@/lib/types";
import { EurRates, fromEur, toEur } from "@/lib/currency";
import {
  SentOfferColumnMapping,
  SentOfferColumnRole,
  SENT_OFFER_ROLE_LABELS,
  SentOfferItem,
  buildSentOfferItems,
  detectSentOfferColumns,
  findSentOfferHeaderRow,
} from "@/lib/sentOfferImport";
import { detectDelimiter, parseDelimited, readFileAsRows } from "@/lib/smartImport";

type MatchResultRow = { item: SentOfferItem; offers: Offer[] };
type MatchResponse = { results: MatchResultRow[]; summary: { total: number; matched: number; unmatched: number }; truncated: boolean };
type SavedQuote = { client: string; quoteId: number; items: number };

const ROLE_OPTIONS: SentOfferColumnRole[] = ["client", "product", "brand", "sku", "price", "rrp", "currency", "qty", "ignore"];

async function saveByClient(
  results: MatchResultRow[],
  pickOffer: (rowIndex: number, offers: Offer[]) => Offer | null
): Promise<SavedQuote[]> {
  const byClient = new Map<string, { item: SentOfferItem; offer: Offer | null }[]>();
  results.forEach((r, i) => {
    const list = byClient.get(r.item.client) ?? [];
    list.push({ item: r.item, offer: pickOffer(i, r.offers) });
    byClient.set(r.item.client, list);
  });

  const today = new Date().toISOString().slice(0, 10);
  const saved: SavedQuote[] = [];
  for (const [client, lines] of byClient) {
    const items = lines.map(({ item, offer }) => ({
      offerId: offer?.id ?? null,
      brand: item.brand,
      product: item.product,
      sku: item.sku,
      qty: item.qty,
      supplier: offer?.supplier ?? null,
      costPrice: offer?.price ?? null,
      costCurrency: offer?.currency ?? null,
      sellPrice: item.price,
      sellCurrency: item.currency || "EUR",
      // Uploaded RRP (mapped straight from the client's own file) always
      // wins when present - it's more authoritative than a matched offer's
      // RRP, which is only a fallback for when the file didn't have one.
      rrp: item.rrp ?? offer?.rrp ?? null,
    }));
    const res = await fetch("/api/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: client,
        notes: `Bulk import ${today} - sent offers by SKU/EAN`,
        items,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Failed to save quote for ${client}.`);
    saved.push({ client, quoteId: data.id, items: items.length });
  }
  return saved;
}

export default function SentOffersImportPage() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [headerRowIndex, setHeaderRowIndex] = useState(-1);
  const [mapping, setMapping] = useState<SentOfferColumnMapping[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");

  // Some files (e.g. a selection/quantity export for one account) have no
  // per-row client column at all - this covers every row in that case. A
  // per-row "Client" column, if the file has one, always wins over this.
  const [defaultClient, setDefaultClient] = useState("");

  // Off by default - most uploads are logging a sale price only, nothing to
  // do with cost. When on, every row gets matched against the price book
  // (by SKU/EAN) to snapshot a supplier/cost/RRP alongside the sale price.
  const [matchForCost, setMatchForCost] = useState(false);
  const [reviewFirst, setReviewFirst] = useState(false);

  const [eurRates, setEurRates] = useState<EurRates>({ EUR: 1 });
  useEffect(() => {
    fetch("/api/fx-rates")
      .then((r) => r.json())
      .then((data) => setEurRates((prev) => (data && typeof data === "object" ? data : prev)))
      .catch(() => {});
  }, []);

  // Review-first path: match, then let the user pick a cost basis per row
  // before an explicit save.
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [response, setResponse] = useState<MatchResponse | null>(null);
  const [costChoice, setCostChoice] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSummary, setSaveSummary] = useState<SavedQuote[] | null>(null);

  // Quick path: match + save in one click, cheapest offer picked
  // automatically for every row (Sales Pipeline already lets you edit any
  // line's cost/supplier afterward, so there's no need for a review gate
  // here too).
  const [quickImporting, setQuickImporting] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [quickResult, setQuickResult] = useState<{
    saved: SavedQuote[];
    matchedCost: boolean;
    matched: number;
    unmatched: number;
    skipped: number;
  } | null>(null);

  const resetResults = () => {
    setResponse(null);
    setMatchError(null);
    setCostChoice({});
    setSaveSummary(null);
    setSaveError(null);
    setQuickResult(null);
    setQuickError(null);
  };

  const loadGrid = (grid: string[][], name: string) => {
    if (grid.length === 0) {
      setReadError("This file appears to be empty.");
      setRows([]);
      setMapping([]);
      return;
    }
    const hIdx = findSentOfferHeaderRow(grid);
    const detectedMapping = hIdx >= 0 ? detectSentOfferColumns(grid[hIdx]) : detectSentOfferColumns(grid[0]);
    setFileName(name);
    setRows(grid);
    setHeaderRowIndex(hIdx >= 0 ? hIdx : -1);
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

  const setRole = (index: number, role: SentOfferColumnRole) => {
    setMapping((prev) => prev.map((m) => (m.index === index ? { ...m, role } : m)));
    resetResults();
  };

  const preview = rows.length > 0 ? buildSentOfferItems(rows, headerRowIndex, mapping, defaultClient) : null;
  const mappingRoles = new Set(mapping.map((m) => m.role));
  const hasClient = mappingRoles.has("client") || defaultClient.trim() !== "";
  const mappingReady = hasClient && mappingRoles.has("price") && (mappingRoles.has("product") || mappingRoles.has("sku"));

  // Clears the loaded input (rows/mapping/file) so the form is ready for the
  // next batch - deliberately does NOT touch quickResult/saveSummary, so a
  // just-shown success message stays visible instead of vanishing itself.
  const clearInputs = () => {
    setRows([]);
    setMapping([]);
    setFileName(null);
    setPasteText("");
  };

  // Quick path - save immediately. If matchForCost is on, matches every row
  // against the price book first and picks the cheapest as cost basis;
  // otherwise saves sell price/qty only, with no cost/supplier/RRP at all.
  const handleQuickImport = async () => {
    if (!preview || preview.items.length === 0) return;
    setQuickImporting(true);
    setQuickError(null);
    setQuickResult(null);
    try {
      let saved: SavedQuote[];
      let matched = 0;
      let unmatched = preview.items.length;
      if (matchForCost) {
        const res = await fetch("/api/inquiry/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: preview.items }),
        });
        const data = (await res.json()) as MatchResponse;
        if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? "Failed to match items.");
        saved = await saveByClient(data.results, (_i, offers) => offers[0] ?? null);
        matched = data.summary.matched;
        unmatched = data.summary.unmatched;
      } else {
        const results: MatchResultRow[] = preview.items.map((item) => ({ item, offers: [] }));
        saved = await saveByClient(results, () => null);
      }
      setQuickResult({
        saved,
        matchedCost: matchForCost,
        matched,
        unmatched,
        skipped: preview.errors.length,
      });
      clearInputs();
    } catch (err) {
      setQuickError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setQuickImporting(false);
    }
  };

  // Review-first path - separate match step, then an editable preview table.
  const runMatch = async () => {
    if (!preview || preview.items.length === 0) return;
    setMatching(true);
    setMatchError(null);
    try {
      const res = await fetch("/api/inquiry/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: preview.items }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to match items.");
      setResponse(data);
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : "Failed to match items.");
    } finally {
      setMatching(false);
    }
  };

  const costInSellCurrency = (offer: Offer, sellCurrency: string): number =>
    fromEur(toEur(offer.price, offer.currency, eurRates), sellCurrency, eurRates);

  const handleSave = async () => {
    if (!response) return;
    setSaving(true);
    setSaveError(null);
    setSaveSummary(null);
    try {
      const saved = await saveByClient(response.results, (i, offers) => offers[costChoice[i] ?? 0] ?? null);
      setSaveSummary(saved);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save one or more quotes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Import Sent Offers</h1>
          <p className="mt-1 text-sm text-gray-500">
            Paste or upload prices already offered to clients by SKU/EAN - client, product/EAN, and price is all
            you need (add quantity and RRP columns too if you have them - map RRP below to use your own figure).
            Cost and supplier from the price book are optional - off unless you turn them on below.
          </p>
        </div>
        <Link href="/quotes" className="text-sm text-gray-500 hover:text-gray-900">
          Go to Sales Pipeline →
        </Link>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Client for this batch</label>
          <p className="mt-1 text-xs text-gray-500">
            Only needed if your file doesn&apos;t already have a Client column (e.g. a single-account selection
            export) - if it does, that column wins for each row regardless of what you type here.
          </p>
          <input
            type="text"
            value={defaultClient}
            onChange={(e) => {
              setDefaultClient(e.target.value);
              resetResults();
            }}
            placeholder="e.g. Notino"
            className="input mt-2 w-full max-w-xs"
          />
        </div>

        <div className="border-t border-gray-100 pt-4">
          <label className="block text-sm font-medium text-gray-700">…paste rows</label>
          <p className="mt-1 text-xs text-gray-500">One row per line - client, brand/product, EAN, price, qty, RRP (all optional except client/product/price). Straight from Excel works fine.</p>
          <textarea
            className="input mt-2 w-full font-mono text-xs"
            rows={5}
            placeholder={"Client, Brand, Product, EAN, Price, Qty, RRP\nNotino, Byoma, Milky Toner 200ml, 8697991005678, 9.90, 500, 19.99"}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <button
            onClick={handlePasteParse}
            className="mt-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:border-gray-400"
          >
            Load pasted rows
          </button>
        </div>

        <div className="border-t border-gray-100 pt-4">
          <label className="block text-sm font-medium text-gray-700">…or upload a file</label>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            className="mt-2 block text-sm"
          />
          {fileName && <p className="mt-2 text-xs text-gray-500">Loaded: {fileName}</p>}
          {readError && <p className="mt-2 text-sm text-red-600">{readError}</p>}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800">Confirm columns</h2>
          <p className="text-xs text-gray-500">
            {mappingReady
              ? `${preview?.items.length ?? 0} row(s) ready - check the mapping below before importing.`
              : hasClient
                ? "Couldn't auto-detect everything needed (price, and a product name or EAN) - set the missing ones below."
                : "No client column found and no client typed above - either set one below or fill in \"Client for this batch\" above."}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 uppercase tracking-wider">
                  <th className="px-3 py-2 text-left">Column</th>
                  <th className="px-3 py-2 text-left">Sample</th>
                  <th className="px-3 py-2 text-left">Role</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {mapping.map((m) => {
                  const sampleRow = headerRowIndex >= 0 ? rows[headerRowIndex + 1] : rows[0];
                  return (
                    <tr key={m.index}>
                      <td className="px-3 py-2 font-medium text-gray-700">{m.header || `Column ${m.index + 1}`}</td>
                      <td className="px-3 py-2 text-gray-400">{sampleRow?.[m.index] ?? ""}</td>
                      <td className="px-3 py-2">
                        <select
                          value={m.role}
                          onChange={(e) => setRole(m.index, e.target.value as SentOfferColumnRole)}
                          className="input"
                        >
                          {ROLE_OPTIONS.map((role) => (
                            <option key={role} value={role}>
                              {SENT_OFFER_ROLE_LABELS[role]}
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

          <div className="border-t border-gray-100 pt-3 space-y-2">
            <label className="flex items-center gap-1.5 text-sm text-gray-700">
              <input type="checkbox" checked={matchForCost} onChange={(e) => setMatchForCost(e.target.checked)} />
              Also look up cost, supplier &amp; RRP from the price book (by SKU/EAN)
            </label>
            <p className="text-xs text-gray-500 pl-5">
              Off by default - leave unchecked to just log the sale price with no cost data attached.
            </p>
            {matchForCost && (
              <label className="flex items-center gap-1.5 text-sm text-gray-500 pl-5">
                <input type="checkbox" checked={reviewFirst} onChange={(e) => setReviewFirst(e.target.checked)} />
                Review matches before saving
              </label>
            )}
          </div>

          <div className="flex items-center gap-3 pt-1">
            {matchForCost && reviewFirst ? (
              <button
                onClick={runMatch}
                disabled={!mappingReady || matching || !preview || preview.items.length === 0}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:border-gray-400"
              >
                {matching ? "Matching…" : `Match ${preview?.items.length ?? 0} row(s) & review`}
              </button>
            ) : (
              <button
                onClick={handleQuickImport}
                disabled={!mappingReady || quickImporting || !preview || preview.items.length === 0}
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {quickImporting ? "Importing…" : `Import ${preview?.items.length ?? 0} row(s)`}
              </button>
            )}
          </div>
          {matchError && <p className="text-sm text-red-600">{matchError}</p>}
          {quickError && <p className="text-sm text-red-600">{quickError}</p>}
        </div>
      )}

      {preview && preview.errors.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-semibold text-amber-700 mb-1">Skipped rows</p>
          {preview.errors.map((e, i) => (
            <p key={i} className="text-xs text-gray-500">
              Line {e.line}: {e.message}
            </p>
          ))}
        </div>
      )}

      {quickResult && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 space-y-2">
          <p className="text-sm font-semibold text-emerald-800">
            {quickResult.matchedCost
              ? `Imported - ${quickResult.matched} matched to a cost, ${quickResult.unmatched} saved without one`
              : `Imported - sale price only, no cost data attached`}
            {quickResult.skipped > 0 ? `, ${quickResult.skipped} row(s) skipped` : ""}.
          </p>
          {quickResult.saved.map((s) => (
            <p key={s.quoteId} className="text-sm text-emerald-700">
              {s.items} item(s) for <strong>{s.client}</strong>
            </p>
          ))}
          <Link href="/quotes" className="inline-block mt-2 text-sm font-medium text-emerald-800 underline">
            View in Sales Pipeline →
          </Link>
        </div>
      )}

      {response && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-800">
              Preview - {response.summary.matched} matched, {response.summary.unmatched} unmatched
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 uppercase tracking-wider">
                  <th className="px-3 py-2 text-left">Client</th>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-left">SKU</th>
                  <th className="px-3 py-2 text-left">Qty</th>
                  <th className="px-3 py-2 text-left">Price sent</th>
                  <th className="px-3 py-2 text-left">Cost basis</th>
                  <th className="px-3 py-2 text-left">RRP</th>
                  <th className="px-3 py-2 text-left">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {response.results.map((r, i) => {
                  const chosenIdx = costChoice[i] ?? 0;
                  const offer = r.offers[chosenIdx] ?? null;
                  const sellCurrency = r.item.currency || "EUR";
                  const cost = offer ? costInSellCurrency(offer, sellCurrency) : null;
                  const margin = cost !== null ? (((r.item.price - cost) / r.item.price) * 100).toFixed(1) : null;
                  return (
                    <tr key={i} className={r.offers.length === 0 ? "bg-amber-50/40" : undefined}>
                      <td className="px-3 py-2 font-medium text-gray-700">{r.item.client}</td>
                      <td className="px-3 py-2">
                        {r.item.brand ? `${r.item.brand} · ` : ""}
                        {r.item.product}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">{r.item.sku ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{r.item.qty ?? "—"}</td>
                      <td className="px-3 py-2">
                        {r.item.price.toFixed(2)} {sellCurrency}
                      </td>
                      <td className="px-3 py-2">
                        {r.offers.length === 0 ? (
                          <span className="text-xs text-amber-700">No match found</span>
                        ) : (
                          <select
                            value={chosenIdx}
                            onChange={(e) => setCostChoice((prev) => ({ ...prev, [i]: Number(e.target.value) }))}
                            className="input text-xs"
                          >
                            {r.offers.map((o, oi) => (
                              <option key={o.id} value={oi}>
                                {o.supplier} — {o.price} {o.currency}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">{r.item.rrp ?? offer?.rrp ?? "—"}</td>
                      <td className="px-3 py-2 text-xs font-semibold text-gray-700">{margin !== null ? `${margin}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : `Save as quotes (${new Set(response.results.map((r) => r.item.client)).size} client(s))`}
            </button>
            {saveError && <p className="mt-2 text-sm text-red-600">{saveError}</p>}
            {saveSummary && (
              <div className="mt-3 space-y-1 text-sm">
                {saveSummary.map((s) => (
                  <p key={s.quoteId} className="text-emerald-700">
                    Saved {s.items} item(s) for <strong>{s.client}</strong> —{" "}
                    <Link href="/quotes" className="underline">
                      view in Sales Pipeline
                    </Link>
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
