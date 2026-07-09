"use client";

import { useEffect, useState } from "react";
import { Offer } from "@/lib/types";
import EditOfferModal from "@/components/EditOfferModal";

const PAGE_SIZE = 100;

type Stats = {
  total: number;
  suppliers: number;
  brands: number;
  addedToday: number;
  addedThisWeek: number;
};

// Compact relative timestamp for the "Latest offers" panel - "2h ago" reads
// faster than a full date when you're just checking what came in recently.
const timeAgo = (iso: string): string => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
};

export default function DashboardPage() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [stats, setStats] = useState<Stats | null>(null);
  const [recentOffers, setRecentOffers] = useState<Offer[]>([]);

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

  const loadOverview = () => {
    fetch("/api/dashboard/stats")
      .then((r) => r.json())
      .then((data) => setStats(data));
    fetch("/api/offers/recent?limit=10")
      .then((r) => r.json())
      .then((data) => setRecentOffers(Array.isArray(data) ? data : []));
  };

  useEffect(() => {
    load({ page: 1, search: "" });
    loadOverview();
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

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this offer?")) return;
    await fetch(`/api/offers/${id}`, { method: "DELETE" });
    load();
    loadOverview();
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
      loadOverview();
    }
  };

  const handleFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
  };

  const [editingOffer, setEditingOffer] = useState<Offer | null>(null);

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
      loadOverview();
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
          Every offer you&apos;ve logged, across every supplier. Import a batch via CSV below.
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: "Total offers", value: stats?.total },
          { label: "Suppliers", value: stats?.suppliers },
          { label: "Brands", value: stats?.brands },
          { label: "Added today", value: stats?.addedToday },
          { label: "Added this week", value: stats?.addedThisWeek },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-2xl font-semibold">
              {c.value !== undefined ? c.value.toLocaleString() : "—"}
            </div>
            <div className="mt-0.5 text-xs text-gray-500">{c.label}</div>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-medium">Latest offers</h2>
        {recentOffers.length === 0 ? (
          <p className="text-sm text-gray-400">No offers logged yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-200 text-xs uppercase text-gray-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Product</th>
                  <th className="py-2 pr-4 font-medium">Brand</th>
                  <th className="py-2 pr-4 font-medium">Supplier</th>
                  <th className="py-2 pr-4 font-medium">Price</th>
                  <th className="py-2 pr-4 font-medium">Added</th>
                  <th className="py-2 pr-4 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {recentOffers.map((o) => (
                  <tr key={o.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-2 pr-4 font-medium">
                      {o.product}
                      {o.sku && <span className="ml-1.5 font-normal text-gray-400">{o.sku}</span>}
                    </td>
                    <td className="py-2 pr-4">{o.brand}</td>
                    <td className="py-2 pr-4">{o.supplier}</td>
                    <td className="py-2 pr-4 tabular-nums">
                      {o.price.toFixed(2)} {o.currency}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap text-gray-500">
                      {timeAgo(o.createdAt)}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <button
                        onClick={() => setEditingOffer(o)}
                        className="text-xs text-gray-500 hover:underline"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-amber-900">
              Fix broken brand names from import
            </h2>
            <p className="mt-1 text-xs text-amber-700">
              A few source sheets had misaligned columns, so the brand field for a handful of rows
              ended up wrong — a barcode number, the full product name, or just a fragment of it
              (e.g. Huda Beauty&apos;s &quot;Easy Bake&quot; line, or Elizabeth Arden&apos;s
              &quot;5th Ave NYC Downtown&quot;). This restores the brand from each row&apos;s
              original source sheet, whatever the corruption looked like. Safe to run any time —
              it&apos;s a no-op once brand matches source everywhere.
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
                  <td className="px-4 py-3">{o.leadTimeDays ?? "—"}</td>
                  <td className="px-4 py-3">{o.paymentTerms ?? "—"}</td>
                  <td className="px-4 py-3">{o.region ?? "—"}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-gray-500">
                    {o.createdAt ? new Date(o.createdAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditingOffer(o)}
                      className="mr-3 text-xs text-gray-500 hover:underline"
                    >
                      Edit
                    </button>
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

      {editingOffer && (
        <EditOfferModal
          offer={editingOffer}
          onClose={() => setEditingOffer(null)}
          onSaved={() => {
            setEditingOffer(null);
            load();
            loadOverview();
          }}
        />
      )}
    </div>
  );
}
