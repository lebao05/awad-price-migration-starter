import { createServer } from 'node:http';

// v4 of the menu service: CONTRACT.
//
// This version never names `menu_items.price` — not in a SELECT, not in an
// INSERT, not in an UPDATE. That is what makes dropping the column (migration
// 003) safe while v4 keeps serving. `price_vnd` (dong, INTEGER) is the only
// source of truth.
//
// The HTTP contract is unchanged: old clients still send and receive `price`
// (thousands of dong), new clients send and receive `priceVnd` (dong). `price`
// is derived on the way out, `price_vnd` on the way in.

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const error = (res, status, code, message) => json(res, status, { error: code, message });

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

const isPrice = (p) => typeof p === 'number' && Number.isFinite(p) && p > 0 && p <= 100000;
const isPriceVnd = (v) => Number.isInteger(v) && v > 0 && v <= 100000000;
const toVnd = (price) => Math.round(price * 1000);
const toThousands = (vnd) => vnd / 1000;

// One numeric input, one stored value. `price` is the old unit, `priceVnd` the
// new one; both are stored as the integer dong value of the same price.
function parsePrice(body) {
  if (!body || typeof body !== 'object') return null;
  const hasPrice = body.price !== undefined;
  const hasVnd = body.priceVnd !== undefined;
  if (hasPrice === hasVnd) return null;
  if (hasPrice) return isPrice(body.price) ? toVnd(body.price) : null;
  return isPriceVnd(body.priceVnd) ? body.priceVnd : null;
}

export function createApp(db) {
  const q = {
    list: db.prepare('SELECT id, name, price_vnd FROM menu_items ORDER BY id LIMIT ? OFFSET ?'),
    get: db.prepare('SELECT id, name, price_vnd FROM menu_items WHERE id = ?'),
    insert: db.prepare('INSERT INTO menu_items (name, price_vnd) VALUES (?, ?)'),
    setPrice: db.prepare('UPDATE menu_items SET price_vnd = ? WHERE id = ?'),
    insertOrder: db.prepare("INSERT INTO orders (created_at) VALUES (datetime('now'))"),
    insertLine: db.prepare('INSERT INTO order_items (order_id, menu_item_id, qty, unit_price) VALUES (?, ?, ?, ?)'),
  };

  // Old clients keep reading `price` in thousands; it is computed, never stored.
  const view = (row) => ({
    id: row.id,
    name: row.name,
    price: toThousands(row.price_vnd),
    priceVnd: row.price_vnd,
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

    if (parts[0] === 'menu' && parts.length === 1) {
      if (req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return json(res, 200, q.list.all(limit, offset).map(view));
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const vnd = parsePrice(body);
        if (vnd === null || typeof body.name !== 'string' || !body.name)
          return error(res, 400, 'invalid_body', 'name (string) and price (thousands of dong) or priceVnd (dong) are required');
        const { lastInsertRowid } = q.insert.run(body.name, vnd);
        return json(res, 201, view(q.get.get(lastInsertRowid)));
      }
    }

    if (parts[0] === 'menu' && parts.length === 2) {
      const id = Number(parts[1]);
      const row = Number.isInteger(id) ? q.get.get(id) : undefined;
      if (!row) return error(res, 404, 'not_found', `menu item ${parts[1]} not found`);
      if (req.method === 'GET') return json(res, 200, view(row));
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const vnd = parsePrice(body);
        if (vnd === null) return error(res, 400, 'invalid_body', 'price (thousands of dong) or priceVnd (dong) is required');
        q.setPrice.run(vnd, id);
        return json(res, 200, view(q.get.get(id)));
      }
    }

    if (req.method === 'POST' && url.pathname === '/orders') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.items) || body.items.length === 0)
        return error(res, 400, 'invalid_body', 'items: [{menuItemId, qty}] is required');
      db.exec('BEGIN IMMEDIATE');
      try {
        const { lastInsertRowid: orderId } = q.insertOrder.run();
        let total = 0;
        for (const { menuItemId, qty } of body.items) {
          const item = q.get.get(menuItemId);
          if (!item || !Number.isInteger(qty) || qty < 1) throw Object.assign(new Error(), { status: 400 });
          // order_items.unit_price keeps its old unit (thousands) and is not migrated
          const price = toThousands(item.price_vnd);
          q.insertLine.run(orderId, item.id, qty, price);
          total += price * qty;
        }
        db.exec('COMMIT');
        return json(res, 201, { id: Number(orderId), total: Math.round(total * 1000) / 1000 });
      } catch (e) {
        db.exec('ROLLBACK');
        if (e.status === 400) return error(res, 400, 'invalid_item', 'unknown menuItemId or bad qty');
        throw e;
      }
    }

    return error(res, 404, 'not_found', 'no such route');
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) error(res, 500, 'internal', e.message);
    });
  });
}
