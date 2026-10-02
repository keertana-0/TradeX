# TradeX — Indian Market Paper Trading & Technical Analysis Platform

## Historical NIFTY Options Explorer

The `/historical` page reads minute OHLC CSVs from `data/historical-options` in the TradeX project. Set `TRADEX_HISTORICAL_OPTIONS_DIR` to a different dataset root only if you move the data elsewhere. The endpoint reads the selected CSV on demand; the dataset does not need to be loaded into the database.

## Strategy Agent Arena

Each agent is an independent deterministic module under `lib/strategy-agents/modules`. Modules implement ICT/SMC, Wyckoff, trend following, breakout/retest, mean reversion, VWAP, ORB, momentum, order flow, and statistical pairs. They return structured `LONG`, `SHORT`, `EXIT`, or `NO_TRADE` signals with regime, confidence score, entry, stop, target, risk/reward, reasons, and timestamp. Missing inputs lead to `NO_TRADE`; in particular order flow requires bid/ask delta and pairs requires synchronized related-market history. Thresholds live in `DEFAULT_STRATEGY_CONFIG`; evaluation receives only completed candles up to the current bar.

The Strategy Agent Arena evaluates each strategy on NIFTY 50, NIFTY BANK, and SENSEX candles. A directional setup can select a current-week, near-ATM call (bullish) or put (bearish) using Upstox option-chain quotes, and simulates entries/exits against premium bid/ask prices. The selection requires a valid `UPSTOX_ACCESS_TOKEN`; without it, live option simulation waits rather than inventing prices. The default filters require nonzero volume, a two-sided market, and no more than 5% bid/ask spread. Entries are blocked before 09:20 IST and require confidence >= 0.55 (configurable via `STRATEGY_OPTION_ENTRY_START_IST` and `STRATEGY_OPTION_MIN_CONFIDENCE`). The default premium stop and target are 25% and 40%; all are configurable with `STRATEGY_OPTION_*` variables. Set `STRATEGY_AGENT_TIMEFRAME_MINUTES` (1–60, default 5). Opening the Strategy Agent Arena creates today's paper session automatically. A server worker continues active sessions every 15 seconds and the page refreshes the leaderboards. The runner waits for regular market hours and fresh completed bars; with five-minute bars the first analysis is after the 09:15–09:20 candle closes. Index candle data comes from Yahoo and may be delayed or stale; the runner waits if the configured freshness checks fail. Yahoo states that its market data is informational and not intended for trading or investment decisions ([Yahoo Finance data sources](https://help.yahoo.com/kb/SLN2310.html)). Upstox documents the option-chain response fields used for expiry, strikes, bid/ask, and volume ([Put/Call Option Chain API](https://upstox.com/developer/api-documentation/get-pc-option-chain/)).

The strategy competition now simulates long option premiums from Upstox option-chain bid/ask quotes. It still places no broker orders. Historical strategy backtests below are index spot proxies and do not validate option profitability. The regular paper-trading portfolio and the Strategy Agent Arena are separate simulations.

Run `npm run backtest:strategy-agents` to evaluate each strategy independently against the local NIFTY spot candles. The script uses chronological 60/20/20 training, validation, and test splits, next-bar fills, ₹20 per-side fees, 0.05% slippage, risk-based sizing, and a pessimistic stop-first rule if stop and target fall in the same candle. It writes `data/strategy-backtests/independent-strategy-results.json`. These are spot-proxy results only; they do not validate live multi-index option outcomes, which depend on premiums, IV, spreads, expiry, and lot sizes. Generate the Prisma client and apply the existing schema with `npm run db:generate` and `npm run db:push` before using persisted signals; `db:push` requires PostgreSQL to be running.

> **EDUCATIONAL & PAPER TRADING NOTICE:** TradeX is an educational paper-trading platform utilizing simulated virtual capital. It never executes real-money trades, never deposits/withdraws real funds, and does not claim that technical indicators guarantee future price performance.

---

## 1. Overview & Architecture

