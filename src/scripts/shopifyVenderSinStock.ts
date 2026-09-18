/**
 * src/scripts/shopifyVenderSinStock.ts
 * ====================================
 * Activa (o quita) "seguir vendiendo cuando no haya existencias" en las
 * variantes que tienen mapeo confirmado con CT. Sirve para los productos que
 * ya existían: los que crea el importador ya nacen con SHOPIFY_VENDER_SIN_STOCK.
 *
 *   npm run shopify:vender-sin-stock                 (simulación)
 *   npm run shopify:vender-sin-stock -- --aplicar
 *   npm run shopify:vender-sin-stock -- --aplicar --revertir   (vuelve a "no vender en cero")
 *
 * OJO: con esto un producto nunca aparece agotado, así que se puede vender lo
 * que CT no tiene y habría que reembolsar. Úsalo sólo donde CT surta seguro.
 */
import { inicializarBd, repositorios } from "../data-source";
import { ShopifyClient } from "../services/ShopifyClient";
import { alFallar } from "./_shopify";

async function principal(): Promise<void> {
  const args = process.argv.slice(2);
  const aplicar = args.includes("--aplicar");
  const politica = args.includes("--revertir") ? "DENY" : "CONTINUE";

  await inicializarBd();
  const { productos } = repositorios();
  const mapeos = await productos.find({ where: { status: "confirmed" } });
  if (!mapeos.length) {
    console.log("No hay mapeos confirmados todavía.");
    return;
  }

  const shopify = new ShopifyClient();
  console.log(`${mapeos.length} variantes con mapeo confirmado · política: ${politica}`);
  console.log(aplicar ? "MODO: APLICAR\n" : "MODO: simulación (no escribe)\n");

  let hechos = 0, fallidos = 0;
  for (const mapeo of mapeos) {
    const etiqueta = `${mapeo.ctSku} (variante ${mapeo.shopifyVariantId})`;
    if (!aplicar) { console.log(`  [simulado] ${etiqueta}`); continue; }
    try {
      const productId = await shopify.productoDeVariante(mapeo.shopifyVariantId);
      if (!productId) throw new Error("la variante ya no existe en Shopify");
      await shopify.fijarPoliticaInventario(productId, mapeo.shopifyVariantId, politica);
      hechos++;
      console.log(`  OK  ${etiqueta}`);
    } catch (e) {
      fallidos++;
      console.log(`  --  ${etiqueta}: ${(e as Error).message}`);
    }
  }
  if (aplicar) console.log(`\nActualizadas: ${hechos} · con error: ${fallidos}`);
}

principal().then(() => process.exit(0)).catch(alFallar);
