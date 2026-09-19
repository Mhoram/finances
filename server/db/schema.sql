CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT    NOT NULL CHECK(type IN ('buy', 'sell')),
  date        TEXT    NOT NULL,           -- YYYY-MM-DD
  time        TEXT,                       -- HH:MM:SS (optional, from DeGiro)
  isin        TEXT    NOT NULL,
  product_name TEXT   NOT NULL DEFAULT '',
  quantity    TEXT    NOT NULL,           -- string decimal, always positive
  price_eur   TEXT    NOT NULL,           -- price per unit in EUR
  costs_eur   TEXT    NOT NULL DEFAULT '0',
  total_eur   TEXT    NOT NULL,           -- abs(quantity * price + costs)
  source      TEXT    NOT NULL CHECK(source IN ('manual', 'degiro')),
  import_id   TEXT    UNIQUE,             -- sha256 hash; NULL for manual entries
  notes       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_isin ON transactions(isin);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);

-- Current prices for unrealised gain/loss estimation
CREATE TABLE IF NOT EXISTS prices (
  isin        TEXT PRIMARY KEY,
  price_eur   TEXT NOT NULL,
  ticker      TEXT,             -- Yahoo Finance symbol, cached from lookup
  currency    TEXT,             -- native currency of the quote (may differ from EUR)
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Manually entered carry-forward losses from outside the system
-- (e.g. losses from share sales before DeGiro / before system tracking began)
-- The engine uses this as a seed when computing year N:
--   carry_in(N) = computed carry_out(N-1) + manual_loss(N-1)
CREATE TABLE IF NOT EXISTS loss_pool (
  tax_year    INTEGER PRIMARY KEY,  -- year the loss was INCURRED (carried into next year)
  loss_amount TEXT    NOT NULL      -- string decimal, always positive
);

-- Manual override for ETF classification. Auto-detect (product_name contains "ETF")
-- runs at read time; a row here overrides that guess for a given ISIN.
CREATE TABLE IF NOT EXISTS etf_flags (
  isin        TEXT PRIMARY KEY,
  is_etf      INTEGER NOT NULL CHECK(is_etf IN (0,1))
);

-- Confirmed (filed) 8-year deemed disposal events for ETF lots (Irish offshore funds
-- exit tax, TCA 1997 s.747E). Recording a cycle locks in closing_value as the cost
-- basis for that lot's next 8-year cycle, and tax_paid_eur becomes a credit against
-- tax due on an eventual actual disposal of the same lot.
CREATE TABLE IF NOT EXISTS deemed_disposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_id          INTEGER NOT NULL,          -- transactions.id of the original buy
  isin            TEXT    NOT NULL,
  cycle           INTEGER NOT NULL,          -- 1 = first deemed disposal (8yr), 2 = second (16yr), ...
  disposal_date   TEXT    NOT NULL,          -- YYYY-MM-DD, the 8-year anniversary
  quantity        TEXT    NOT NULL,          -- units subject to this cycle
  opening_value   TEXT    NOT NULL,          -- basis at start of this cycle
  closing_value   TEXT    NOT NULL,          -- market value at disposal_date; becomes next cycle's opening_value
  gain_eur        TEXT    NOT NULL,
  tax_rate        TEXT    NOT NULL,          -- e.g. '0.41' or '0.38', as applicable on disposal_date
  tax_paid_eur    TEXT    NOT NULL,
  recorded_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lot_id, cycle)
);

-- Net worth tracking. Manually-managed asset/liability line items (bank accounts,
-- property, pensions, mortgages, loans, investment portfolios, ...), snapshotted
-- over time. is_illiquid marks assets not accessible on short notice (property,
-- pension) or liabilities tied to one (a mortgage tracks with its property), so
-- the UI can show a "liquid net worth" view that excludes both sides together.
CREATE TABLE IF NOT EXISTS net_worth_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL CHECK(type IN ('asset', 'liability')),
  category    TEXT    NOT NULL,          -- e.g. cash, investments, property, pension, vehicle, other_asset, mortgage, loan, credit_card, other_liability
  is_illiquid INTEGER NOT NULL DEFAULT 0, -- not accessible/payable on short notice
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,                      -- soft-delete: hidden from new snapshots but kept for historical ones
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS net_worth_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date  TEXT    NOT NULL UNIQUE,   -- YYYY-MM-DD
  notes          TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS net_worth_values (
  snapshot_id  INTEGER NOT NULL REFERENCES net_worth_snapshots(id) ON DELETE CASCADE,
  item_id      INTEGER NOT NULL REFERENCES net_worth_items(id),
  value_eur    TEXT    NOT NULL,
  PRIMARY KEY (snapshot_id, item_id)
);

-- Mortgage/loan amortization tracking. "kind" distinguishes the two UI modes
-- (mortgage exposes lump sums/rate periods/ERC, loan is a simpler subset) but
-- both share this same schema/engine — switching kind later loses no data.
CREATE TABLE IF NOT EXISTS loans (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT    NOT NULL,
  kind                    TEXT    NOT NULL DEFAULT 'mortgage' CHECK(kind IN ('mortgage', 'loan')),
  principal_eur           TEXT    NOT NULL,
  default_annual_rate     TEXT    NOT NULL,          -- percent, e.g. '3.5'
  term_months             INTEGER NOT NULL,
  start_year              INTEGER NOT NULL,
  start_month             INTEGER NOT NULL DEFAULT 1, -- 1-12
  monthly_overpayment_eur TEXT    NOT NULL DEFAULT '0',
  erc_enabled             INTEGER NOT NULL DEFAULT 0,
  erc_end_year            INTEGER,
  erc_comparator_rate     TEXT,                        -- percent
  erc_allowance_pct       TEXT    NOT NULL DEFAULT '10',
  net_worth_item_id       INTEGER REFERENCES net_worth_items(id), -- optional link; current balance prefills this liability's snapshot value
  archived_at             TEXT,
  created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loan_lump_sums (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id    INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  year       INTEGER NOT NULL,      -- lands in January of this year
  amount_eur TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS loan_rate_periods (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id     INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  start_year  INTEGER NOT NULL,
  end_year    INTEGER NOT NULL,
  annual_rate TEXT    NOT NULL       -- percent
);

CREATE INDEX IF NOT EXISTS idx_loan_lump_sums_loan    ON loan_lump_sums(loan_id);
CREATE INDEX IF NOT EXISTS idx_loan_rate_periods_loan ON loan_rate_periods(loan_id);
