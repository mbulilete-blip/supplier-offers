"use client";

import { useState } from "react";
import { Offer, OfferInput } from "@/lib/types";

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
const FIELDS: { key: keyof OfferInput; label: string; type?: string }[] = [
  { key: "supplier", label: "Supplier" },
  { key: "brand", label: "Brand" },
  { key: "product", label: "Product" },
  { key: "sku", label: "SKU / EAN" },
  { key: "price", label: "Price", type: "number" },
  { key: "currency", label: "Currency" },
  { key: "rrp", label: "RRP", type: "number" },
  { key: "moq", label: "MOQ", type: "number" },
  { key: "leadTimeDays", label: "Lead time (days)", type: "number" },
  { key: "paymentTerms", label: "Payment terms" },
  { key: "region", label: "Region" },
  { key: "incoterm", label: "Incoterm" },
  { key: "marketOrigin", label: "Market origin" },
  { key: "notes", label: "Notes" },
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

    const payload: Partial<OfferInput> = {
      supplier: form.supplier.trim(),
      brand: form.brand.trim(),
      product: form.product.trim(),
      sku: form.sku.trim() || null,
      price,
      currency: form.currency.trim() || "EUR",
      rrp: form.rrp.trim() === "" ? null : Number(form.rrp),
      moq: form.moq.trim() === "" ? null : Number(form.moq),
      leadTimeDays: form.leadTimeDays.trim() === "" ? null : Number(form.leadTimeDays),
      paymentTerms: form.paymentTerms.trim() || null,
      region: form.region.trim() || null,
      incoterm: form.incoterm.trim() || null,
      marketOrigin: form.marketOrigin.trim() || null,
      notes: form.notes.trim() || null,
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

        <div className="grid grid-cols-2 gap-3">
          {FIELDS.map((f) => (
            <label key={f.key} className="col-span-1 block text-xs text-gray-600">
              {f.label}
              <input
                className="input mt-1 w-full"
                type={f.type ?? "text"}
                value={form[f.key] ?? ""}
                onChange={(e) => handleChange(f.key, e.target.value)}
              />
            </label>
          ))}
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