TradeX is a full-stack, production-quality Indian stock-market paper trading and technical analysis terminal designed to run seamlessly on **Vercel** with **Next.js (App Router)** and **PostgreSQL (via Prisma ORM)**.

```
Browser (React Client)
   │ (Interactive Candlestick Charts, Option Chain Matrix, Paper Order Ticket, Portfolio)
   ▼
Next.js 14 App Router on Vercel
   ├── Server Actions & Vercel Functions
   ├── RBAC Middleware (ADMIN vs USER)
   ├── Market Data Abstraction Layer (Live Provider Feed + Offline Dev Adapter)
   ├── Multi-Factor Technical Indicator & Signal Engine
   ├── Atomic Paper-Trading Execution Engine (Decimal Precision)
   └── Immutable Fund Ledger & System Security Audit Trail
   │
   ▼
PostgreSQL Database (Neon / Vercel Marketplace / Supabase / Self-hosted)
```

---

## 2. Core Capabilities

1. **Strict Market Data Integrity**:
   - Live mode (`MARKET_DATA_MODE=live`): Retrieves genuine market data from licensed external feeds.
   - If external feeds are unreachable or credentials are unconfigured, TradeX **strictly displays "Live market data unavailable"** and **NEVER generates fake market data**.
   - Offline development mode (`MARKET_DATA_MODE=development`): An isolated development adapter is provided for local deterministic testing and unit tests.
2. **Indian Market Hours & Calendar**:
   - Accounts for NSE / BSE trading sessions (09:15 to 15:30 IST) in `Asia/Kolkata` time.
   - Built-in exchange holiday calendar (Republic Day, Holi, Diwali, etc.) and weekend closures.
