// Single postgres-js pool for the process (conxto idiom — no ORM here; the hub's schema is four
// tables and lives entirely in ensure-schema.ts, so raw tagged SQL is the honest tool).
import postgres from "postgres";

export type Sql = postgres.Sql<{}>;

export function makeSql(url?: string): Sql {
  const u = url ?? process.env.EVALHUB_DATABASE_URL ?? "";
  if (!u) throw new Error("EVALHUB_DATABASE_URL is not set");
  return postgres(u, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    onnotice: () => {},
  });
}

let shared: Sql | null = null;
/** Lazy process-wide pool. Lazy so importing the server in a test never opens a connection. */
export function db(): Sql {
  if (!shared) shared = makeSql();
  return shared;
}
