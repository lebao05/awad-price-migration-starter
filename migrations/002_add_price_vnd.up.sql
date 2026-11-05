-- Step 2 (expand): add the new column next to the old one.
-- Old code (v1) never mentions price_vnd, so it keeps working unchanged.
-- No data is written here: existing rows stay NULL until the backfill runs.
-- SQLite adds a column by writing only the schema, so this is instant and
-- takes no lock that a reader can observe under WAL.
ALTER TABLE menu_items ADD COLUMN price_vnd INTEGER
  CHECK (price_vnd IS NULL OR price_vnd > 0);
