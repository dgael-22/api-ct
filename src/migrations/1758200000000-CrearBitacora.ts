/**
 * Tabla `bitacora`: eventos que deben sobrevivir a los 7 días de logs de Railway.
 * Misma migración para SQLite y PostgreSQL, como la inicial.
 */
import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

export class CrearBitacora1758200000000 implements MigrationInterface {
  name = "CrearBitacora1758200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const postgres = queryRunner.connection.options.type === "postgres";
    await queryRunner.createTable(
      new Table({
        name: "bitacora",
        columns: [
          {
            name: "id",
            type: postgres ? "serial" : "integer",
            isPrimary: true,
            isGenerated: !postgres,
            generationStrategy: "increment",
          },
          { name: "fecha", type: postgres ? "timestamp" : "datetime", default: "now()" },
          { name: "nivel", type: "varchar", isNullable: false },
          { name: "tipo", type: "varchar", isNullable: false },
          { name: "shopifyOrderId", type: "varchar", isNullable: true },
          { name: "mensaje", type: "text", isNullable: false },
          { name: "detalle", type: "text", isNullable: true },
        ],
      }),
      true
    );
    await queryRunner.createIndices("bitacora", [
      new TableIndex({ name: "IDX_bitacora_fecha", columnNames: ["fecha"] }),
      new TableIndex({ name: "IDX_bitacora_tipo", columnNames: ["tipo"] }),
      new TableIndex({ name: "IDX_bitacora_orden", columnNames: ["shopifyOrderId"] }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("bitacora");
  }
}
