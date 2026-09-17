/**
 * Guarda la orden de Shopify ya reducida (`orderPayload`).
 *
 * Una orden "blocked" nunca llegó a CT, pero sin sus líneas no había forma de
 * reintentarla: Shopify no vuelve a mandar un webhook que ya contestó 200. Con
 * esto POST /orders/:id/retry la reprocesa desde la base.
 */
import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class GuardarOrdenRecibida1758100000000 implements MigrationInterface {
  name = "GuardarOrdenRecibida1758100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      "order_mapping",
      new TableColumn({ name: "orderPayload", type: "text", isNullable: true })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn("order_mapping", "orderPayload");
  }
}
