/**
 * src/scripts/confirmOrders.ts
 * ============================
 * Confirma en CT los pedidos que se crearon pero quedaron sin confirmar.
 *
 *   npm run confirm:orders
 *
 * CT cancela por su cuenta cualquier pedido que no se confirme dentro de su
 * ventana, así que este comando NO es opcional: sin él, un corte de red de un
 * minuto convierte una venta en un pedido cancelado sin que nadie se entere.
 *
 * En producción se programa cada 15 minutos (cron: cada cuarto de hora,
 * "cd /ruta && npm run confirm:orders").
 */
import { inicializarBd, repositorios } from "../data-source";
import { CtClient } from "../services/CtClient";
import { InventorySyncService } from "../services/InventorySyncService";
import { OrderService } from "../services/OrderService";
import { ShopifyClient } from "../services/ShopifyClient";

async function principal(): Promise<void> {
  await inicializarBd();
  const { ordenes, productos } = repositorios();
  const ct = new CtClient();
  const shopify = new ShopifyClient();
  const servicio = new OrderService(
    ct, shopify, ordenes, productos,
    new InventorySyncService(ct, shopify, productos)
  );

  const resumen = await servicio.confirmarPendientes();

  console.log(
    `Confirmados: ${resumen.confirmados} · ` +
    `Fallidos: ${resumen.fallidos} · ` +
    `Vencidos: ${resumen.vencidos}`
  );

  if (resumen.porVencer.length) {
    console.error("\n*** PEDIDOS POR VENCER — REVISAR A MANO ***");
    resumen.porVencer.forEach((linea) => console.error("  - " + linea));
    process.exitCode = 1;
  }
}

principal()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("Falló la confirmación:", (e as Error).message);
    process.exit(1);
  });
