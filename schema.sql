CREATE TABLE IF NOT EXISTS users (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT NOT NULL,
  saldo NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (saldo >= 0)
);

CREATE TABLE IF NOT EXISTS transactions (
  id             SERIAL PRIMARY KEY,
  origin_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  destination_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  monto          NUMERIC(15,2) NOT NULL CHECK (monto > 0),
  estado         TEXT NOT NULL CHECK (estado IN ('pendiente', 'confirmada', 'rechazada')),
  fecha          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key TEXT UNIQUE  -- opcional; reintentos con la misma key no duplican (UNIQUE permite múltiples NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_transactions_origin_estado ON transactions(origin_id, estado);
CREATE INDEX IF NOT EXISTS idx_transactions_destination_fecha ON transactions(destination_id, fecha);
CREATE INDEX IF NOT EXISTS idx_transactions_fecha ON transactions(fecha);
