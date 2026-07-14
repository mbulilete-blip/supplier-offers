"use client";

import { useEffect, useMemo, useState } from "react";
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

type DailyReportBrand = { brand: string; count: number };
type DailyReportSupplier = { supplier: string; offerCount: number; brands: DailyReportBrand[] };
type DailyReport = {
  date: string;
  totalOffers: number;
  supplierCount: number;
  brandCount: number;
  suppliers: DailyReportSupplier[];
};
type ReportDateCount = { date: string; count: number };

// Local (not UTC) calendar date as YYYY-MM-DD - used for the daily report's
// default date and the max= bound on its date picker, so "today" matches the
// user's own clock rather than flipping over at UTC midnight.
const pad = (n: number) => String(n).padStart(2, "0");
const toLocalDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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

  // Daily report: what came in on one calendar day, grouped by supplier ->
  // brands. Defaults to today so the (much older) bulk CSV import doesn't
  // show up unless the user explicitly picks that day.
  const todayStr = useMemo(() => toLocalDateStr(new Date()), []);
  const [reportDate, setReportDate] = useState(todayStr);
  const [dailyReport, setDailyReport] = useState<DailyReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(true);
  const [reportDates, setReportDates] = useState<ReportDateCount[]>([]);

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

  // Hides the original one-off bulk CSV import from this table by default,
  // per the user's original request to not see "the old CSV I imported at
  // the beginning" here. Toggle-able in case they ever need to see it.
  const [hideBulkImport, setHideBulkImport] = useState(true);

  const load = async (opts?: {
    page?: number;
    search?: string;
    brand?: string;
    supplier?: string;
    hideBulkImport?: boolean;
  }) => {
    setLoading(true);
    const targetPage = opts?.page ?? page;
    const targetSearch = opts?.search ?? search;
    const targetBrand = opts?.brand ?? brand;
    const targetSupplier = opts?.supplier ?? supplier;
    const targetHideBulkImport = opts?.hideBulkImport ?? hideBulkImport;
    const params = new URLSearchParams({
      page: String(targetPage),
      limit: String(PAGE_SIZE),
    });
    if (targetSearch) params.set("search", targetSearch);
    if (targetBrand) params.set("brand", targetBrand);
    if (targetSupplier) params.set("supplier", targetSupplier);
    if (targetHideBulkImport) params.set("excludeBulkImport", "true");
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

  const loadDailyReport = (date: string) => {
    setLoadingReport(true);
    fetch(`/api/dashboard/daily-report?date=${date}`)
      .then((r) => r.json())
      .then((data) => setDailyReport(data))
      .finally(() => setLoadingReport(false));
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
    fetch("/api/dashboard/report-dates")
      .then((r) => r.json())
      .then((data) => setReportDates(Array.isArray(data) ? data : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadDailyReport(reportDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportDate]);

  const shiftReportDate = (deltaDays: number) => {
    const d = new Date(reportDate + "T00:00:00");
    d.setDate(d.getDate() + deltaDays);
    const next = toLocalDateStr(d);
    if (next > todayStr) return; // no future dates
    setReportDate(next);
  };

  const formatReportDate = (dateStr: string) =>
    new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

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

  const handleHideBulkImportChange = (value: boolean) => {
    setHideBulkImport(value);
    setPage(1);
    load({ page: 1, hideBulkImport: value });
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
    loadDailyReport(reportDate);
  };

  const [editingOffer, setEditingOffer] = useState<Offer | null>(null);

  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-2xl font-semibold">All Offers</h1>
        <p className="mt-1 text-sm text-gray-500">
          Every offer you&apos;ve logged, across every supplier.
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
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Daily report</h2>
            <p className="mt-1 text-sm text-gray-500">
              What came in on this day, by supplier and brand.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => shiftReportDate(-1)}
              className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm hover:bg-gray-50"
              aria-label="Previous day"
            >
              ←
            </button>
            <input
              type="date"
              className="input"
              value={reportDate}
              max={todayStr}
              onChange={(e) => e.target.value && setReportDate(e.target.value)}
            />
            <button
              onClick={() => shiftReportDate(1)}
              disabled={reportDate >= todayStr}
              className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40"
              aria-label="Next day"
            >
              →
            </button>
            {reportDate !== todayStr && (
              <button
                onClick={() => setReportDate(todayStr)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                Today
              </button>
            )}
          </div>
        </div>

        {loadingReport ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : !dailyReport || dailyReport.totalOffers === 0 ? (
          <div className="text-sm text-gray-500">
            <p>No offers logged on {formatReportDate(reportDate)}.</p>
            {reportDates.length > 0 && (
              <p className="mt-2">
                Days with offers:{" "}
                {reportDates.slice(0, 8).map((d, i) => (
                  <span key={d.date}>
                    {i > 0 && ", "}
                    <button
                      onClick={() => setReportDate(d.date)}
                      className="text-gray-700 underline hover:text-gray-900"
                    >
                      {formatReportDate(d.date)}
                    </button>{" "}
                    ({d.count})
                  </span>
                ))}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-4 text-sm text-gray-600">
              <span>
                <strong className="text-gray-900">{dailyReport.totalOffers}</strong> offer(s)
              </span>
              <span>
                <strong className="text-gray-900">{dailyReport.supplierCount}</strong> supplier(s)
              </span>
              <span>
                <strong className="text-gray-900">{dailyReport.brandCount}</strong> brand(s)
              </span>
            </div>
            <div className="space-y-3">
              {dailyReport.suppliers.map((s) => (
                <div key={s.supplier} className="rounded-lg border border-gray-100 p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{s.supplier}</span>
                    <span className="text-xs text-gray-400">{s.offerCount} offer(s)</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {s.brands.map((b) => (
                      <span
                        key={b.brand}
                        className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
                      >
                        {b.brand}
                        {b.count > 1 ? ` (${b.count})` : ""}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
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
            <label className="flex items-center gap-1.5 whitespace-nowrap text-sm text-gray-600">
              <input
                type="checkbox"
                checked={hideBulkImport}
                onChange={(e) => handleHideBulkImportChange(e.target.checked)}
              />
              Hide old bulk import
            </label>
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
            loadDailyReport(reportDate);
          }}
        />
      )}
    </div>
  );
}
