-- Undo step 3: bring `price` back and re-derive it from price_vnd.
--
-- Schema-wise this is the inverse of the up step. Data-wise it is a restore,
-- not an undo: every row written by v4 after the drop has no `price` value at
-- all, so the column has to be rebuilt from price_vnd. That is a full-table
-- write in one transaction (migrate.js runs each file in one transaction), so
-- it is NOT safe while traffic runs, and it only restores a state that v2 can
-- serve once the transaction commits. This is why the drop is the point of no
-- return: there is no zero-downtime way back from it.
ALTER TABLE menu_items ADD COLUMN price REAL
  CHECK (price > 0);

UPDATE menu_items
   SET price = price_vnd / 1000.0
 WHERE price_vnd IS NOT NULL;
