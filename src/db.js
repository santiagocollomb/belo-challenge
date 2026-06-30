import pg from "pg";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://belo:belo@localhost:5434/belo",
});

// Corre fn dentro de una transacción; COMMIT si resuelve, ROLLBACK si tira.
export async function executeFunctionInTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
