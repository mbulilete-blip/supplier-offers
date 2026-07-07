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

const isToday = (iso: string): boolean => {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
};

// Short, always-visible date label under each price (the earlier hover-only
// tooltip wasn't discoverable enough - the date needs to be readable at a
// glance, not just on hover).
const shortDate = (iso: string): string => {
  if (isToday(iso)) return "Today";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

// One brand's worth of offers can be safely pulled in one request (see
// MAX_PAGE_SIZE in lib/db.ts) - this view is meant to show everything for a
// single brand at once, laid out as a grid, so pagination would defeat the
// point.
const BRAND_FETCH_LIMIT = 5000;

export default function MatrixPage() {
  const [brands, setBrands] = useState<{ brand: string; count: number }[]>([]);
  const [brand, setBrand] = useState("");
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    fetch("/api/brands")
      .then((r) => r.json())
      .then((data) => setBrands(Array.isArray(data) ? data : []));
  }, []);

  useEffect(() => {
    if (!brand) {
      setOffers([]);
      setTruncated(false);
      return;
    }
    setLoading(true);
    const params = new URLSearchParams({ brand, limit: String(BRAND_FETCH_LIMIT), page: "1" });
    fetch(`/api/offers?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        setOffers(data.offers ?? []);
        setTruncated((data.total ?? 0) > (data.offers?.length ?? 0));
        setLoading(false);
      });
  }, [brand]);

  const { products, suppliers, cellPrice } = useMemo(() => {
    const supplierSet = new Set<string>();
    const productMap = new Map<string, { product: string; sku: string | null }>();
    // key -> supplier -> {price, currency, rrp, createdAt}
    const cells = new Map<
      string,
      Map<string, { price: number; currency: string; rrp: number | null; createdAt: string }>
    >();

    for (const o of offers) {
      // Group by SKU/EAN alone when one is present - that's the real product
      // identity. Suppliers often type the product name slightly differently
      // (e.g. "OUD MINERALE 100ML" vs "OUD MINERALE EDP 100ML/3.4FLOZ") for
      // the exact same EAN, and keying on product+SKU together was splitting
      // those into separate rows, so a supplier's price looked missing when
      // it was really just filed under a differently-worded row.
      const key = (o.sku ? o.sku : o.product).trim().toLowerCase();
      const existingProduct = productMap.get(key);
      // Keep the longest/most descriptive product label seen for this key.
      if (!existingProduct || o.product.length > existingProduct.product.length) {
        productMap.set(key, { product: o.product, sku: o.sku });
      }
      supplierSet.add(o.supplier);
      if (!cells.has(key)) cells.set(key, new Map());
      const bySupplier = cells.get(key)!;
      const existing = bySupplier.get(o.supplier);
      // If duplicates exist for the same product+supplier (e.g. the same
      // price list imported more than once), keep the lower price.
      if (!existing || o.price < existing.price) {
        bySupplier.set(o.supplier, {
          price: o.price,
          currency: o.currency,
          rrp: o.rrp,
          createdAt: o.createdAt,
        });
      }
    }

    const productsSorted = Array.from(productMap.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.product.localeCompare(b.product));
    const suppliersSorted = Array.from(supplierSet).sort();

    return {
      products: productsSorted,
      suppliers: suppliersSorted,
      cellPrice: cells,
    };
  }, [offers]);

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold">Price Matrix</h1>
        <p className="mt-1 text-sm text-gray-500">
          Pick a brand to see every product against every supplier side by side. The lowest
          price in each row is highlighted.
        </p>
      </section>

      <select
        className="input w-72"
        value={brand}
        onChange={(e) => setBrand(e.target.value)}
      >
        <option value="">Select a brand…</option>
        {brands.map((b) => (
          <option key={b.brand} value={b.brand}>
            {b.brand} ({b.count.toLocaleString()})
          </option>
        ))}
      </select>

      {!brand && <p className="text-sm text-gray-400">Choose a brand above to build the matrix.</p>}

      {loading && <p className="text-sm text-gray-400">Loading…</p>}

      {truncated && (
        <p className="text-xs text-amber-600">
          This brand has more offers than fit in one view ({BRAND_FETCH_LIMIT.toLocaleString()}{" "}
          shown). Some rows may be incomplete.
        </p>
      )}

      {!loading && brand && products.length > 0 && (
        <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
          <table className="text-left text-xs">
            <thead className="border-b border-gray-200 bg-gray-50 uppercase tracking-wide text-gray-500">
              <tr>
                <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2">Product</th>
                {suppliers.map((s) => (
                  <th key={s} className="px-3 py-2 text-right whitespace-nowrap">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map((p, rowIdx) => {
                const bySupplier = cellPrice.get(p.key);
                let bestSupplier: string | null = null;
                let bestPrice = Infinity;
                if (bySupplier) {
                  for (const [s, v] of bySupplier.entries()) {
                    if (v.price < bestPrice) {
                      bestPrice = v.price;
                      bestSupplier = s;
                    }
                  }
                }
                return (
                  <tr
                    key={p.key}
                    className={`border-b border-gray-100 last:border-0 hover:bg-gray-50 ${
                      rowIdx % 2 === 1 ? "bg-gray-50/40" : ""
                    }`}
                  >
                    <td className="sticky left-0 z-10 bg-inherit px-3 py-1.5 font-medium">
                      {p.product}
                      {p.sku && <span className="ml-1.5 font-normal text-gray-400">{p.sku}</span>}
                    </td>
                    {suppliers.map((s) => {
                      const cell = bySupplier?.get(s);
                      const isBest = s === bestSupplier && bySupplier && bySupplier.size > 1;
                      const addedToday = cell ? isToday(cell.createdAt) : false;
                      return (
                        <td
                          key={s}
                          title={cell ? `Added ${new Date(cell.createdAt).toLocaleString()}` : undefined}
                          className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${
                            isBest ? "bg-green-50 font-semibold text-green-700" : "text-gray-700"
                          }`}
                        >
                          {cell ? (
                            <div className="leading-tight">
                              <div>
                                {cell.price.toFixed(2)} {cell.currency}
                                {addedToday && (
                                  <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle" />
                                )}
                              </div>
                              <div
                                className={`text-[10px] font-normal ${
                                  addedToday ? "text-blue-500" : "text-gray-400"
                                }`}
                              >
                                {shortDate(cell.createdAt)}
                              </div>
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!loading && brand && products.length > 0 && (
        <p className="text-xs text-gray-400">
          The date under each price is when that offer was added.{" "}
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle" /> and blue
          text mark offers added today.
        </p>
      )}

      {!loading && brand && products.length === 0 && (
        <p className="text-sm text-gray-400">No offers found for this brand.</p>
      )}
    </div>
  );
}
