import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";

let base;
let server;

// Inserta dos usuarios con saldo conocido. Devuelve sus ids.
async function seed(saldoA = 100000, saldoB = 0) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, saldo) VALUES
       ('A', 'a@test.com', $1), ('B', 'b@test.com', $2)
     RETURNING id`,
    [saldoA, saldoB],
  );

  return rows.map((r) => r.id);
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  return { status: res.status, body: await res.json().catch(() => null) };
}

const getSaldoDe = async (id) =>
  Number(
    (await pool.query("SELECT saldo FROM users WHERE id = $1", [id])).rows[0]
      .saldo,
  );

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});

beforeEach(() =>
  pool.query("TRUNCATE transactions, users RESTART IDENTITY CASCADE"),
);

after(async () => {
  server.close();
  await pool.end();
});

test("monto <= 50000 se confirma y mueve fondos", async () => {
  const [a, b] = await seed(100000, 0);
  const { status, body } = await api("POST", "/transactions", {
    origin_id: a,
    destination_id: b,
    monto: 30000,
  });

  assert.equal(status, 201);
  assert.equal(body.estado, "confirmada");
  assert.equal(await getSaldoDe(a), 70000);
  assert.equal(await getSaldoDe(b), 30000);
});

test("monto > 50000 queda pendiente y NO mueve fondos", async () => {
  const [a, b] = await seed(100000, 0);
  const { status, body } = await api("POST", "/transactions", {
    origin_id: a,
    destination_id: b,
    monto: 60000,
  });

  assert.equal(status, 201);
  assert.equal(body.estado, "pendiente");
  assert.equal(await getSaldoDe(a), 100000);
  assert.equal(await getSaldoDe(b), 0);
});

test("saldo insuficiente => 400, sin cambios", async () => {
  const [a, b] = await seed(1000, 0);
  const { status } = await api("POST", "/transactions", {
    origin_id: a,
    destination_id: b,
    monto: 5000,
  });

  assert.equal(status, 400);
  assert.equal(await getSaldoDe(a), 1000);
});

test("usuario inexistente => 404", async () => {
  const [a] = await seed(1000, 0);
  const { status } = await api("POST", "/transactions", {
    origin_id: a,
    destination_id: 9999,
    monto: 100,
  });

  assert.equal(status, 404);
});

test("approve confirma y mueve fondos", async () => {
  const [a, b] = await seed(100000, 0);
  const { body: tx } = await api("POST", "/transactions", {
    origin_id: a,
    destination_id: b,
    monto: 60000,
  });
  const { status, body } = await api("PATCH", `/transactions/${tx.id}/approve`);

  assert.equal(status, 200);
  assert.equal(body.estado, "confirmada");
  assert.equal(await getSaldoDe(a), 40000);
  assert.equal(await getSaldoDe(b), 60000);
});

test("approve dos veces => 400 la segunda", async () => {
  const [a, b] = await seed(100000, 0);
  const { body: tx } = await api("POST", "/transactions", {
    origin_id: a,
    destination_id: b,
    monto: 60000,
  });

  await api("PATCH", `/transactions/${tx.id}/approve`);

  const { status } = await api("PATCH", `/transactions/${tx.id}/approve`);

  assert.equal(status, 400);
});

test("reject no mueve fondos y bloquea approve posterior", async () => {
  const [a, b] = await seed(100000, 0);
  const { body: tx } = await api("POST", "/transactions", {
    origin_id: a,
    destination_id: b,
    monto: 60000,
  });
  const { status, body } = await api("PATCH", `/transactions/${tx.id}/reject`);

  assert.equal(status, 200);
  assert.equal(body.estado, "rechazada");
  assert.equal(await getSaldoDe(a), 100000);
  assert.equal(
    (await api("PATCH", `/transactions/${tx.id}/approve`)).status,
    400,
  );
});

test("GET lista por usuario ordenado por fecha desc", async () => {
  const [a, b] = await seed(100000, 0);

  await api("POST", "/transactions", {
    origin_id: a,
    destination_id: b,
    monto: 100,
  });
  await api("POST", "/transactions", {
    origin_id: a,
    destination_id: b,
    monto: 200,
  });

  const { status, body } = await api("GET", `/transactions?userId=${a}`);

  assert.equal(status, 200);
  assert.equal(body.length, 2);
  assert.ok(new Date(body[0].fecha) >= new Date(body[1].fecha));
});

// dos transacciones simultáneas del mismo origen no pueden
// superar el saldo. FOR UPDATE serializa; el saldo nunca queda negativo.
test("concurrencia: dos débitos simultáneos no sobregiran", async () => {
  // montos <= 50000 => confirman y debitan; juntos (60000) superan el saldo (50000)
  const [a, b] = await seed(50000, 0);
  const [r1, r2] = await Promise.all([
    api("POST", "/transactions", {
      origin_id: a,
      destination_id: b,
      monto: 30000,
    }),
    api("POST", "/transactions", {
      origin_id: a,
      destination_id: b,
      monto: 30000,
    }),
  ]);
  const oks = [r1, r2].filter((r) => r.status === 201);
  const fails = [r1, r2].filter((r) => r.status === 400);

  assert.equal(oks.length, 1);
  assert.equal(fails.length, 1);
  assert.equal(await getSaldoDe(a), 20000);
  assert.ok((await getSaldoDe(a)) >= 0);
});

test("idempotencia: reintento con misma Idempotency-Key no duplica ni re-debita", async () => {
  const [a, b] = await seed(100000, 0);
  const body = { origin_id: a, destination_id: b, monto: 30000 };
  const headers = { "Idempotency-Key": "abc-123" };

  const r1 = await api("POST", "/transactions", body, headers);
  const r2 = await api("POST", "/transactions", body, headers);

  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200); // devuelve la original, no crea otra
  assert.equal(r1.body.id, r2.body.id);
  assert.equal(await getSaldoDe(a), 70000); // debitó una sola vez

  const { body: list } = await api("GET", `/transactions?userId=${a}`);
  assert.equal(list.length, 1);
});
