import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import type { Db } from "./index";

/**
 * A fresh in-memory database with every migration in `drizzle/` applied.
 * For tests of modules that take the database as a parameter.
 */
export function createTestDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: "drizzle" });
  return testDb;
}
