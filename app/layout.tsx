import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Supplier Offers",
  description: "Track and compare supplier offers",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-gray-900">
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
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
