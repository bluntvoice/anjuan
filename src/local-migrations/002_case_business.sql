-- Add versions to existing manual records. Preserve all existing row values.
ALTER TABLE cases ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE contacts ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE facts ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

-- A terms row identifies a simplified fee. Existing fees retain their stored values.
CREATE TABLE phase2_fee_terms (
  fee_id INTEGER PRIMARY KEY REFERENCES fee_items(id) ON DELETE RESTRICT,
  agreed_fen INTEGER NOT NULL CHECK (
    typeof(agreed_fen) = 'integer' AND agreed_fen BETWEEN 0 AND 9007199254740991
  ),
  payable_bps INTEGER NOT NULL CHECK (
    typeof(payable_bps) = 'integer' AND payable_bps BETWEEN 0 AND 10000
  ),
  -- Split before multiplying so even the maximum amount stays within integer range.
  payable_fen INTEGER GENERATED ALWAYS AS (
    (agreed_fen / 10000) * payable_bps + ((agreed_fen % 10000) * payable_bps + 5000) / 10000
  ) STORED
);
