import { createClient } from "@libsql/client/web";

const clients = new WeakMap();

/** Return the Turso client of this environment, created once per environment. */
export function getDb(env) {
  let db = clients.get(env);
  if (!db) {
    db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
    clients.set(env, db);
  }
  return db;
}

/** Run statements in one round trip and return one result set per statement. */
export async function batch(env, statements) {
  return getDb(env).batch(statements);
}
