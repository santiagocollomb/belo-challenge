export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Valida que un valor sea un entero positivo (para validar ids) y lo devuelve como Number.
export function asPositiveInt(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new HttpError(400, `${field} debe ser un entero positivo`);
  }
  return number;
}

// Lockea origin y destination en orden de id (evita deadlocks) y los devuelve.
export async function lockUsers(client, ids) {
  const { rows } = await client.query(
    "SELECT id, saldo FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE",
    [ids],
  );
  return new Map(rows.map((u) => [u.id, u]));
}
