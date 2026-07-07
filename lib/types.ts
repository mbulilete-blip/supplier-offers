export type OfferInput = {
  supplier: string;
  brand: string;
  product: string;
  sku?: string | null;
  price: number;
  currency?: string;
  rrp?: number | null;
  moq?: number | null;
  leadTimeDays?: number | null;
  paymentTerms?: string | null;
  region?: string | null;
  notes?: string | null;
};

export type Offer = {
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
  createdAt: string;
};

export const CSV_HEADERS = [
  "supplier",
  "brand",
  "product",
  "sku",
  "price",
  "currency",
  "rrp",
  "moq",
  "leadTimeDays",
  "paymentTerms",
  "region",
  "notes",
] as const;
