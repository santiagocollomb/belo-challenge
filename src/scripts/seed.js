import { pool } from "../db.js";

// Resetea la DB y crea dos usuarios A y B para probar la API.
// Uso: npm run seed [saldoA] [saldoB]   (default 100000 / 0)
const saldoA = Number(process.argv[2] ?? 100000);
const saldoB = Number(process.argv[3] ?? 0);

await pool.query("TRUNCATE transactions, users RESTART IDENTITY CASCADE");
const { rows } = await pool.query(
  `INSERT INTO users (name, email, saldo) VALUES
     ('A', 'a@test.com', $1), ('B', 'b@test.com', $2)
   RETURNING id, name, email, saldo`,
  [saldoA, saldoB],
);
console.table(rows);
await pool.end();
