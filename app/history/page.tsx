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
  createdAt: string;
};

// A supplier's full offer list fits comfortably in one request (see
// MAX_PAGE_SIZE in lib/db.ts) - this page needs every offer for the selected
// supplier at once to build a complete price history, so pagination would
// hide older price points instead of just being slow.
const FETCH_LIMIT = 5000;

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function HistoryPage() {
  const [suppliers, setSuppliers] = useState<{ supplier: string; count: number }[]>([]);
  const [brands, setBrands] = useState<{ brand: string; count: number }[]>([]);
  const [supplier, setSupplier] = useState("");
  const [brand, setBrand] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    fetch("/api/suppliers")
      .then((r) => r.json())
      .then((data) => setSuppliers(Array.isArray(data) ? data : []));
    fetch("/api/brands")
      .then((r) => r.json())
      .then((data) => setBrands(Array.isArray(data) ? data : []));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    if (!supplier) {
      setOffers([]);
      setTruncated(false);
      return;
    }
    setLoading(true);
    const params = new URLSearchParams({ supplier, limit: String(FETCH_LIMIT), page: "1" });
    if (brand) params.set("brand", brand);
    if (search) params.set("search", search);
    fetch(`/api/offers?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        setOffers(data.offers ?? []);
        setTruncated((data.total ?? 0) > (data.offers?.length ?? 0));
        setLoading(false);
      });
  }, [supplier, brand, search]);

  const groups = useMemo(() => {
    // Group by SKU/EAN when present (the real product identity - see the
    // same logic in the price matrix), else by product name. Within each
    // group, sort newest first so the price trend reads top-to-bottom as
    // "most recent to oldest."
    const map = new Map<string, { product: string; sku: string | null; brand: string; entries: Offer[] }>();
    for (const o of offers) {
      const key = (o.sku ? o.sku : o.product).trim().toLowerCase();
      if (!map.has(key)) map.set(key, { product: o.product, sku: o.sku, brand: o.brand, entries: [] });
      const g = map.get(key)!;
      // Prefer the longest/most descriptive product label seen for this key.
      if (o.product.length > g.product.length) g.product = o.product;
      g.entries.push(o);
    }

    return Array.from(map.values())
      .map((g) => ({
        ...g,
        entries: g.entries.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
      }))
      .filter((g) => !onlyChanged || g.entries.length > 1)
      .sort((a, b) => a.product.localeCompare(b.product));
  }, [offers, onlyChanged]);

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold">Price History</h1>
        <p className="mt-1 text-sm text-gray-500">
          Pick a supplier to see every price they&apos;ve ever quoted per product, newest first,
          with how much it moved since the last one.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <select className="input w-64" value={supplier} onChange={(e) => setSupplier(e.target.value)}>
          <option value="">Select a supplier…</option>
          {suppliers.map((s) => (
            <option key={s.supplier} value={s.supplier}>
              {s.supplier} ({s.count.toLocaleString()})
            </option>
          ))}
        </select>
        <select className="input w-56" value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="">All brands</option>
          {brands.map((b) => (
            <option key={b.brand} value={b.brand}>
              {b.brand} ({b.count.toLocaleString()})
            </option>
          ))}
        </select>
        <input
          className="input w-full max-w-xs"
          placeholder="Filter by product or SKU…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={onlyChanged}
            onChange={(e) => setOnlyChanged(e.target.checked)}
          />
          Only products with more than one price on file
        </label>
      </div>

      {!supplier && (
        <p className="text-sm text-gray-400">Choose a supplier above to see their price history.</p>
      )}

      {loading && <p className="text-sm text-gray-400">Loading…</p>}

      {truncated && (
        <p className="text-xs text-amber-600">
          This supplier has more offers than fit in one view ({FETCH_LIMIT.toLocaleString()} shown).
          Narrow by brand or search to see everything.
        </p>
      )}

      {!loading && supplier && groups.length === 0 && (
        <p className="text-sm text-gray-400">No price history found for this filter.</p>
      )}

      <div className="space-y-4">
        {groups.map((g) => {
          const key = (g.sku ? g.sku : g.product).trim().toLowerCase();
          return (
            <div key={key} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-medium">
                  {g.product}
                  {g.sku && <span className="ml-1.5 font-normal text-gray-400">{g.sku}</span>}
                  <span className="ml-2 text-xs font-normal text-gray-400">{g.brand}</span>
                </h2>
                <span className="text-xs text-gray-400">
                  {g.entries.length} price{g.entries.length > 1 ? "s" : ""} on file
                </span>
              </div>
              <table className="w-full text-left text-xs">
                <thead className="border-b border-gray-100 uppercase tracking-wide text-gray-400">
                  <tr>
                    <th className="py-1.5 pr-4 font-medium">Date added</th>
                    <th className="py-1.5 pr-4 font-medium">Price</th>
                    <th className="py-1.5 pr-4 font-medium">Change</th>
                    <th className="py-1.5 pr-4 font-medium">RRP</th>
                  </tr>
                </thead>
                <tbody>
                  {g.entries.map((o, idx) => {
                    const older = g.entries[idx + 1];
                    const delta = older ? o.price - older.price : null;
                    const deltaPct = older && older.price !== 0 ? (delta! / older.price) * 100 : null;
                    return (
                      <tr key={o.id} className="border-b border-gray-50 last:border-0">
                        <td className="py-1.5 pr-4 text-gray-500">{formatDate(o.createdAt)}</td>
                        <td className="py-1.5 pr-4 tabular-nums font-medium">
                          {o.price.toFixed(2)} {o.currency}
                        </td>
                        <td className="py-1.5 pr-4 tabular-nums">
                          {delta === null ? (
                            <span className="text-gray-300">—</span>
                          ) : delta === 0 ? (
                            <span className="text-gray-400">No change</span>
                          ) : delta > 0 ? (
                            <span className="text-red-600">
                              ▲ +{delta.toFixed(2)} ({deltaPct!.toFixed(1)}%)
                            </span>
                          ) : (
                            <span className="text-green-600">
                              ▼ {delta.toFixed(2)} ({deltaPct!.toFixed(1)}%)
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-4 text-gray-500">
                          {o.rrp !== null ? `${o.rrp.toFixed(2)} ${o.currency}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}
