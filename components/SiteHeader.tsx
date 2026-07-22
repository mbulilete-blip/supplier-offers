"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Beauty Hub embeds this whole app in an iframe (see its /supplier-offers
// page) and already renders its own tab bar with the same links, so showing
// this header too gives a duplicated double-nav. Detecting "am I inside an
// iframe" (rather than relying on a `?embed=1` param) means it stays hidden
// across every internal Link click too, not just the first page load.
// Starts hidden (null) to avoid a flash of the header before we know.
export default function SiteHeader() {
  const [embedded, setEmbedded] = useState<boolean | null>(null);

  useEffect(() => {
    setEmbedded(window.self !== window.top);
  }, []);

  if (embedded !== false) return null;

  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <span className="text-lg font-semibold tracking-tight">Supplier Offers</span>
        <nav className="flex gap-6 text-sm font-medium text-gray-600">
          <Link href="/" className="hover:text-gray-900">
            All Offers
          </Link>
          <Link href="/compare" className="hover:text-gray-900">
            Compare
          </Link>
          <Link href="/matrix" className="hover:text-gray-900">
            Matrix
          </Link>
          <Link href="/inquiry" className="hover:text-gray-900">
            Sourcing Inquiry
          </Link>
          <Link href="/quotes" className="hover:text-gray-900">
            Sales Pipeline
          </Link>
          <Link href="/history" className="hover:text-gray-900">
            History
          </Link>
          <Link href="/import-check" className="hover:text-gray-900">
            Check New Prices
          </Link>
          <Link href="/names" className="hover:text-gray-900">
            Brands &amp; Suppliers
          </Link>
        </nav>
      </div>
    </header>
  );
}
