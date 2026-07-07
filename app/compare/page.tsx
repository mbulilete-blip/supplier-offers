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
};

export default function ComparePage() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/offers")
      .then((r) => r.json())
      .then((data) => {
        setOffers(data);
        setLoading(false);
      });
  }, []);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? offers.filter(
          (o) =>
            o.product.toLowerCase().includes(q) ||
            o.brand.toLowerCase().includes(q) ||
            o.supplier.toLowerCase().includes(q) ||
            (o.sku ?? "").toLowerCase().includes(q)
        )
      : offers;

    const map = new Map<string, Offer[]>();
    for (const o of filtered) {
      const key = (o.sku ? `${o.product}__${o.sku}` : o.product).toLowerCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(o);
    }

    return Array.from(map.values())
      .map((list) => list.slice().sort((a, b) => a.price - b.price))
      .sort((a, b) => a[0].product.localeCompare(b[0].product));
  }, [offers, search]);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold">Compare Offers</h1>
        <p className="mt-1 text-sm text-gray-500">
          Offers grouped by product. Lowest price per product is highlighted. Margin is
          calculated against RRP where available.
        </p>
      </section>

      <input
        className="input w-full max-w-sm"
        placeholder="Search product, brand, supplier, SKU…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {loading && <p className="text-sm text-gray-400">Loading…</p>}

      {!loading && groups.length === 0 && (
        <p className="text-sm text-gray-400">No offers to compare yet.</p>
      )}

      <div className="space-y-6">
        {groups.map((list) => {
          const best = list[0];
          return (
            <div key={best.id} className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-lg font-medium">
                  {best.product}{" "}
                  <span className="text-sm font-normal text-gray-400">
                    {best.brand}
                    {best.sku ? ` · ${best.sku}` : ""}
                  </span>
                </h2>
                <span className="text-xs text-gray-400">
                  {list.length} offer{list.length > 1 ? "s" : ""}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-gray-200 text-xs uppercase text-gray-500">
                    <tr>
                      <th className="py-2 pr-4">Supplier</th>
                      <th className="py-2 pr-4">Price</th>
                      <th className="py-2 pr-4">Margin vs RRP</th>
                      <th className="py-2 pr-4">MOQ</th>
                      <th className="py-2 pr-4">Lead time</th>
                      <th className="py-2 pr-4">Terms</th>
                      <th className="py-2 pr-4">Region</th>
                      <th className="py-2 pr-4">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((o) => {
                      const isBest = o.id === best.id && list.length > 1;
                      const margin =
                        o.rrp && o.rrp > 0 ? ((o.rrp - o.price) / o.rrp) * 100 : null;
                      return (
                        <tr
                          key={o.id}
                          className={`border-b border-gray-100 last:border-0 ${
                            isBest ? "bg-green-50" : ""
                          }`}
                        >
                          <td className="py-2 pr-4 font-medium">
                            {o.supplier}
                            {isBest && (
                              <span className="ml-2 rounded-full bg-green-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                                BEST PRICE
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-4">
                            {o.price.toFixed(2)} {o.currency}
                          </td>
                          <td className="py-2 pr-4">
                            {margin !== null ? `${margin.toFixed(0)}%` : "—"}
                          </td>
                          <td className="py-2 pr-4">{o.moq ?? "—"}</td>
                          <td className="py-2 pr-4">
                            {o.leadTimeDays ? `${o.leadTimeDays}d` : "—"}
                          </td>
                          <td className="py-2 pr-4">{o.paymentTerms ?? "—"}</td>
                          <td className="py-2 pr-4">{o.region ?? "—"}</td>
                          <td className="py-2 pr-4 text-gray-500">{o.notes ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
