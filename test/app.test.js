import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { open } from '../src/db.js';
import { createApp } from '../src/app.js';

// v4 runs against the schema after 003: `menu_items` has no `price` column at
// all, so the fixture writes only `price_vnd` and the app must not name the old
// column anywhere.
let server, base, db;
before(async () => {
  db = open(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.up.sql')).sort())
    db.exec(readFileSync(new URL(f, dir), 'utf8'));          // every migration, in order
  db.exec("INSERT INTO menu_items (name, price_vnd) VALUES ('Phở bò', 45500), ('Trà đá', 5000)");
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('the old column is gone from the schema', async () => {
  const cols = db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'name', 'price_vnd']);
});

test('GET /menu/:id returns price in thousands and priceVnd in dong', async () => {
  assert.deepEqual(await call('GET', '/menu/1'), {
    status: 200,
    body: { id: 1, name: 'Phở bò', price: 45.5, priceVnd: 45500 },
  });
});

test('GET /menu lists both fields', async () => {
  const r = await call('GET', '/menu?limit=2');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((x) => x.priceVnd), [45500, 5000]);
  assert.deepEqual(r.body.map((x) => x.price), [45.5, 5]);
});

test('PATCH with the old unit still works and stores dong', async () => {
  const r = await call('PATCH', '/menu/2', { price: 6 });
  assert.equal(r.status, 200);
  assert.equal(r.body.price, 6);
  assert.equal(r.body.priceVnd, 6000);
  assert.equal(db.prepare('SELECT price_vnd FROM menu_items WHERE id = 2').get().price_vnd, 6000);
});

test('PATCH with the new unit works', async () => {
  const r = await call('PATCH', '/menu/2', { priceVnd: 7500 });
  assert.equal(r.status, 200);
  assert.equal(r.body.priceVnd, 7500);
  assert.equal(r.body.price, 7.5);
});

test('POST /menu accepts either unit and returns both', async () => {
  const a = await call('POST', '/menu', { name: 'Chè', price: 12.5 });
  assert.equal(a.status, 201);
  assert.equal(a.body.priceVnd, 12500);
  const b = await call('POST', '/menu', { name: 'Chè', priceVnd: 9000 });
  assert.equal(b.status, 201);
  assert.equal(b.body.price, 9);
  assert.equal(db.prepare('SELECT price_vnd FROM menu_items WHERE id = ?').get(b.body.id).price_vnd, 9000);
});

test('POST /orders totals at the current price', async () => {
  const r = await call('POST', '/orders', { items: [{ menuItemId: 1, qty: 2 }, { menuItemId: 2, qty: 1 }] });
  assert.deepEqual(r, { status: 201, body: { id: 1, total: 98.5 } });
});

test('errors have one shape', async () => {
  assert.deepEqual((await call('GET', '/menu/999')).body.error, 'not_found');
  assert.equal((await call('PATCH', '/menu/1', { price: -1 })).status, 400);
  assert.equal((await call('PATCH', '/menu/1', { price: 1, priceVnd: 1000 })).status, 400);
});
