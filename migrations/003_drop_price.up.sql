-- Step 3 (contract): drop the old column.
-- Applied only after a version that neither reads nor writes `price` (v4)
-- is serving on every instance. Not before.
-- In PostgreSQL this is the step that needs ACCESS EXCLUSIVE: down there you
-- lock the table briefly (or use the 3-step "drop after all readers are gone"
-- dance) and watch for long transactions holding a snapshot.
ALTER TABLE menu_items DROP COLUMN price;
