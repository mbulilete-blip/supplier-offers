"use client";

import { useEffect, useMemo, useState } from "react";

type Offer = {
  id: number;
  supplier: string;
  brand: string;
  product: string;
  sku: string | null;
  price: number;
  currency: string;
  rrp: number | null;
  moq: number | null;
  leadTimeDays: number | null;
  paymentTerms: string | null;
  region: string | null;
  notes: string | null;
  createdAt: string;
};

const emptyForm = {
  supplier: "",
  brand: "",
  product: "",
  sku: "",
  price: "",
  currency: "EUR",
  rrp: "",
  moq: "",
  leadTimeDays: "",
  paymentTerms: "",
  region: "",
  notes: "",
};

export default function DashboardPage() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [csvText, setCsvText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: number;
    errors: { line: number; message: string }[];
  } | null>(null);

  const load = async () => {
    setLoading(true);
    const res = await fetch("/api/offers");
    const data = await res.json();
    setOffers(data);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return offers;
    return offers.filter(
      (o) =>
        o.product.toLowerCase().includes(q) ||
        o.brand.toLowerCase().includes(q) ||
        o.supplier.toLowerCase().includes(q) ||
        (o.sku ?? "").toLowerCase().includes(q)
    );
  }, [offers, search]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.supplier || !form.brand || !form.product || !form.price) {
      setError("Supplier, brand, product, and price are required.");
      return;
    }

    setSubmitting(true);
    const res = await fetch("/api/offers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supplier: form.supplier,
        brand: form.brand,
        product: form.product,
        sku: form.sku || null,
        price: Number(form.price),
        currency: form.currency || "EUR",
        rrp: form.rrp ? Number(form.rrp) : null,
        moq: form.moq ? Number(form.moq) : null,
        leadTimeDays: form.leadTimeDays ? Number(form.leadTimeDays) : null,
        paymentTerms: form.paymentTerms || null,
        region: form.region || null,
        notes: form.notes || null,
      }),
    });
    setSubmitting(false);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Something went wrong.");
      return;
    }

    setForm(emptyForm);
    load();
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this offer?")) return;
    await fetch(`/api/offers/${id}`, { method: "DELETE" });
    load();
  };

  const handleImport = async () => {
    if (!csvText.trim()) return;
    setImporting(true);
    setImportResult(null);
    const res = await fetch("/api/offers/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: csvText }),
    });
    const data = await res.json();
    setImporting(false);
    setImportResult(data);
    if (data.imported > 0) {
      setCsvText("");
      load();
    }
  };

  const handleFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
  };

  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-2xl font-semibold">All Offers</h1>
        <p className="mt-1 text-sm text-gray-500">
          Every offer you&apos;ve logged, across every supplier. Add one manually or import a
          batch via CSV below.
        </p>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-medium">Add an offer</h2>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Supplier *">
            <input
              className="input"
              value={form.supplier}
              onChange={(e) => setForm({ ...form, supplier: e.target.value })}
            />
          </Field>
          <Field label="Brand *">
            <input
              className="input"
              value={form.brand}
              onChange={(e) => setForm({ ...form, brand: e.target.value })}
            />
          </Field>
          <Field label="Product *">
            <input
              className="input"
              value={form.product}
              onChange={(e) => setForm({ ...form, product: e.target.value })}
            />
          </Field>
          <Field label="SKU">
            <input
              className="input"
              value={form.sku}
              onChange={(e) => setForm({ ...form, sku: e.target.value })}
            />
          </Field>
          <Field label="Price *">
            <input
              type="number"
              step="0.01"
              className="input"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
            />
          </Field>
          <Field label="Currency">
            <input
              className="input"
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
            />
          </Field>
          <Field label="RRP">
            <input
              type="number"
              step="0.01"
              className="input"
              value={form.rrp}
              onChange={(e) => setForm({ ...form, rrp: e.target.value })}
            />
          </Field>
          <Field label="MOQ">
            <input
              type="number"
              className="input"
              value={form.moq}
              onChange={(e) => setForm({ ...form, moq: e.target.value })}
            />
          </Field>
          <Field label="Lead time (days)">
            <input
              type="number"
              className="input"
              value={form.leadTimeDays}
              onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })}
            />
          </Field>
          <Field label="Payment terms">
            <input
              className="input"
              value={form.paymentTerms}
              onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
            />
          </Field>
          <Field label="Region">
            <input
              className="input"
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
          </Field>
          <Field label="Notes">
            <input
              className="input"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>

          <div className="col-span-2 flex items-center gap-3 sm:col-span-3">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {submitting ? "Adding…" : "Add offer"}
            </button>
            {error && <span className="text-sm text-red-600">{error}</span>}
          </div>
        </form>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-2 text-lg font-medium">Import from CSV</h2>
        <p className="mb-4 text-sm text-gray-500">
          Headers: <code>supplier, brand, product, sku, price, currency, rrp, moq,
          leadTimeDays, paymentTerms, region, notes</code>. Only supplier, brand, product,
          and price are required.
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
          onChange={(e) => setCsvText(e.target.value)}
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={handleImport}
            disabled={importing || !csvText.trim()}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {importing ? "Importing…" : "Import CSV"}
          </button>
          {importResult && (
            <span className="text-sm text-gray-600">
              Imported {importResult.imported} offer(s).
              {importResult.errors.length > 0 &&
                ` ${importResult.errors.length} row(s) skipped.`}
            </span>
          )}
        </div>
        {importResult && importResult.errors.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-xs text-red-600">
            {importResult.errors.map((e, i) => (
              <li key={i}>
                Line {e.line}: {e.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">
            {loading ? "Loading…" : `${filtered.length} offer(s)`}
          </h2>
          <input
            className="input w-64"
            placeholder="Search product, brand, supplier, SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Brand</th>
                <th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3">Price</th>
                <th className="px-4 py-3">MOQ</th>
                <th className="px-4 py-3">Lead time</th>
                <th className="px-4 py-3">Terms</th>
                <th className="px-4 py-3">Region</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr key={o.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 font-medium">
                    {o.product}
                    {o.sku && <div className="text-xs text-gray-400">{o.sku}</div>}
                  </td>
                  <td className="px-4 py-3">{o.brand}</td>
                  <td className="px-4 py-3">{o.supplier}</td>
                  <td className="px-4 py-3">
                    {o.price.toFixed(2)} {o.currency}
                  </td>
                  <td className="px-4 py-3">{o.moq ?? "—"}</td>
                  <td className="px-4 py-3">{o.leadTimeDays ? `${o.leadTimeDays}d` : "—"}</td>
                  <td className="px-4 py-3">{o.paymentTerms ?? "—"}</td>
                  <td className="px-4 py-3">{o.region ?? "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(o.id)}
                      className="text-xs text-red-500 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                    No offers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-gray-500">{label}</span>
      {children}
    </label>
  );
}
