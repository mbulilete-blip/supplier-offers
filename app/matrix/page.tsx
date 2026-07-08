"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Offer } from "@/lib/types";
import EditOfferModal from "@/components/EditOfferModal";

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
  const [editingOffer, setEditingOffer] = useState<Offer | null>(null);

  // Drag-to-resize for the sticky Product column - default (224px) matches
  // the old fixed w-56 class exactly, so nothing shifts until the user drags.
  // The RRP column is also sticky and sits right after Product, so its left
  // offset has to track this value live (see `style={{ left: productColWidth }}`
  // below) instead of the old hardcoded `left-56` class.
  const [productColWidth, setProductColWidth] = useState(224);

  // Drag-to-resize state, tracked declaratively so cleanup can never be
  // skipped. Earlier attempts wired mousedown/pointerdown to imperatively
  // add + remove listeners inside one callback - if the matching "up" event
  // was ever missed (e.g. a pointercancel instead of pointerup, or the
  // browser eating it over the sticky table header), the cursor/user-select
  // override and the listeners were left stuck forever, which is exactly
  // what got reported. Driving this off a `resizing` boolean + useEffect
  // means React's effect cleanup runs no matter how `resizing` goes back to
  // false - mouseup, window blur, or even the component unmounting.
  const [resizing, setResizing] = useState(false);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  const startColResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragStart.current = { x: e.clientX, width: productColWidth };
    setResizing(true);
  };

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      if (!dragStart.current) return;
      const delta = e.clientX - dragStart.current.x;
      const next = Math.min(480, Math.max(120, dragStart.current.width + delta));
      setProductColWidth(next);
    };
    const stop = () => setResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
    // Safety nets: if the mouse is released outside the window, or the
    // window/tab loses focus mid-drag, still end the drag instead of
    // leaving the cursor and listeners stuck.
    window.addEventListener("blur", stop);
    window.addEventListener("mouseleave", stop);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
      window.removeEventListener("mouseleave", stop);
      dragStart.current = null;
    };
  }, [resizing]);

  useEffect(() => {
    if (!resizing) return;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);

  // Renaming a supplier straight from its column header - handy for fixing a
  // corrupted supplier value (e.g. a sheet/tab name that got used as the
  // literal supplier text on import) right where you spot it, without
  // hunting down every affected offer individually. This renames ALL offers
  // filed under that exact supplier string, across every brand, not just the
  // ones showing in this matrix.
  const [renamingSupplier, setRenamingSupplier] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameNotice, setRenameNotice] = useState<string | null>(null);

  const startRename = (supplier: string) => {
    setRenamingSupplier(supplier);
    setRenameValue(supplier);
    setRenameError(null);
    setRenameNotice(null);
  };

  const cancelRename = () => {
    setRenamingSupplier(null);
    setRenameValue("");
    setRenameError(null);
  };

  const saveRename = async () => {
    if (!renamingSupplier) return;
    const to = renameValue.trim();
    if (!to) {
      setRenameError("Name can't be empty.");
      return;
    }
    if (to === renamingSupplier) {
      cancelRename();
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      const res = await fetch("/api/suppliers/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: renamingSupplier, to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to rename supplier.");
      setRenameNotice(`Renamed ${data.updated} offer(s) from "${renamingSupplier}" to "${to}".`);
      setRenamingSupplier(null);
      setRenameValue("");
      fetchOffers();
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : "Failed to rename supplier.");
    } finally {
      setRenaming(false);
    }
  };

  // Deleting an entire column - every offer from one supplier, for the brand
  // currently being viewed. Scoped to this brand (not that supplier's offers
  // everywhere) since that's what a column actually represents; other brands
  // from the same supplier are untouched.
  const [deletingSupplier, setDeletingSupplier] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  const deleteColumn = async (supplier: string) => {
    const count = offers.filter((o) => o.supplier === supplier).length;
    if (
      !confirm(
        `Delete all ${count} offer(s) from "${supplier}" for ${brand}? This can't be undone.`
      )
    ) {
      return;
    }
    setDeletingSupplier(true);
    setDeleteNotice(null);
    try {
      const res = await fetch("/api/suppliers/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplier, brand }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to delete offers.");
      setDeleteNotice(`Deleted ${data.deleted} offer(s) from "${supplier}" for ${brand}.`);
      fetchOffers();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete offers.");
    } finally {
      setDeletingSupplier(false);
    }
  };

  // Renaming the brand itself, from the dropdown - fixes a mistyped/corrupted
  // brand name or standardizes spelling. Unlike the supplier delete action,
  // this is intentionally global (every offer under that brand string, across
  // every supplier), matching what "the brand" conceptually means.
  const [renamingBrand, setRenamingBrand] = useState(false);
  const [brandRenameValue, setBrandRenameValue] = useState("");
  const [brandRenaming, setBrandRenaming] = useState(false);
  const [brandRenameError, setBrandRenameError] = useState<string | null>(null);
  const [brandRenameNotice, setBrandRenameNotice] = useState<string | null>(null);

  const loadBrands = () => {
    fetch("/api/brands")
      .then((r) => r.json())
      .then((data) => setBrands(Array.isArray(data) ? data : []));
  };

  useEffect(() => {
    loadBrands();
  }, []);

  const startBrandRename = () => {
    if (!brand) return;
    setBrandRenameValue(brand);
    setBrandRenameError(null);
    setBrandRenameNotice(null);
    setRenamingBrand(true);
  };

  const cancelBrandRename = () => {
    setRenamingBrand(false);
    setBrandRenameValue("");
    setBrandRenameError(null);
  };

  const saveBrandRename = async () => {
    const to = brandRenameValue.trim();
    if (!to) {
      setBrandRenameError("Name can't be empty.");
      return;
    }
    if (to === brand) {
      cancelBrandRename();
      return;
    }
    setBrandRenaming(true);
    setBrandRenameError(null);
    try {
      const res = await fetch("/api/brands/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: brand, to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to rename brand.");
      setBrandRenameNotice(`Renamed ${data.updated} offer(s) from "${brand}" to "${to}".`);
      setRenamingBrand(false);
      setBrandRenameValue("");
      loadBrands();
      setBrand(to);
    } catch (e) {
      setBrandRenameError(e instanceof Error ? e.message : "Failed to rename brand.");
    } finally {
      setBrandRenaming(false);
    }
  };

  const fetchOffers = () => {
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
  };

  useEffect(() => {
    fetchOffers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand]);

  const { products, suppliers, cellPrice, supplierLastUpdated, bestSupplierRanking, contestedCount } = useMemo(() => {
    const supplierSet = new Set<string>();
    const productMap = new Map<
      string,
      { product: string; sku: string | null; rrp: number | null; rrpCurrency: string | null; rrpAt: string | null }
    >();
    // key -> supplier -> full offer (kept whole, not just a few fields, so a
    // cell can be clicked straight into the Edit modal for that exact offer).
    const cells = new Map<string, Map<string, Offer>>();
    // Most recent createdAt seen for each supplier, across this brand's
    // offers - shown once in the column header instead of repeating a date
    // under every price.
    const lastUpdated = new Map<string, string>();

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
      const product =
        !existingProduct || o.product.length > existingProduct.product.length
          ? o.product
          : existingProduct.product;
      const sku =
        !existingProduct || o.product.length > existingProduct.product.length
          ? o.sku
          : existingProduct.sku;
      // RRP is a product-level reference price, not a per-supplier one, but
      // it only lives on individual offer rows - take whichever offer with
      // an RRP was added most recently, so a corrected/updated RRP always
      // wins over an older one.
      let rrp = existingProduct?.rrp ?? null;
      let rrpCurrency = existingProduct?.rrpCurrency ?? null;
      let rrpAt = existingProduct?.rrpAt ?? null;
      if (o.rrp != null && (!rrpAt || new Date(o.createdAt) > new Date(rrpAt))) {
        rrp = o.rrp;
        rrpCurrency = o.currency;
        rrpAt = o.createdAt;
      }
      productMap.set(key, { product, sku, rrp, rrpCurrency, rrpAt });
      supplierSet.add(o.supplier);

      const lastSeen = lastUpdated.get(o.supplier);
      if (!lastSeen || new Date(o.createdAt) > new Date(lastSeen)) {
        lastUpdated.set(o.supplier, o.createdAt);
      }

      if (!cells.has(key)) cells.set(key, new Map());
      const bySupplier = cells.get(key)!;
      const existing = bySupplier.get(o.supplier);
      // If a supplier has more than one entry for the same product - e.g.
      // they resent an updated price list later - keep whichever one was
      // added most recently. That's the supplier's current price. Keeping
      // the lowest price instead (the old behavior) could surface a stale,
      // no-longer-available price over a price the supplier actually quotes
      // today.
      if (!existing || new Date(o.createdAt) > new Date(existing.createdAt)) {
        bySupplier.set(o.supplier, o);
      }
    }

    const productsSorted = Array.from(productMap.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.product.localeCompare(b.product));
    const suppliersSorted = Array.from(supplierSet).sort();

    // "Best supplier" tally for the summary panel: for every product quoted
    // by more than one supplier (a "contested" product - anything with just
    // one quote can't tell you who's cheaper), count who had the lowest
    // price. A supplier winning most of these contested rows is the one
    // worth leading price negotiations with for this brand.
    const bestCounts = new Map<string, number>();
    let contestedCount = 0;
    for (const bySupplier of cells.values()) {
      if (bySupplier.size < 2) continue;
      contestedCount += 1;
      let bestSupplier: string | null = null;
      let bestPrice = Infinity;
      for (const [s, o] of bySupplier.entries()) {
        if (o.price < bestPrice) {
          bestPrice = o.price;
          bestSupplier = s;
        }
      }
      if (bestSupplier) {
        bestCounts.set(bestSupplier, (bestCounts.get(bestSupplier) ?? 0) + 1);
      }
    }
    const bestSupplierRanking = Array.from(bestCounts.entries()).sort((a, b) => b[1] - a[1]);

    return {
      products: productsSorted,
      suppliers: suppliersSorted,
      cellPrice: cells,
      supplierLastUpdated: lastUpdated,
      bestSupplierRanking,
      contestedCount,
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

      {renamingBrand ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            className="input w-72"
            value={brandRenameValue}
            onChange={(e) => setBrandRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveBrandRename();
              if (e.key === "Escape") cancelBrandRename();
            }}
          />
          <button
            onClick={saveBrandRename}
            disabled={brandRenaming}
            className="text-xs font-medium text-gray-900 hover:underline disabled:opacity-50"
          >
            {brandRenaming ? "Saving…" : "Save"}
          </button>
          <button
            onClick={cancelBrandRename}
            disabled={brandRenaming}
            className="text-xs text-gray-400 hover:underline"
          >
            Cancel
          </button>
          {brandRenameError && <span className="text-xs text-red-600">{brandRenameError}</span>}
        </div>
      ) : (
        <div className="flex items-center gap-2">
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
          {brand && (
            <button
              onClick={startBrandRename}
              title="Rename this brand everywhere"
              className="text-gray-400 hover:text-gray-700"
            >
              ✎ Rename brand
            </button>
          )}
        </div>
      )}

      {brandRenameNotice && <p className="text-xs text-green-700">{brandRenameNotice}</p>}

      {!brand && <p className="text-sm text-gray-400">Choose a brand above to build the matrix.</p>}

      {loading && <p className="text-sm text-gray-400">Loading…</p>}

      {truncated && (
        <p className="text-xs text-amber-600">
          This brand has more offers than fit in one view ({BRAND_FETCH_LIMIT.toLocaleString()}{" "}
          shown). Some rows may be incomplete.
        </p>
      )}

      {renameNotice && <p className="text-xs text-green-700">{renameNotice}</p>}
      {deleteNotice && <p className="text-xs text-green-700">{deleteNotice}</p>}

      {!loading && brand && contestedCount > 0 && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-green-700">
            Best supplier for {brand}
          </p>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-2">
            {bestSupplierRanking.slice(0, 3).map(([s, count], i) => (
              <div key={s} className="flex items-baseline gap-1.5">
                <span
                  className={`text-sm font-semibold ${i === 0 ? "text-green-800" : "text-gray-500"}`}
                >
                  {i === 0 ? "🏆" : `#${i + 1}`} {s}
                </span>
                <span className="text-xs text-gray-500">
                  lowest on {count}/{contestedCount} ({Math.round((count / contestedCount) * 100)}
                  %)
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gray-500">
            Based on products quoted by more than one supplier ({contestedCount} of{" "}
            {products.length} products here). Single-supplier products aren&apos;t counted -
            there&apos;s no price to compare them against.
          </p>
        </div>
      )}

      {!loading && brand && products.length > 0 && (
        <>
          <p className="text-[11px] text-gray-400 sm:hidden">
            ← Swipe sideways to see more suppliers →
          </p>
          <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
            {/* table-fixed + colgroup gives every column a real, stable width
                up front. With the old auto layout, a supplier name that could
                wrap (to avoid overlapping the price column) let the browser
                shrink that whole column down to fit just "-" placeholders in
                the body, which then forced the header name to wrap one
                letter per line. Fixed widths make that impossible. */}
            <table className="table-fixed text-left text-xs">
              <colgroup>
                {/* No width on this col - some browsers don't reliably
                    relayout a fixed table when a <col>'s width is changed
                    dynamically after first paint. Setting the width on the
                    header <th> instead (below) is what the fixed-table
                    layout algorithm actually uses when the col has none,
                    and cells reflow normally like any other styled element. */}
                <col />
                <col className="w-24" />
                {suppliers.map((s) => (
                  <col key={s} className="w-40" />
                ))}
              </colgroup>
              <thead className="border-b border-gray-200 bg-gray-50 uppercase tracking-wide text-gray-500">
                <tr>
                  <th
                    className="sticky left-0 z-10 border-r border-gray-200 bg-gray-50 px-3 py-2 align-top relative"
                    style={{ width: productColWidth, minWidth: productColWidth, maxWidth: productColWidth }}
                  >
                    Product{" "}
                    <span className="font-normal normal-case text-gray-300">
                      ({Math.round(productColWidth)}px)
                    </span>
                    <div
                      onMouseDown={startColResize}
                      title="Drag to resize"
                      className={`absolute -right-1 top-0 z-20 h-full w-3 cursor-col-resize select-none hover:bg-gray-300 ${
                        resizing ? "bg-gray-400" : ""
                      }`}
                    />
                  </th>
                  <th
                    className="sticky z-10 border-r border-gray-200 bg-gray-50 px-3 py-2 text-right align-top"
                    style={{ left: productColWidth }}
                  >
                    RRP
                  </th>
                  {suppliers.map((s) => {
                    const updated = supplierLastUpdated.get(s);
                    const isRenaming = renamingSupplier === s;
                    return (
                      <th key={s} className="px-3 py-2 text-right align-top">
                        {isRenaming ? (
                          <div className="flex flex-col items-end gap-1 normal-case">
                            <input
                              autoFocus
                              className="input w-40 text-right text-xs"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveRename();
                                if (e.key === "Escape") cancelRename();
                              }}
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={saveRename}
                                disabled={renaming}
                                className="text-[10px] font-medium text-gray-900 hover:underline disabled:opacity-50"
                              >
                                {renaming ? "Saving…" : "Save"}
                              </button>
                              <button
                                onClick={cancelRename}
                                disabled={renaming}
                                className="text-[10px] text-gray-400 hover:underline"
                              >
                                Cancel
                              </button>
                            </div>
                            {renameError && (
                              <div className="max-w-[10rem] whitespace-normal text-[10px] text-red-600">
                                {renameError}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex min-w-0 items-center justify-end gap-1">
                            <span className="min-w-0 truncate" title={s}>
                              {s}
                            </span>
                            <span className="flex shrink-0 items-center gap-1">
                              <button
                                onClick={() => startRename(s)}
                                title="Rename this supplier everywhere"
                                className="text-gray-300 hover:text-gray-600"
                              >
                                ✎
                              </button>
                              <button
                                onClick={() => deleteColumn(s)}
                                disabled={deletingSupplier}
                                title={`Delete all offers from "${s}" for ${brand}`}
                                className="text-gray-300 hover:text-red-600 disabled:opacity-50"
                              >
                                🗑
                              </button>
                            </span>
                          </div>
                        )}
                        {!isRenaming && updated && (
                          <div
                            className={`whitespace-nowrap text-[10px] font-normal normal-case ${
                              isToday(updated) ? "text-blue-500" : "text-gray-400"
                            }`}
                          >
                            Updated {shortDate(updated)}
                          </div>
                        )}
                      </th>
                    );
                  })}
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
                  const rowBg = rowIdx % 2 === 1 ? "bg-gray-50/60" : "bg-white";
                  return (
                    <tr
                      key={p.key}
                      className={`group border-b border-gray-100 last:border-0 hover:bg-gray-50 ${rowBg}`}
                    >
                      <td
                        className={`sticky left-0 z-10 border-r border-gray-200 px-3 py-2 align-top font-medium group-hover:bg-gray-50 ${rowBg}`}
                        style={{ width: productColWidth, minWidth: productColWidth, maxWidth: productColWidth }}
                      >
                        <div className="truncate" title={p.product}>
                          {p.product}
                        </div>
                        {p.sku && (
                          <div className="mt-0.5 text-[11px] font-normal text-gray-400">
                            {p.sku}
                          </div>
                        )}
                      </td>
                      <td
                        title={p.rrpAt ? `RRP as of ${new Date(p.rrpAt).toLocaleDateString()}` : undefined}
                        className={`sticky z-10 border-r border-gray-200 px-3 py-2 text-right align-top tabular-nums text-gray-500 group-hover:bg-gray-50 ${rowBg}`}
                        style={{ left: productColWidth }}
                      >
                        {p.rrp != null ? (
                          <>
                            {p.rrp.toFixed(2)} {p.rrpCurrency}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      {suppliers.map((s) => {
                        const cell = bySupplier?.get(s);
                        const isBest = s === bestSupplier && bySupplier && bySupplier.size > 1;
                        const addedToday = cell ? isToday(cell.createdAt) : false;
                        // Discount vs RRP: always measured against the row's
                        // one canonical RRP (p.rrp), not each offer's own rrp
                        // field, so every supplier in a row is compared on
                        // the same reference price - matching what the RRP
                        // column itself shows. Falls back to the individual
                        // offer's rrp only if the row has none at all.
                        const referenceRrp = p.rrp ?? cell?.rrp ?? null;
                        const discount =
                          cell && referenceRrp && referenceRrp > 0
                            ? ((referenceRrp - cell.price) / referenceRrp) * 100
                            : null;
                        return (
                          <td
                            key={s}
                            title={cell ? `Added ${new Date(cell.createdAt).toLocaleString()} - click to edit` : undefined}
                            onClick={() => cell && setEditingOffer(cell)}
                            className={`px-3 py-2 text-right align-top tabular-nums whitespace-nowrap ${
                              cell ? "cursor-pointer hover:underline" : ""
                            } ${isBest ? "bg-green-50 font-semibold text-green-700" : "text-gray-700"}`}
                          >
                            {cell ? (
                              <>
                                {cell.price.toFixed(2)} {cell.currency}
                                {addedToday && (
                                  <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle" />
                                )}
                                {discount !== null && (
                                  <div
                                    className={`text-[10px] font-normal normal-case ${
                                      discount > 0
                                        ? isBest
                                          ? "text-green-600"
                                          : "text-gray-400"
                                        : "text-red-400"
                                    }`}
                                  >
                                    {discount > 0 ? "-" : "+"}
                                    {Math.abs(discount).toFixed(0)}% vs RRP
                                  </div>
                                )}
                              </>
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
        </>
      )}
      {!loading && brand && products.length > 0 && (
        <p className="text-xs text-gray-400">
          Drag the right edge of the Product column header to resize it. RRP shown when at least
          one offer for that product includes one. Each price shows its discount vs that row&apos;s
          RRP underneath - red means the price is above RRP.
          &quot;Updated&quot; under each supplier is when their most recent price for this brand
          was added. Click any price to edit that offer, or hover the product name to see it in
          full. Next to a supplier name, ✎ renames it everywhere (across every brand, not just
          this one), and 🗑 deletes all of that supplier&apos;s offers for this brand only. Hover
          a price for its exact date.{" "}
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle" /> and
          blue text mark today.
        </p>
      )}

      {!loading && brand && products.length === 0 && (
        <p className="text-sm text-gray-400">No offers found for this brand.</p>
      )}

      {editingOffer && (
        <EditOfferModal
          offer={editingOffer}
          onClose={() => setEditingOffer(null)}
          onSaved={() => {
            setEditingOffer(null);
            fetchOffers();
          }}
        />
      )}
    </div>
  );
}
