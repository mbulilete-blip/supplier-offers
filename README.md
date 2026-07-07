# Supplier Offers

A small internal tool to log every offer you get from suppliers — manually or via CSV
import — and compare them side by side per product to spot the best price, MOQ, and terms.

No login (single-user by design). Runs on Next.js + Postgres, deployed on Vercel.

## What it does

- **All Offers** (`/`) — add an offer by hand, or paste/upload a CSV to bulk-import a batch.
  Fields: supplier, brand, product, SKU, price, currency, RRP, MOQ, lead time, payment
  terms, region, notes.
- **Compare** (`/compare`) — offers grouped by product, sorted by price, cheapest supplier
  highlighted, margin vs. RRP shown where you've logged an RRP.

## CSV format

Header row (order doesn't matter), only `supplier,brand,product,price` are required:

```
supplier,brand,product,sku,price,currency,rrp,moq,leadTimeDays,paymentTerms,region,notes
Beauty Distro NL,Byoma,Milky Toner 200ml,BYM-MT-200,6.20,EUR,12.99,500,14,30% deposit / balance on shipment,EU,Overstock deal
```

## Deploy it (GitHub + Vercel)

1. **Create a GitHub repo** and push this folder:
   ```
   cd supplier-offers-app
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/supplier-offers.git
   git push -u origin main
   ```
   (Create the empty repo first at github.com/new, without a README/gitignore, then use
   the URL it gives you above.)

2. **Import into Vercel**: go to vercel.com → Add New → Project → import the GitHub repo
   you just pushed. Framework preset auto-detects as Next.js — leave defaults and click
   Deploy. The first deploy will fail because there's no database yet; that's expected.

3. **Add a Postgres database**: in the Vercel project → Storage tab → Create Database →
   Postgres (powered by Neon) → connect it to this project. Vercel automatically injects
   the `POSTGRES_URL` environment variable — no manual copy/paste needed.

4. **Redeploy**: Deployments tab → click the "..." menu on the latest deployment →
   Redeploy. The app creates its `offers` table automatically on first request — no
   migration command to run.

5. Open the deployed URL. That's it.

### Local development

```
npm install
cp .env.example .env.local   # then paste your POSTGRES_URL from Vercel's Storage tab
npm run dev
```

## Notes on access

There's no login screen, per your request — anyone with the deployed URL can view and
edit the data. If you'd rather restrict it later, the simplest options are: Vercel
Deployment Protection (password-protects the whole app, available on Vercel dashboard →
Settings → Deployment Protection), or adding a basic-auth check in `middleware.ts`.

## Tech stack

Next.js 14 (App Router) + TypeScript + Tailwind, `pg` for Postgres access (no ORM —
plain SQL in `lib/db.ts`), deployed on Vercel with Vercel Postgres (Neon) for storage.
# supplier-offers
