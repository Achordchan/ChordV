import { Prisma, type PrismaClient } from "@prisma/client";

function quoteIdentifier(name: string): string {
  if (!name || name.includes("\0")) throw new Error("Invalid Prisma schema identifier");
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build PostgreSQL probes from THIS release's generated client, not the database's
 * current metadata or migration history (a later migration may have removed fields).
 * Identifiers are trusted generated metadata, quoted even for @map/@@map/@@schema.
 * An unqualified table uses the Prisma connection's configured schema/search_path.
 */
export function buildPrismaSchemaProbes(models: readonly Prisma.DMMF.Model[] = Prisma.dmmf.datamodel.models): Prisma.Sql[] {
  if (models.length === 0) throw new Error("Missing generated Prisma model metadata");
  return models.map((model) => {
    const columns = model.fields
      .filter((field) => field.kind === "scalar" || field.kind === "enum")
      .map((field) => quoteIdentifier(field.dbName ?? field.name));
    if (columns.length === 0) throw new Error(`Missing Prisma scalar fields for ${model.name}`);
    const table = [model.schema, model.dbName ?? model.name]
      .filter((name): name is string => name !== null && name !== undefined)
      .map(quoteIdentifier).join(".");
    // LIMIT 0 still resolves every column/table in PostgreSQL, including on empty
    // tables, but never scans or returns business records (passwords, tickets, etc.).
    return Prisma.sql`SELECT ${Prisma.raw(columns.join(", "))} FROM ${Prisma.raw(table)} LIMIT 0`;
  });
}

/**
 * Read-only structural compatibility gate through the running Prisma engine.
 * Proves mapped tables/scalar columns are selectable, NOT data-type compatibility,
 * constraints, write privileges, enum values, or all application/business semantics.
 */
export async function assertPrismaSchemaCompatible(prisma: Pick<PrismaClient, "$queryRaw">): Promise<void> {
  for (const query of buildPrismaSchemaProbes()) {
    await prisma.$queryRaw(query);
  }
}
