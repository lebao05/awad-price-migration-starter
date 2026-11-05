-- Undo step 2: remove the new column.
-- Only safe while no running version reads or writes price_vnd (v1 only).
-- After v2 is deployed, roll v2 back out to v1 first, then run this.
ALTER TABLE menu_items DROP COLUMN price_vnd;
