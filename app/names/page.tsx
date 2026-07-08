"use client";

import { useEffect, useMemo, useState } from "react";

type NameRow = { name: string; count: number };
type Kind = "brand" | "supplier";

// One shared list for both brands and suppliers - same rename mechanics
// (inline edit -> POST to the existing rename endpoint -> global update
// across every section of the app), just pointed at a different API path
// and label. Having brands and suppliers editable from one index means a
// messy name only ever needs fixing once, instead of hunting for the right
// dropdown/column header on whichever page happens to show it.
function NameList({
  kind,
  endpoint,
  renameEndpoint,
}: {
  kind: Kind;
  endpoint: string;
  renameEndpoint: string;
}) {
  const [rows, setRows] = useState<NameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetch(endpoint)
      .then((r) => r.json())
      .then((data: { brand?: string; supplier?: string; count: number }[]) => {
        const mapped = Array.isArray(data)
          ? data.map((d) => ({ name: (d.brand ?? d.supplier) as string, count: d.count }))
          : [];
        setRows(mapped);
        setLoading(false);
      });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startEdit = (name: string) => {
    setEditing(name);
    setValue(name);
    setError(null);
    setNotice(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setValue("");
    setError(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const to = value.trim();
    if (!to) {
      setError("Name can't be empty.");
      return;
    }
    if (to === editing) {
      cancelEdit();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(renameEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: editing, to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Failed to rename ${kind}.`);
      setNotice(`Renamed ${data.updated} offer(s) from "${editing}" to "${to}".`);
      setEditing(null);
      setValue("");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to rename ${kind}.`);
    } finally {
      setSaving(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, search]);

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-lg font-medium capitalize">
          {kind === "brand" ? "Brands" : "Suppliers"}{" "}
          <span className="text-sm font-normal text-gray-400">({rows.length})</span>
        </h2>
        <input
          className="input w-56"
          placeholder={`Search ${kind}s…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {notice && <p className="mb-3 text-xs text-green-700">{notice}</p>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-400">No {kind}s found.</p>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 border-b border-gray-200 bg-white text-xs uppercase text-gray-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Offers</th>
                <th className="py-2 pr-4 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isEditing = editing === r.name;
                return (
                  <tr key={r.name} className="border-b border-gray-50 last:border-0">
                    <td className="py-2 pr-4">
                      {isEditing ? (
                        <input
                          autoFocus
                          className="input w-full max-w-sm text-sm"
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit();
                            if (e.key === "Escape") cancelEdit();
                          }}
                        />
                      ) : (
                        r.name
                      )}
                      {isEditing && error && (
                        <div className="mt-1 text-xs text-red-600">{error}</div>
                      )}
                    </td>
                    <td className="py-2 pr-4 tabular-nums text-gray-500">
                      {r.count.toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {isEditing ? (
                        <div className="flex justify-end gap-3">
                          <button
                            onClick={saveEdit}
                            disabled={saving}
                            className="text-xs font-medium text-gray-900 hover:underline disabled:opacity-50"
                          >
                            {saving ? "Saving…" : "Save"}
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={saving}
                            className="text-xs text-gray-400 hover:underline"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEdit(r.name)}
                          className="text-xs text-gray-400 hover:text-gray-900 hover:underline"
                        >
                          ✎ Rename
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function NamesPage() {
  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold">Brands &amp; Suppliers</h1>
        <p className="mt-1 text-sm text-gray-500">
          Rename a brand or supplier once here and it updates everywhere - every offer, every
          page (Dashboard, Compare, Matrix, History) - since all of them read the same
          underlying name.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <NameList kind="brand" endpoint="/api/brands" renameEndpoint="/api/brands/rename" />
        <NameList
          kind="supplier"
          endpoint="/api/suppliers"
          renameEndpoint="/api/suppliers/rename"
        />
      </div>
    </div>
  );
}
