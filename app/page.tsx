"use client";

import { useEffect, useState } from "react";

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

const PAGE_SIZE = 100;

export default function DashboardPage() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // searchInput tracks every keystroke; `search` is the debounced value that
  // actually triggers a (server-side, paginated) fetch, so typing doesn't
  // fire a request per character.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // Brand dropdown, populated from /api/brands, so browsing by brand doesn't
  // require typing the exact name out.
  const [brands, setBrands] = useState<{ brand: string; count: number }[]>([]);
  const [brand, setBrand] = useState("");

  // Same idea for suppliers - lets the user view only one supplier's offers.
  const [suppliers, setSuppliers] = useState<{ supplier: string; count: number }[]>([]);
  const [supplier, setSupplier] = useState("");

  const [csvText, setCsvText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: number;
    errors: { line: number; message: string }[];
  } | null>(null);

  const load = async (opts?: {
    page?: number;
    search?: string;
    brand?: string;
    supplier?: string;
  }) => {
    setLoading(true);
    const targetPage = opts?.page ?? page;
    const targetSearch = opts?.search ?? search;
    const targetBrand = opts?.brand ?? brand;
    const targetSupplier = opts?.supplier ?? supplier;
    const params = new URLSearchParams({
      page: String(targetPage),
      limit: String(PAGE_SIZE),
    });
    if (targetSearch) params.set("search", targetSearch);
    if (targetBrand) params.set("brand", targetBrand);
    if (targetSupplier) params.set("supplier", targetSupplier);
    const res = await fetch(`/api/offers?${params.toString()}`);
    const data = await res.json();
    setOffers(data.offers ?? []);
    setTotal(data.total ?? 0);
    setLoading(false);
  };

  // Debounce the search box: wait 300ms after the user stops typing, then
  // reset to page 1 and fetch just that filtered page from the server.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
      load({ page: 1, search: searchInput });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  useEffect(() => {
    load({ page: 1, search: "" });
    fetch("/api/brands")
      .then((r) => r.json())
      .then((data) => setBrands(Array.isArray(data) ? data : []));
    fetch("/api/suppliers")
      .then((r) => r.json())
      .then((data) => setSuppliers(Array.isArray(data) ? data : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBrandChange = (value: string) => {
    setBrand(value);
    setPage(1);
    load({ page: 1, brand: value });
  };

  const handleSupplierChange = (value: string) => {
    setSupplier(value);
    setPage(1);
    load({ page: 1, supplier: value });
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const goToPage = (p: number) => {
    const clamped = Math.min(Math.max(p, 1), totalPages);
    setPage(clamped);
    load({ page: clamped });
  };

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

  const [fixingBrands, setFixingBrands] = useState(false);
  const [fixResult, setFixResult] = useState<{ fixed: number; brands: string[] } | null>(null);

  const handleFixBrands = async () => {
    setFixingBrands(true);
    setFixResult(null);
    const res = await fetch("/api/admin/fix-brands", { method: "POST" });
    const data = await res.json();
    setFixingBrands(false);
    setFixResult(data);
    if (data.fixed > 0) {
      load();
      fetch("/api/brands")
        .then((r) => r.json())
        .then((d) => setBrands(Array.isArray(d) ? d : []));
    }
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

      <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-amber-900">
              Fix broken brand names from import
            </h2>
            <p className="mt-1 text-xs text-amber-700">
              A few source sheets had misaligned columns, leaving either a barcode number or the
              full product name in the brand field for a handful of rows (e.g. Huda Beauty&apos;s
              &quot;Easy Bake&quot;/&quot;Easy Prime&quot; line). This looks them up by source sheet
              and corrects the brand name. Safe to run any time — it&apos;s a no-op once everything
              is fixed.
            </p>
          </div>
          <button
            onClick={handleFixBrands}
            disabled={fixingBrands}
            className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {fixingBrands ? "Fixing…" : "Fix now"}
          </button>
        </div>
        {fixResult && (
          <p className="mt-2 text-xs text-amber-800">
            {fixResult.fixed > 0
              ? `Fixed ${fixResult.fixed} offer(s) across brand(s): ${fixResult.brands.join(", ")}.`
              : "No numeric brand names found — nothing to fix."}
          </p>
        )}
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
            {loading
              ? "Loading…"
              : `${total.toLocaleString()} offer(s) — page ${page} of ${totalPages}`}
          </h2>
          <div className="flex items-center gap-3">
            <select
              className="input w-56"
              value={brand}
              onChange={(e) => handleBrandChange(e.target.value)}
            >
              <option value="">All brands ({brands.reduce((sum, b) => sum + b.count, 0).toLocaleString()})</option>
              {brands.map((b) => (
                <option key={b.brand} value={b.brand}>
                  {b.brand} ({b.count.toLocaleString()})
                </option>
              ))}
            </select>
            <select
              className="input w-56"
              value={supplier}
              onChange={(e) => handleSupplierChange(e.target.value)}
            >
              <option value="">
                All suppliers ({suppliers.reduce((sum, s) => sum + s.count, 0).toLocaleString()})
              </option>
              {suppliers.map((s) => (
                <option key={s.supplier} value={s.supplier}>
                  {s.supplier} ({s.count.toLocaleString()})
                </option>
              ))}
            </select>
            <input
              className="input w-64"
              placeholder="Search product, brand, supplier, SKU…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
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
                <th className="px-4 py-3">Date added</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => (
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
                  <td className="px-4 py-3 whitespace-nowrap text-gray-500">
                    {o.createdAt ? new Date(o.createdAt).toLocaleDateString() : "—"}
                  </td>
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
              {!loading && offers.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                    No offers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-gray-500">
            Showing {offers.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–
            {(page - 1) * PAGE_SIZE + offers.length} of {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1 || loading}
              className="rounded-lg border border-gray-300 px-3 py-1.5 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages || loading}
              className="rounded-lg border border-gray-300 px-3 py-1.5 disabled:opacity-40"
            >
              Next
            </button>
          </div>
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
