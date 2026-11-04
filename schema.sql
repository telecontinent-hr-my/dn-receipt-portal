-- DN Receipt Portal - database schema (Cloudflare D1)
-- Run once:  npx wrangler d1 execute dn-receipts --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS staff (
  tc_id         TEXT PRIMARY KEY,          -- e.g. TC4736
  name          TEXT NOT NULL,
  dn_person_no  TEXT,                      -- "No" column in the DN approved workbook
  email         TEXT,                      -- optional, for HR reference
  active        INTEGER NOT NULL DEFAULT 1,
  pin_hash      TEXT,                      -- PBKDF2-SHA256 of the staff PIN (PIN itself is never stored)
  pin_salt      TEXT,
  pin_set_at    TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id            TEXT PRIMARY KEY,
  tc_id         TEXT NOT NULL,
  claim_month   TEXT NOT NULL,             -- YYYY-MM, the DN claim month the staff claims under
  category      TEXT NOT NULL,             -- DN workbook claim column
  expense_date  TEXT NOT NULL,             -- YYYY-MM-DD, date on the receipt
  amount_sen    INTEGER NOT NULL,          -- receipt amount in sen (RM x 100), no rounding
  merchant      TEXT,
  receipt_no    TEXT,
  remark        TEXT,
  file_key      TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  file_type     TEXT NOT NULL,
  file_size     INTEGER NOT NULL,
  file_hash     TEXT NOT NULL,             -- SHA-256 of the file
  channel       TEXT NOT NULL,             -- 'Staff portal' or 'HR on behalf'
  submitted_by  TEXT NOT NULL,             -- sign-in email of the person who uploaded
  submitted_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Submitted',   -- Submitted | Accepted | Rejected | Withdrawn
  hr_note       TEXT,
  reviewed_by   TEXT,
  reviewed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_receipts_month ON receipts(claim_month);
CREATE INDEX IF NOT EXISTS idx_receipts_staff ON receipts(tc_id);
CREATE INDEX IF NOT EXISTS idx_receipts_hash  ON receipts(file_hash);

-- Every change is logged. Nothing is deleted.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  ref        TEXT,
  detail     TEXT
);
