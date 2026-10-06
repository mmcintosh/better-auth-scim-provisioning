// ORM schemas for the adapter matrix, built from Better Auth's own table definitions
// (getAuthTables) instead of hand-written: they then follow Better Auth's and the plugin's tables
// exactly, as a host's generated schema would. Column types follow Better Auth's Kysely migrator,
// which creates the tables these schemas describe.
import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";

type Field = { type: string | string[]; fieldName?: string; required?: boolean; unique?: boolean; references?: unknown; index?: boolean; bigint?: boolean };

/** Drizzle (Postgres) tables, keyed by model name, as drizzleAdapter's `schema` expects. */
export async function drizzlePgSchema(options: BetterAuthOptions) {
  const pg = await import("drizzle-orm/pg-core");
  const out: Record<string, unknown> = {};
  for (const [model, table] of Object.entries(getAuthTables(options))) {
    const cols: Record<string, any> = { id: pg.text("id").primaryKey() };
    for (const [key, f] of Object.entries(table.fields as Record<string, Field>)) {
      const name = f.fieldName ?? key;
      const t = Array.isArray(f.type) ? "string" : f.type;
      let c =
        t === "boolean" ? pg.boolean(name)
        : t === "number" ? (f.bigint ? pg.bigint(name, { mode: "number" }) : pg.integer(name))
        : t === "date" ? pg.timestamp(name, { mode: "date" })
        : pg.text(name);
      if (f.required) c = c.notNull();
      cols[key] = c;
    }
    out[model] = pg.pgTable(table.modelName, cols);
  }
  return out;
}

/** Drizzle (MySQL) tables; indexed, unique and referencing columns are varchar(255), as the migrator makes them. */
export async function drizzleMysqlSchema(options: BetterAuthOptions) {
  const my = await import("drizzle-orm/mysql-core");
  const out: Record<string, unknown> = {};
  for (const [model, table] of Object.entries(getAuthTables(options))) {
    const cols: Record<string, any> = { id: my.varchar("id", { length: 36 }).primaryKey() };
    for (const [key, f] of Object.entries(table.fields as Record<string, Field>)) {
      const name = f.fieldName ?? key;
      const t = Array.isArray(f.type) ? "string" : f.type;
      const keyed = Boolean(f.unique || f.references || f.index);
      let c =
        t === "boolean" ? my.boolean(name)
        : t === "number" ? (f.bigint ? my.bigint(name, { mode: "number" }) : my.int(name))
        : t === "date" ? my.timestamp(name, { mode: "date", fsp: 3 })
        : keyed ? my.varchar(name, { length: 255 })
        : my.text(name);
      if (f.required) c = c.notNull();
      cols[key] = c;
    }
    out[model] = my.mysqlTable(table.modelName, cols);
  }
  return out;
}

/**
 * A Prisma schema (Postgres) for the same tables. Model names are Better Auth's model names, so
 * the client's accessors match them (prisma.user, prisma.scimProvisioningJob); foreign keys are
 * plain columns (the adapter doesn't need Prisma relations).
 */
export function prismaSchema(options: BetterAuthOptions, clientOutput: string): string {
  const lines = [
    // Prisma 7's generator, as Better Auth's CLI (`npx auth generate`) writes it for Prisma 7.
    `generator client {\n  provider = "prisma-client"\n  output   = "${clientOutput}"\n}`,
    // Prisma 7: no url here; the client connects through its driver adapter (@prisma/adapter-pg).
    `datasource db {\n  provider = "postgresql"\n}`,
  ];
  for (const table of Object.values(getAuthTables(options))) {
    const body = ["  id String @id"];
    for (const [key, f] of Object.entries(table.fields as Record<string, Field>)) {
      const name = f.fieldName ?? key;
      const t = Array.isArray(f.type) ? "string" : f.type;
      const type = t === "boolean" ? "Boolean" : t === "number" ? (f.bigint ? "BigInt" : "Int") : t === "date" ? "DateTime @db.Timestamptz(6)" : "String";
      const [base, ...attrs] = type.split(" ");
      body.push(`  ${key} ${base}${f.required ? "" : "?"}${attrs.length ? ` ${attrs.join(" ")}` : ""}${f.unique ? " @unique" : ""}${name !== key ? ` @map("${name}")` : ""}`);
    }
    lines.push(`model ${table.modelName} {\n${body.join("\n")}\n  @@map("${table.modelName}")\n}`);
  }
  return `${lines.join("\n\n")}\n`;
}
