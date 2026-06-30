import express from "express";
import { pool, executeFunctionInTransaction } from "./db.js";
import { asPositiveInt, lockUsers, HttpError } from "./utils.js";

export const PENDING_THRESHOLD = 50000; // monto > esto => pendiente (verificación manual)

export const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(
      `${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(1)}ms)`,
    );
  });
  next();
});

// Error handler central
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError)
    return res.status(err.status).json({ error: err.message });

  console.error(err);

  res.status(500).json({ error: "error interno" });
});

// ENDPOINTS
app.post("/transactions", async (req, res, next) => {
  try {
    const origin_id = asPositiveInt(req.body?.origin_id, "origin_id");
    const destination_id = asPositiveInt(
      req.body?.destination_id,
      "destination_id",
    );
    const monto = Number(req.body?.monto);

    if (!(monto > 0)) throw new HttpError(400, "monto debe ser mayor a 0");

    if (origin_id === destination_id)
      throw new HttpError(400, "origin y destination deben ser distintos");

    // Idempotencia opcional: con header Idempotency-Key, un reintento no duplica.
    const idemKey = req.get("Idempotency-Key") || null;

    const estado = monto > PENDING_THRESHOLD ? "pendiente" : "confirmada";

    console.log(
      `[dbTransaction] crear: ${origin_id}->${destination_id} monto=${monto} => ${estado}`,
    );

    const dbTransaction = await executeFunctionInTransaction(async (client) => {
      const users = await lockUsers(client, [origin_id, destination_id]);

      if (!users.has(origin_id)) throw new HttpError(404, "origin no existe");

      if (!users.has(destination_id))
        throw new HttpError(404, "destination no existe");

      if (Number(users.get(origin_id).saldo) < monto)
        throw new HttpError(400, "saldo insuficiente");

      const { rows } = await client.query(
        `INSERT INTO transactions (origin_id, destination_id, monto, estado, idempotency_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [origin_id, destination_id, monto, estado, idemKey],
      );

      if (estado === "confirmada") {
        console.log(
          `[dbTransaction] #${rows[0].id} confirmada: debita ${monto} de ${origin_id}, acredita a ${destination_id}`,
        );

        await client.query(
          "UPDATE users SET saldo = saldo - $1 WHERE id = $2",
          [monto, origin_id],
        );
        await client.query(
          "UPDATE users SET saldo = saldo + $1 WHERE id = $2",
          [monto, destination_id],
        );
      }

      return rows[0];
    });

    res.status(201).json(dbTransaction);
  } catch (err) {
    // Reintento con Idempotency-Key ya usada: devolvemos la transacción original.
    if (err.code === "23505") {
      const { rows } = await pool.query(
        "SELECT * FROM transactions WHERE idempotency_key = $1",
        [req.get("Idempotency-Key")],
      );
      if (rows[0]) return res.status(200).json(rows[0]);
    }
    next(err);
  }
});

app.get("/transactions", async (req, res, next) => {
  try {
    const userId = asPositiveInt(req.query.userId, "userId");

    const { rows } = await pool.query(
      `SELECT * FROM transactions
       WHERE origin_id = $1 OR destination_id = $1
       ORDER BY fecha DESC`,
      [userId],
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.patch("/transactions/:id/approve", async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id, "id");

    res.json(await resolvePending(id, true));
  } catch (err) {
    next(err);
  }
});

app.patch("/transactions/:id/reject", async (req, res, next) => {
  try {
    const id = asPositiveInt(req.params.id, "id");

    res.json(await resolvePending(id, false));
  } catch (err) {
    next(err);
  }
});

// Resuelve una transacción pendiente. confirm=true => mueve fondos; false => rechaza.
async function resolvePending(id, confirm) {
  console.log(`[dbTransaction] #${id} ${confirm ? "approve" : "reject"}`);

  return executeFunctionInTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM transactions WHERE id = $1 FOR UPDATE",
      [id],
    );

    const dbTransaction = rows[0];

    if (!dbTransaction) throw new HttpError(404, "transacción no encontrada");

    if (dbTransaction.estado !== "pendiente")
      throw new HttpError(
        400,
        `transacción no está pendiente (estado: ${dbTransaction.estado})`,
      );

    if (!confirm) {
      const upd = await client.query(
        "UPDATE transactions SET estado = 'rechazada' WHERE id = $1 RETURNING *",
        [id],
      );
      return upd.rows[0];
    }

    await lockUsers(client, [
      dbTransaction.origin_id,
      dbTransaction.destination_id,
    ]);

    try {
      await client.query("UPDATE users SET saldo = saldo - $1 WHERE id = $2", [
        dbTransaction.monto,
        dbTransaction.origin_id,
      ]);
    } catch (err) {
      if (err.code === "23514") throw new HttpError(400, "saldo insuficiente");

      throw err;
    }

    await client.query("UPDATE users SET saldo = saldo + $1 WHERE id = $2", [
      dbTransaction.monto,
      dbTransaction.destination_id,
    ]);

    console.log(
      `[dbTransaction] #${id} confirmada: movió ${dbTransaction.monto} de ${dbTransaction.origin_id} a ${dbTransaction.destination_id}`,
    );

    const upd = await client.query(
      "UPDATE transactions SET estado = 'confirmada' WHERE id = $1 RETURNING *",
      [id],
    );

    return upd.rows[0];
  });
}
