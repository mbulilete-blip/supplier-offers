"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Offer } from "@/lib/types";
import EditOfferModal from "@/components/EditOfferModal";
import { fuzzyFilterSort } from "@/lib/fuzzyMatch";

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

// Fixed width for the row-select checkbox column, sticky to the left of the
// (resizable) Product column.
const CHECKBOX_COL_WIDTH = 36;

// Bulk RRP edits and bulk deletes both fan out into one request per
// underlying offer id (there's no bulk endpoint) - capped concurrency keeps
// this from overwhelming the `pg` pool (max 5 connections, see lib/db.ts),
// same pattern used by the Inquiry match route.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Exports every offer currently loaded for the selected brand - i.e. every
// supplier's price for that brand, not just what the matrix grid happens to
// display - as a real .xlsx (via the SheetJS "xlsx" package, same one used
// by the smart import wizard to read uploads), so it opens straight into
// Excel with numeric price/RRP cells rather than text.
async function downloadOffersXlsx(filename: string, offers: Offer[]) {
  const XLSX = await import("xlsx");

  const data = offers.map((o) => ({
    Supplier: o.supplier,
    Brand: o.brand,
    Product: o.product,
    SKU: o.sku ?? "",
    Price: o.price,
    Currency: o.currency,
    RRP: o.rrp ?? "",
    MOQ: o.moq ?? "",
    "Lead time": o.leadTimeDays ?? "",
    "Payment terms": o.paymentTerms ?? "",
    Region: o.region ?? "",
    Incoterm: o.incoterm ?? "",
    "Market origin": o.marketOrigin ?? "",
    Availability: o.availability ?? "",
    Notes: o.notes ?? "",
    Added: new Date(o.createdAt).toLocaleDateString(),
  }));

  const sheet = XLSX.utils.json_to_sheet(data);
  sheet["!cols"] = [
    { wch: 20 }, // Supplier
    { wch: 18 }, // Brand
    { wch: 32 }, // Product
    { wch: 16 }, // SKU
    { wch: 10 }, // Price
    { wch: 10 }, // Currency
    { wch: 10 }, // RRP
    { wch: 8 }, // MOQ
    { wch: 14 }, // Lead time
    { wch: 18 }, // Payment terms
    { wch: 12 }, // Region
    { wch: 14 }, // Incoterm
    { wch: 14 }, // Market origin
    { wch: 14 }, // Availability
    { wch: 30 }, // Notes
    { wch: 12 }, // Added
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Offers");
  XLSX.writeFile(workbook, filename);
}

export default function MatrixPage() {
  const [brands, setBrands] = useState<{ brand: string; count: number }[]>([]);
  const [brand, setBrand] = useState("");
  // Free-text filter over the brand dropdown - this list can run into the
  // hundreds, so typing a few letters narrows it down instead of scrolling.
  const [brandSearch, setBrandSearch] = useState("");
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [editingOffer, setEditingOffer] = useState<Offer | null>(null);

  // Per-column price filter, Excel-style: clicking the filter icon in a
  // supplier's column header narrows the grid to only the product rows where
  // that supplier actually quoted a price. Multiple active columns combine
  // with AND - a row must have a price under every active supplier to stay
  // visible, same as stacking column filters in Excel.
  const [priceFilterSuppliers, setPriceFilterSuppliers] = useState<Set<string>>(new Set());

  // Toolbar-level stock-status filter: narrows the grid to only products that
  // have at least one supplier offer matching one of the selected statuses
  // (e.g. "In Stock" or "Preorder"). Multiple selected statuses combine with
  // OR - checking both shows every product available either in stock or on
  // preorder - since a product having any of the selected statuses is what
  // "show me stock and preorder offers" means, unlike the per-supplier price
  // filter above which is a per-column AND.
  const [availabilityFilter, setAvailabilityFilter] = useState<Set<string>>(new Set());

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

  // Fuzzy (case/punctuation/typo-tolerant) so e.g. "matiere premiere" also
  // surfaces "MATIERE PREMIERE." or "Materia Premiere", and "mesoestetic"
  // matches both "MESOESTETIC" and "MESOESTETIC.".
  const filteredBrands = useMemo(
    () => fuzzyFilterSort(brands, brandSearch, (b) => b.brand),
    [brands, brandSearch]
  );

  // Keep the currently selected brand in the option list even if it no
  // longer matches the search text - otherwise typing after picking a brand
  // would make the dropdown silently show no selection.
  const brandDropdownOptions = useMemo(() => {
    if (!brand || filteredBrands.some((b) => b.brand === brand)) return filteredBrands;
    const current = brands.find((b) => b.brand === brand);
    return current ? [current, ...filteredBrands] : filteredBrands;
  }, [brand, brands, filteredBrands]);

  const handleBrandSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter with exactly one match jumps straight to it, so a known brand
    // name can be typed and confirmed without ever touching the dropdown.
    if (e.key === "Enter" && filteredBrands.length === 1) {
      setBrand(filteredBrands[0].brand);
      setBrandSearch("");
    } else if (e.key === "Escape") {
      setBrandSearch("");
    }
  };

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

  const handleDownloadBrandXlsx = () => {
    if (!brand || offers.length === 0) return;
    // Sanitize for use in a filename - brand names can contain slashes,
    // periods, etc. picked up from messy source spreadsheets.
    const safeBrand = brand.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "brand";
    downloadOffersXlsx(`${safeBrand}-prices-${new Date().toISOString().slice(0, 10)}.xlsx`, offers);
  };

  useEffect(() => {
    fetchOffers();
    setSelectedKeys(new Set());
    setEditingRrpKey(null);
    setPriceFilterSuppliers(new Set());
    setAvailabilityFilter(new Set());
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

  // Distinct availability values seen across this brand's offers (e.g.
  // "In Stock", "Preorder"), used to build the filter toggle buttons - only
  // shows options that actually occur, instead of a fixed list that might not
  // match what suppliers for this brand quoted.
  const availabilityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const o of offers) {
      if (o.availability) set.add(o.availability);
    }
    return Array.from(set).sort();
  }, [offers]);

  // Rows to actually render once the per-column price filter and the
  // availability filter are applied. Price-filter suppliers combine with AND
  // (same as Excel autofilter, see above); availability combines with OR - a
  // product stays visible if ANY of its supplier offers matches one of the
  // selected statuses, since selecting both "In Stock" and "Preorder" should
  // widen the view, not narrow it further.
  const filteredProducts = useMemo(() => {
    if (priceFilterSuppliers.size === 0 && availabilityFilter.size === 0) return products;
    return products.filter((p) => {
      const bySupplier = cellPrice.get(p.key);
      if (!bySupplier) return false;
      for (const s of priceFilterSuppliers) {
        if (!bySupplier.has(s)) return false;
      }
      if (availabilityFilter.size > 0) {
        let matches = false;
        for (const o of bySupplier.values()) {
          if (o.availability && availabilityFilter.has(o.availability)) {
            matches = true;
            break;
          }
        }
        if (!matches) return false;
      }
      return true;
    });
  }, [products, cellPrice, priceFilterSuppliers, availabilityFilter]);

  // Row selection (keyed the same way as the Product rows above - SKU if
  // present, else lowercased/trimmed product name) for bulk delete. Cleared
  // whenever the brand changes so a stale selection from a previous brand
  // can never carry over invisibly.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const toggleRow = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectAll = () => {
    // Select-all only ever acts on the currently visible (filtered) rows -
    // selecting "all" shouldn't silently include rows hidden by a column
    // price filter.
    setSelectedKeys((prev) =>
      prev.size === filteredProducts.length ? new Set() : new Set(filteredProducts.map((p) => p.key))
    );
  };

  const allSelected = filteredProducts.length > 0 && selectedKeys.size === filteredProducts.length;
  const someSelected = selectedKeys.size > 0 && !allSelected;

  const [deletingSelected, setDeletingSelected] = useState(false);

  // Deletes every underlying offer (across every supplier) for each selected
  // product row - a row can represent several offers, one per supplier, and
  // there's no bulk endpoint, so this fans out one DELETE per offer id with
  // capped concurrency (mapWithConcurrency) to stay under the pg pool limit.
  const deleteSelectedRows = async () => {
    if (selectedKeys.size === 0) return;
    const ids: number[] = [];
    for (const key of selectedKeys) {
      const bySupplier = cellPrice.get(key);
      if (!bySupplier) continue;
      for (const o of bySupplier.values()) ids.push(o.id);
    }
    if (ids.length === 0) return;
    if (
      !confirm(
        `Delete ${ids.length} offer(s) across ${selectedKeys.size} selected product(s)? This can't be undone.`
      )
    ) {
      return;
    }
    setDeletingSelected(true);
    try {
      await mapWithConcurrency(ids, 5, (id) => fetch(`/api/offers/${id}`, { method: "DELETE" }));
      setSelectedKeys(new Set());
      fetchOffers();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete selected offers.");
    } finally {
      setDeletingSelected(false);
    }
  };

  // Inline RRP editing. RRP isn't its own column in the schema - it's a
  // field on each individual offer (see `rrp` in lib/types.ts), and this
  // Matrix page shows one canonical value per product row (whichever
  // offer's rrp was added most recently - see productMap above). Editing it
  // here writes the same value to every offer under this row's key, across
  // every supplier, so the row stays consistent no matter which underlying
  // offer is "most recent" afterwards. Deliberately does NOT touch
  // `currency`, which is shared with the offer's price - only `rrp` itself
  // is sent in the PUT body.
  const [editingRrpKey, setEditingRrpKey] = useState<string | null>(null);
  const [rrpDraft, setRrpDraft] = useState("");
  const [savingRrp, setSavingRrp] = useState(false);
  const [rrpError, setRrpError] = useState<string | null>(null);

  const startRrpEdit = (key: string, currentRrp: number | null) => {
    setEditingRrpKey(key);
    setRrpDraft(currentRrp != null ? String(currentRrp) : "");
    setRrpError(null);
  };

  const cancelRrpEdit = () => {
    setEditingRrpKey(null);
    setRrpDraft("");
    setRrpError(null);
  };

  const saveRrpEdit = async () => {
    if (!editingRrpKey) return;
    const trimmed = rrpDraft.trim();
    let value: number | null = null;
    if (trimmed !== "") {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setRrpError("Enter a valid non-negative number, or leave blank to clear.");
        return;
      }
      value = parsed;
    }
    const bySupplier = cellPrice.get(editingRrpKey);
    const ids = bySupplier ? Array.from(bySupplier.values()).map((o) => o.id) : [];
    if (ids.length === 0) {
      cancelRrpEdit();
      return;
    }
    setSavingRrp(true);
    setRrpError(null);
    try {
      await mapWithConcurrency(ids, 5, (id) =>
        fetch(`/api/offers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rrp: value }),
        })
      );
      setEditingRrpKey(null);
      setRrpDraft("");
      fetchOffers();
    } catch (e) {
      setRrpError(e instanceof Error ? e.message : "Failed to update RRP.");
    } finally {
      setSavingRrp(false);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold">Price Matrix</h1>
        <p className="mt-1 text-sm text-gray-500">
          Pick a brand to see every product against every supplier side by side. In each row with
          2+ quotes, the cheapest price is green, the priciest is red, and the runner-up is amber
          when there are 3 or more quotes to compare.
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
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <input
              type="text"
              className="input w-56"
              placeholder="Search brands…"
              value={brandSearch}
              onChange={(e) => setBrandSearch(e.target.value)}
              onKeyDown={handleBrandSearchKeyDown}
            />
            {brandSearch && (
              <button
                type="button"
                onClick={() => setBrandSearch("")}
                title="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
              >
                ×
              </button>
            )}
          </div>
          <select
            className="input w-72"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
          >
            <option value="">Select a brand…</option>
            {brandDropdownOptions.map((b) => (
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
          {brand && offers.length > 0 && (
            <button
              onClick={handleDownloadBrandXlsx}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Download Excel ({offers.length.toLocaleString()})
            </button>
          )}
          {brandSearch && (
            <span className="text-xs text-gray-400">
              {filteredBrands.length} of {brands.length} brand{brands.length === 1 ? "" : "s"}
              {filteredBrands.length === 1 ? " - press Enter to select" : ""}
            </span>
          )}
        </div>
      )}

      {brandRenameNotice && <p className="text-xs text-green-700">{brandRenameNotice}</p>}

      {brand && availabilityOptions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-gray-500">Availability:</span>
          {availabilityOptions.map((a) => {
            const active = availabilityFilter.has(a);
            return (
              <button
                key={a}
                onClick={() =>
                  setAvailabilityFilter((prev) => {
                    const next = new Set(prev);
                    if (next.has(a)) next.delete(a);
                    else next.add(a);
                    return next;
                  })
                }
                className={`rounded-full border px-3 py-1 text-xs ${
                  active
                    ? "border-gray-900 bg-gray-900 text-white"
                    : "border-gray-300 text-gray-600 hover:border-gray-400"
                }`}
              >
                {a}
              </button>
            );
          })}
          {availabilityFilter.size > 0 && (
            <button
              onClick={() => setAvailabilityFilter(new Set())}
              className="text-xs text-gray-400 underline hover:text-gray-700"
            >
              clear
            </button>
          )}
        </div>
      )}

      {brand && (priceFilterSuppliers.size > 0 || availabilityFilter.size > 0) && (
        <p className="text-xs text-gray-500">
          Showing {filteredProducts.length} of {products.length} products
          {priceFilterSuppliers.size > 0 && (
            <>
              {" "}
              - priced by{" "}
              <span className="font-medium text-gray-700">{Array.from(priceFilterSuppliers).join(", ")}</span>
            </>
          )}
          {availabilityFilter.size > 0 && (
            <>
              {" "}
              - status{" "}
              <span className="font-medium text-gray-700">{Array.from(availabilityFilter).join(", ")}</span>
            </>
          )}{" "}
          -{" "}
          <button
            onClick={() => {
              setPriceFilterSuppliers(new Set());
              setAvailabilityFilter(new Set());
            }}
            className="underline hover:text-gray-700"
          >
            clear filter
          </button>
        </p>
      )}

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
          {selectedKeys.size > 0 && (
            <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
              <span className="text-xs text-red-700">
                {selectedKeys.size} product{selectedKeys.size === 1 ? "" : "s"} selected
              </span>
              <button
                onClick={deleteSelectedRows}
                disabled={deletingSelected}
                className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50"
              >
                {deletingSelected ? "Deleting…" : "Delete selected"}
              </button>
              <button
                onClick={() => setSelectedKeys(new Set())}
                disabled={deletingSelected}
                className="text-xs text-gray-400 hover:underline"
              >
                Clear selection
              </button>
            </div>
          )}
          <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
            {/* table-fixed + colgroup gives every column a real, stable width
                up front. With the old auto layout, a supplier name that could
                wrap (to avoid overlapping the price column) let the browser
                shrink that whole column down to fit just "-" placeholders in
                the body, which then forced the header name to wrap one
                letter per line. Fixed widths make that impossible. */}
            <table className="table-fixed text-left text-xs">
              <colgroup>
                <col style={{ width: CHECKBOX_COL_WIDTH }} />
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
                    className="sticky left-0 z-10 border-r border-gray-200 bg-gray-50 px-2 py-2 align-top"
                    style={{ width: CHECKBOX_COL_WIDTH, minWidth: CHECKBOX_COL_WIDTH, maxWidth: CHECKBOX_COL_WIDTH }}
                  >
                    <input
                      type="checkbox"
                      title="Select all"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th
                    className="sticky z-10 border-r border-gray-200 bg-gray-50 px-3 py-2 align-top relative"
                    style={{
                      left: CHECKBOX_COL_WIDTH,
                      width: productColWidth,
                      minWidth: productColWidth,
                      maxWidth: productColWidth,
                    }}
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
                    style={{ left: CHECKBOX_COL_WIDTH + productColWidth }}
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
                                onClick={() => {
                                  setPriceFilterSuppliers((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(s)) next.delete(s);
                                    else next.add(s);
                                    return next;
                                  });
                                }}
                                title={
                                  priceFilterSuppliers.has(s)
                                    ? `Filtered to products priced by "${s}" - click to clear`
                                    : `Show only products priced by "${s}"`
                                }
                                className={
                                  priceFilterSuppliers.has(s)
                                    ? "font-normal normal-case text-blue-600"
                                    : "font-normal normal-case text-gray-300 hover:text-gray-600"
                                }
                              >
                                ▾
                              </button>
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
                {filteredProducts.length === 0 && (
                  <tr>
                    <td colSpan={3 + suppliers.length} className="px-3 py-6 text-center text-xs text-gray-400">
                      No products match the current filter(s).{" "}
                      <button
                        onClick={() => {
                          setPriceFilterSuppliers(new Set());
                          setAvailabilityFilter(new Set());
                        }}
                        className="underline hover:text-gray-600"
                      >
                        Clear filter
                      </button>
                    </td>
                  </tr>
                )}
                {filteredProducts.map((p, rowIdx) => {
                  const bySupplier = cellPrice.get(p.key);
                  // Rank every supplier that quoted this product, cheapest to
                  // priciest, so each price cell can be colored by where it
                  // lands in this row - not just whether it's THE cheapest.
                  // Ties (identical prices) share a rank. Only built for rows
                  // with 2+ quotes - a single-supplier row has nothing to
                  // rank against, so its cell stays uncolored.
                  const rankBySupplier = new Map<string, { rank: number; size: number }>();
                  if (bySupplier && bySupplier.size > 1) {
                    const sorted = Array.from(bySupplier.entries()).sort((a, b) => a[1].price - b[1].price);
                    let rank = 0;
                    let lastPrice: number | null = null;
                    sorted.forEach(([s, o], i) => {
                      if (lastPrice === null || o.price !== lastPrice) rank = i + 1;
                      lastPrice = o.price;
                      rankBySupplier.set(s, { rank, size: sorted.length });
                    });
                  }
                  const rowBg = rowIdx % 2 === 1 ? "bg-gray-50/60" : "bg-white";
                  const isSelected = selectedKeys.has(p.key);
                  const isEditingRrp = editingRrpKey === p.key;
                  return (
                    <tr
                      key={p.key}
                      className={`group border-b border-gray-100 last:border-0 hover:bg-gray-50 ${rowBg}`}
                    >
                      <td
                        className={`sticky left-0 z-10 border-r border-gray-200 px-2 py-2 align-top group-hover:bg-gray-50 ${rowBg}`}
                        style={{
                          width: CHECKBOX_COL_WIDTH,
                          minWidth: CHECKBOX_COL_WIDTH,
                          maxWidth: CHECKBOX_COL_WIDTH,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(p.key)}
                        />
                      </td>
                      <td
                        className={`sticky z-10 border-r border-gray-200 px-3 py-2 align-top font-medium group-hover:bg-gray-50 ${rowBg}`}
                        style={{
                          left: CHECKBOX_COL_WIDTH,
                          width: productColWidth,
                          minWidth: productColWidth,
                          maxWidth: productColWidth,
                        }}
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
                        title={
                          isEditingRrp
                            ? undefined
                            : p.rrpAt
                            ? `RRP as of ${new Date(p.rrpAt).toLocaleDateString()} - click to edit`
                            : "Click to set an RRP"
                        }
                        onClick={() => !isEditingRrp && startRrpEdit(p.key, p.rrp)}
                        className={`sticky z-10 border-r border-gray-200 px-3 py-2 text-right align-top tabular-nums text-gray-500 group-hover:bg-gray-50 ${rowBg} ${
                          isEditingRrp ? "" : "cursor-pointer hover:underline"
                        }`}
                        style={{ left: CHECKBOX_COL_WIDTH + productColWidth }}
                      >
                        {isEditingRrp ? (
                          <div
                            className="flex flex-col items-end gap-1 normal-case"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              autoFocus
                              type="number"
                              step="0.01"
                              min="0"
                              placeholder="Blank clears RRP"
                              className="input w-24 text-right text-xs tabular-nums"
                              value={rrpDraft}
                              onChange={(e) => setRrpDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveRrpEdit();
                                if (e.key === "Escape") cancelRrpEdit();
                              }}
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={saveRrpEdit}
                                disabled={savingRrp}
                                className="text-[10px] font-medium text-gray-900 hover:underline disabled:opacity-50"
                              >
                                {savingRrp ? "Saving…" : "Save"}
                              </button>
                              <button
                                onClick={cancelRrpEdit}
                                disabled={savingRrp}
                                className="text-[10px] text-gray-400 hover:underline"
                              >
                                Cancel
                              </button>
                            </div>
                            {rrpError && (
                              <div className="max-w-[8rem] whitespace-normal text-[10px] text-red-600">
                                {rrpError}
                              </div>
                            )}
                          </div>
                        ) : p.rrp != null ? (
                          <>
                            {p.rrp.toFixed(2)} {p.rrpCurrency}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      {suppliers.map((s) => {
                        const cell = bySupplier?.get(s);
                        const rank = rankBySupplier.get(s);
                        const isBest = rank?.rank === 1;
                        // Second-cheapest only gets its own color when there's
                        // a distinct middle ground to call out (3+ quotes) -
                        // with exactly two quotes, the "other" one is already
                        // the priciest and gets that treatment below instead.
                        const isSecond = !!rank && rank.size > 2 && rank.rank === 2;
                        const isWorst = !!rank && rank.rank === rank.size;
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
                            } ${
                              isBest
                                ? "bg-green-50 font-semibold text-green-700"
                                : isWorst
                                ? "bg-red-50 font-semibold text-red-700"
                                : isSecond
                                ? "bg-amber-50 font-semibold text-amber-700"
                                : "text-gray-700"
                            }`}
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
                                {cell.availability && (
                                  <div className="text-[10px] font-normal normal-case text-gray-400">
                                    {cell.availability}
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
          Drag the right edge of the Product column header to resize it. Click any RRP to edit or
          clear it - this updates that value across every supplier for the product, not just one
          offer. Check rows and use &quot;Delete selected&quot; to bulk-delete every offer for
          those products (across all suppliers) - handy for clearing out bad imported data. In any
          row quoted by 2+ suppliers, the cheapest price is green, the priciest is red, and the
          runner-up is amber once there are 3+ quotes to rank - single-supplier rows have nothing
          to compare against, so they're left plain. Each
          price shows its discount vs that row&apos;s RRP underneath - red means the price is
          above RRP. &quot;Updated&quot; under each supplier is when their most recent price for
          this brand was added. Click any price to edit that offer, or hover the product name to
          see it in full. Next to a supplier name, ✎ renames it everywhere (across every brand,
          not just this one), and 🗑 deletes all of that supplier&apos;s offers for this brand
          only. The Availability buttons above the table filter to products with at least one
          offer in that status (e.g. In Stock or Preorder); each price shows its own status
          underneath when known. Hover a price for its exact date.{" "}
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