3. **Modular Technical Analysis Engine**:
   - **Trend**: SMA, EMA (20 & 50), Supertrend (ATR-based), ADX (+DI/-DI).
   - **Momentum**: RSI (14, Wilder's smoothing), MACD (12, 26, 9), Stochastic Oscillator (%K, %D).
   - **Volatility**: Bollinger Bands (Upper, Middle, Lower, Bandwidth), ATR (14).
   - **Volume**: VWAP, OBV.
   - **Explainable Multi-factor Scoring**: Deterministic score mapping to `BULLISH`, `BEARISH`, or `SIDEWAYS`, with `Weak`, `Moderate`, or `Strong` signal confidence and transparent indicator breakdown.
4. **Options Chain Analysis (NIFTY 50 & SENSEX)**:
   - Side-by-side Call (CE) and Put (PE) matrix around ATM strike.
   - **Highest Observed Volume Strike** ("Volume Leader", explicitly labeled without buy recommendation).
   - Put/Call Ratio (PCR) by Volume and Open Interest (OI).
5. **Paper Trading Engine & Financial Math**:
   - Buy & Sell support with Market and Limit orders.
   - Exact financial decimal precision (`decimal.js`) preventing floating-point rounding errors.
   - Weighted average cost accounting for multi-tranche purchases.
   - Realized and Unrealized P&L mark-to-market calculations.
   - Atomic database transactions (`prisma.$transaction`) ensuring cash deduction, trade persistence, and position updates occur simultaneously.
6. **Immutable Virtual Capital Ledger**:
   - `fund_transactions` table records all debits/credits (`INITIAL_ALLOCATION`, `TRADE_BUY`, `TRADE_SELL`, `ADMIN_CREDIT`, `ADMIN_DEBIT`) with `balanceBefore` and `balanceAfter`.
7. **Two Isolated Portals & Role-Based Access Control (RBAC)**:
   - **User Portal (`/dashboard`, `/stocks/[symbol]`, `/options/[symbol]`, `/portfolio`, `/orders`, `/watchlist`)**: Paper trading, charting, and portfolio tracking.
   - **Admin Portal (`/admin`)**: User creation, virtual capital allocation, and system audit trail inspection. Normal users cannot access `/admin` or `/api/admin/*`.

---

## 3. Technology Stack

- **Framework**: Next.js 14 (App Router, Server Actions, Route Handlers)
- **Language**: TypeScript 5
- **Styling**: Tailwind CSS, Lucide React
- **Database & ORM**: PostgreSQL with Prisma ORM
- **Authentication**: Stateless JOSE HS256 JWT session cookies with bcryptjs password hashing
- **Validation**: Zod
- **Financial Math**: Decimal.js
- **Testing**: Vitest

---

## 4. Setup & Local Development

### Prerequisites
- Node.js LTS (v20+ or v22+)
- Python 3.9+ (required for automated Jugaad historical options backtests)
- PostgreSQL database (e.g., [Neon Serverless Postgres](https://neon.tech), Supabase, or local PostgreSQL)

### 1. Clone & Install Dependencies
```bash
npm install
npm run python:install
```

The `/backtest` page retrieves daily NSE index-option OHLC data from `jugaad-data` automatically. It uses the prior session close to select strikes, then the next session's recorded open and close for the simulated trade. No options CSV upload is required. Successful daily chains are cached under `services/.cache/jugaad-options`.

Jugaad provides end-of-day options data, so the backtest is daily and does not simulate intraday fills. NSE availability depends on the requested historical date and contract. To run the legacy Python analysis/paper-trading service separately, use `npm run python:start`.

Each Jugaad request is limited to 180 calendar days. For a separately hosted Next.js deployment, run the Python service with `npm run python:start` and set `JUGAAD_HISTORICAL_API_URL` to its base URL. Set the same `JUGAAD_HISTORICAL_API_TOKEN` in both services when the Python endpoint is exposed outside a trusted network.

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Set the variables:
```ini
# PostgreSQL connection string
DATABASE_URL="postgresql://user:password@ep-cool-frost-123456.ap-southeast-1.aws.neon.tech/tradex?sslmode=require"

# Minimum 32-character session encryption secret
AUTH_SECRET="tradex_super_secret_session_jwt_key_at_least_32_chars_2026"

# Market Data Mode: "development" for local offline testing, "live" for production feeds
MARKET_DATA_MODE="development"
MARKET_DATA_API_URL="https://query1.finance.yahoo.com"
MARKET_DATA_API_KEY=""

# Admin seed credentials
ADMIN_EMAIL="admin@tradex.local"
ADMIN_PASSWORD="AdminSecurePassword123!"
```

### 3. Database Migration & Seeding
```bash
# Push schema to PostgreSQL
npm run db:push

# Seed admin and demo users with virtual capital
npm run db:seed
```

### 4. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000).

---

## 5. Automated Verification & Testing

Run all automated test suites (indicators, financial math, options analysis, market calendar, signal scoring):
```bash
npm test
```

Run TypeScript compilation verification:
```bash
npm run typecheck
```

Run ESLint checks:
```bash
npm run lint
```

Run production build:
```bash
npm run build
```

---

## 6. Vercel Deployment Guide

1. **Create a PostgreSQL Database**:
   - Provision a PostgreSQL database via Neon ([neon.tech](https://neon.tech)) or the Vercel Marketplace.
2. **Deploy to Vercel**:
   - Connect your GitHub repository to Vercel.
   - Framework Preset: **Next.js**.
   - Build Command: `prisma generate && next build` (configured in `package.json`).
3. **Configure Environment Variables in Vercel**:
   - `DATABASE_URL`: Your PostgreSQL connection string.
   - `AUTH_SECRET`: A secure random 32+ character string.
   - `MARKET_DATA_MODE`: Set to `live` for genuine market feeds.
   - `ADMIN_EMAIL`: Admin email address.
   - `ADMIN_PASSWORD`: Strong administrator password.
4. **Run Migrations on Remote Database**:
   ```bash
   npx prisma db push
   npx tsx prisma/seed.ts
   ```

---

## 7. Demo Accounts

- **Administrator**:
  - Email: `admin@tradex.local`
  - Password: `AdminSecurePassword123!`
  - Portal: `/admin`
- **Demo Trader**:
  - Email: `user@tradex.local`
  - Password: `UserSecurePassword123!`
  - Portal: `/dashboard`
