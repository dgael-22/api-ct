/**
 * Migración inicial: las dos tablas del modelo mínimo del ETS.
 *
 * Se escribe con la API de `Table` de TypeORM en vez de SQL a mano, para que la
 * MISMA migración corra en SQLite (local) y en PostgreSQL (Railway) sin dos
 * versiones que se puedan desincronizar.
 */
import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

export class CrearTablasIniciales1757000000000 implements MigrationInterface {
  name = "CrearTablasIniciales1757000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const postgres = queryRunner.connection.options.type === "postgres";
    const idColumna = {
      name: "id",
      type: postgres ? "serial" : "integer",
      isPrimary: true,
      isGenerated: !postgres,
      generationStrategy: "increment" as const,
    };
    const fecha = postgres ? "timestamp" : "datetime";

    // ---------------------------------------------------------- productos ---
    await queryRunner.createTable(
      new Table({
        name: "product_mapping",
        columns: [
          idColumna,
          { name: "shopifyVariantId", type: "varchar", isNullable: false },
          { name: "inventoryItemId", type: "varchar", isNullable: true },
          { name: "locationId", type: "varchar", isNullable: true },
          { name: "shopifySku", type: "varchar", isNullable: false },
          { name: "ctProductId", type: "varchar", isNullable: true },
          { name: "ctSku", type: "varchar", isNullable: false },
          { name: "partNumber", type: "varchar", isNullable: true },
          { name: "status", type: "varchar", default: "'pending'" },
          { name: "reason", type: "text", isNullable: true },
          { name: "confirmedBy", type: "varchar", isNullable: true },
          { name: "createdAt", type: fecha, default: "now()" },
          { name: "updatedAt", type: fecha, default: "now()" },
        ],
      }),
      true
    );

    await queryRunner.createIndices("product_mapping", [
      new TableIndex({
        name: "IDX_product_mapping_variant",
        columnNames: ["shopifyVariantId"],
        isUnique: true,
      }),
      new TableIndex({ name: "IDX_product_mapping_shopify_sku", columnNames: ["shopifySku"] }),
      new TableIndex({ name: "IDX_product_mapping_ct_sku", columnNames: ["ctSku"] }),
    ]);

    // ------------------------------------------------------------ ordenes ---
    await queryRunner.createTable(
      new Table({
        name: "order_mapping",
        columns: [
          idColumna,
          { name: "shopifyOrderId", type: "varchar", isNullable: false },
          { name: "shopifyOrderName", type: "varchar", isNullable: true },
          { name: "ctOrderId", type: "varchar", isNullable: true },
          { name: "ctStatus", type: "varchar", isNullable: true },
          { name: "status", type: "varchar", default: "'received'" },
          { name: "externalReference", type: "integer", isNullable: true },
          { name: "sentAt", type: fecha, isNullable: true },
          { name: "confirmDeadline", type: fecha, isNullable: true },
          { name: "confirmedAt", type: fecha, isNullable: true },
          { name: "confirmAttempts", type: "integer", default: 0 },
          { name: "requestPayload", type: "text", isNullable: true },
          { name: "lastResponse", type: "text", isNullable: true },
          { name: "createdAt", type: fecha, default: "now()" },
          { name: "updatedAt", type: fecha, default: "now()" },
        ],
      }),
      true
    );

    await queryRunner.createIndices("order_mapping", [
      // Único: la misma orden de Shopify no puede registrarse dos veces.
      new TableIndex({
        name: "IDX_order_mapping_shopify_order",
        columnNames: ["shopifyOrderId"],
        isUnique: true,
      }),
      // Único: la llave de idempotencia hacia CT.
      new TableIndex({
        name: "IDX_order_mapping_external_ref",
        columnNames: ["externalReference"],
        isUnique: true,
      }),
      new TableIndex({ name: "IDX_order_mapping_ct_order", columnNames: ["ctOrderId"] }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("order_mapping", true);
    await queryRunner.dropTable("product_mapping", true);
  }
}
