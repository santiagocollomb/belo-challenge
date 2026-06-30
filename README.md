# Belo Challenge

API de transacciones entre usuarios con saldos atómicos y control de concurrencia.

Stack: Node + Express + PostgreSQL

## Env vars

Copiar de .env.sample

`DATABASE_URL` configurable (default `postgres://belo:belo@localhost:5434/belo`).

## Correr

```bash
docker compose up -d        # levanta Postgres y crea el schema (schema.sql)
npm install
npm run seed
npm start                   # API en http://localhost:3000
```

## Tests

Necesitan la DB corriendo (`docker compose up -d`).

```bash
npm test
```

Cubren: umbral 50k, saldo insuficiente, confirmada/pendiente, approve/reject,
doble approve, y concurrencia (dos débitos simultáneos no sobregiran).

## Endpoints

Importar `belo_challenge.postman_collection.json`. Variable `baseUrl` = `http://localhost:3000`.
Antes de probar correr `npm run seed` (crea usuarios id 1 y 2)
