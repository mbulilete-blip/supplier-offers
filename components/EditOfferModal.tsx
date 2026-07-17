"use client";

import { useEffect, useState } from "react";
import { Offer, OfferInput } from "@/lib/types";
import { formatMoney } from "@/lib/currency";

type PriceHistoryEntry = {
  id: number;
  price: number;
  currency: string;
  rrp: number | null;
  recordedAt: string;
};

type Props = {
  offer: Offer;
  onClose: () => void;
  onSaved: (updated: Offer) => void;
};

// Shared edit form used from every view that shows individual offers - the
// dashboard, Compare, Matrix, and History - so fixing a mistake (wrong
// supplier name, price, terms, etc.) works the same way no matter where you
// spotted it. Date added is intentionally not editable here: it reflects
// exactly when the row was created, and stays a system timestamp.
const FIELDS: { key: keyof OfferInput; label: string; type?: string; inputMode?: "numeric" }[] = [
  { key: "supplier", label: "Supplier" },
  { key: "brand", label: "Brand" },
  { key: "product", label: "Product" },
  { key: "sku", label: "SKU / EAN" },
  { key: "price", label: "Price", type: "number" },
  { key: "currency", label: "Currency" },
  { key: "rrp", label: "RRP", type: "number" },
  // MOQ and lead time are free text on purpose - unlike price/RRP, these are
  // often non-strict-numeric in practice (e.g. "500 (neg.)" or "2-3"), and a
  // number input's spinner/strict validation got in the way.
  { key: "moq", label: "MOQ" },
  // Free text on purpose - suppliers quote this as "6 weeks", "10-15 days",
  // "immediate", etc., not a strict day-count integer.
  { key: "leadTimeDays", label: "Lead time" },
  { key: "paymentTerms", label: "Payment terms" },
  { key: "region", label: "Region" },
  { key: "incoterm", label: "Incoterm" },
  { key: "marketOrigin", label: "Market origin" },
  { key: "availability", label: "Availability" },
  { key: "notes", label: "Notes" },
  // Link to the original uploaded price-list file this offer came from (set
  // per-batch on Check New Prices, but fixable here per-offer too). Rendered
  // with an "Open ↗" link alongside the input below whenever it has a value.
  { key: "sourceFileUrl", label: "Source file link" },
];

export default function EditOfferModal({ offer, onClose, onSaved }: Props) {
  const [form, setForm] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of FIELDS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = (offer as any)[f.key];
      initial[f.key] = v === null || v === undefined ? "" : String(v);
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Price history - loaded once per offer, independent of the edit form
  // state above. null while loading, [] once fetched with no entries (true
  // for any offer created before this feature shipped, since there's
  // nothing to backfill from).
  const [history, setHistory] = useState<PriceHistoryEntry[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    fetch(`/api/offers/${offer.id}/history`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setHistory(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [offer.id]);

  const handleChange = (key: string, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleSave = async () => {
    setError(null);

    const price = Number(form.price);
    if (!form.supplier.trim() || !form.brand.trim() || !form.product.trim() || Number.isNaN(price)) {
      setError("Supplier, brand, product, and a valid price are required.");
      return;
    }

    // MOQ and lead time are both free-text columns - suppliers routinely quote
    // things like "500 (neg.)" or "2-3 cartons", so no numeric validation here.
    const moq = form.moq.trim() || null;
    const leadTimeDays = form.leadTimeDays.trim() || null;

    const payload: Partial<OfferInput> = {
      supplier: form.supplier.trim(),
      brand: form.brand.trim(),
      product: form.product.trim(),
      sku: form.sku.trim() || null,
      price,
      currency: form.currency.trim() || "EUR",
      rrp: form.rrp.trim() === "" ? null : Number(form.rrp),
      moq,
      leadTimeDays,
      paymentTerms: form.paymentTerms.trim() || null,
      region: form.region.trim() || null,
      incoterm: form.incoterm.trim() || null,
      marketOrigin: form.marketOrigin.trim() || null,
      availability: form.availability.trim() || null,
      notes: form.notes.trim() || null,
      sourceFileUrl: form.sourceFileUrl.trim() || null,
    };

    setSaving(true);
    try {
      const res = await fetch(`/api/offers/${offer.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to save changes.");
      }
      const updated: Offer = await res.json();
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Edit offer</h2>
          <button onClick={onClose} className="text-sm text-gray-400 hover:text-gray-700">
            Close
          </button>
        </div>
        <p className="mb-4 text-xs text-gray-400">
          Added {new Date(offer.createdAt).toLocaleString()} - not editable.
        </p>

        <div className="mb-4 rounded-lg border border-gray-200 p-3">
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            className="flex w-full items-center justify-between text-left"
          >
            <span className="text-xs font-medium uppercase text-gray-500">
              Price history{history && history.length > 0 ? ` (${history.length})` : ""}
            </span>
            <span className="text-xs text-gray-400">{historyOpen ? "Hide ▲" : "Show ▼"}</span>
          </button>
          {historyOpen && (
            <div className="mt-2 text-xs">
              {history === null ? (
                <p className="py-1 text-gray-400">Loading…</p>
              ) : history.length === 0 ? (
                <p className="py-1 text-gray-400">
                  No price history recorded yet - tracking only covers changes made since this
                  feature shipped, so older edits aren&apos;t retroactively captured.
                </p>
              ) : (
                <div className="space-y-1">
                  {[...history]
                    .reverse()
                    .map((h, idx, arr) => {
                      const prev = arr[idx + 1];
                      const delta = prev ? h.price - prev.price : null;
                      const deltaPct = prev && prev.price !== 0 ? ((delta as number) / prev.price) * 100 : null;
                      return (
                        <div
                          key={h.id}
                          className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 py-1 last:border-0"
                        >
                          <span className="text-gray-500">{new Date(h.recordedAt).toLocaleString()}</span>
                          <span className="font-medium text-gray-900">
                            {formatMoney(h.price)} {h.currency}
                            {h.rrp !== null && (
                              <span className="ml-1 font-normal text-gray-400">
                                (RRP {formatMoney(h.rrp)})
                              </span>
                            )}
                          </span>
                          {delta !== null && (
                            <span className={delta === 0 ? "text-gray-400" : delta > 0 ? "text-red-600" : "text-green-700"}>
                              {delta > 0 ? "+" : ""}
                              {formatMoney(delta)}
                              {deltaPct !== null ? ` (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)` : ""}
                            </span>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          {FIELDS.map((f) => {
            const value = form[f.key] ?? "";
            const isSourceLink = f.key === "sourceFileUrl";
            return (
              <label
                key={f.key}
                className={`block text-xs text-gray-600 ${isSourceLink ? "col-span-2" : "col-span-1"}`}
              >
                <span className="flex items-center justify-between gap-2">
                  {f.label}
                  {isSourceLink && value.trim() !== "" && (
                    <a
                      href={value.trim()}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-blue-600 hover:underline"
                    >
                      Open ↗
                    </a>
                  )}
                </span>
                <input
                  className="input mt-1 w-full"
                  type={f.type ?? "text"}
                  inputMode={f.inputMode}
                  value={value}
                  onChange={(e) => handleChange(f.key, e.target.value)}
                  placeholder={isSourceLink ? "e.g. https://www.dropbox.com/s/..." : undefined}
                />
              </label>
            );
          })}
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
