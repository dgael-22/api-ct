/**
 * src/scripts/syncInventory.ts
 * ============================
 * Paso 8 del tutorial: correr la sincronización de inventario a mano.
 * Igual que dice el ETS, todavía no hace falta un scheduler.
 *
 *   npm run sync:inventory
 *   npm run sync:inventory -- 5      (sólo los primeros 5 mapeos)
 */
import { inicializarBd, repositorios } from "../data-source";
import { InventorySyncService } from "../services/InventorySyncService";
import { ShopifyClient } from "../services/ShopifyClient";
import { crearClienteCt } from "../services/ctFactory";

const limite = process.argv[2] ? Number(process.argv[2]) : undefined;

async function principal(): Promise<void> {
  await inicializarBd();
  const { productos } = repositorios();
  const servicio = new InventorySyncService(crearClienteCt(), new ShopifyClient(), productos);

  const resultados = await servicio.sincronizarConfirmados(limite);
  if (resultados.length === 0) {
    console.log("No hay mappings confirmados. Carga y confirma al menos uno primero.");
    return;
  }

  for (const r of resultados) {
    const marca = r.actualizado ? "OK  " : "-   ";
    console.log(
      `${marca} ${r.shopifySku} <- ${r.ctSku} | CT: ${r.existenciaEnCt} | ` +
      `publicado: ${r.cantidadPublicada}` + (r.motivo ? ` | ${r.motivo}` : "")
    );
  }
  console.log(
    `\nRevisados: ${resultados.length} · ` +
    `Actualizados: ${resultados.filter((r) => r.actualizado).length}`
  );
}

principal()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Falló la sincronización:", (e as Error).message);
    process.exit(1);
  });
