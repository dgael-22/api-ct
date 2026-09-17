/**
 * src/jobs/inventoryScheduler.ts
 * ==============================
 * RF-02 programado: copia a Shopify la existencia de CT de todos los mapeos
 * confirmados, cada INVENTORY_SYNC_MINUTES (0 = apagado, el valor por omisión).
 *
 * Una consulta a CT por producto, separadas por CT_PAUSA_MS para no rebasar su
 * límite. Si CT contesta 429, la pasada se corta y se intenta en la siguiente.
 */
import { env } from "../config/env";
import { repositorios } from "../data-source";
import { registrarEvento } from "../services/bitacora";
import { InventorySyncService } from "../services/InventorySyncService";
import { ShopifyClient } from "../services/ShopifyClient";
import { crearClienteCt } from "../services/ctFactory";

let temporizador: NodeJS.Timeout | null = null;
let corriendo = false;

async function unaPasada(): Promise<void> {
  // Con muchos productos una pasada puede durar más que el intervalo.
  if (corriendo) return;
  corriendo = true;
  try {
    const { productos } = repositorios();
    const servicio = new InventorySyncService(crearClienteCt(), new ShopifyClient(), productos);
    const resultados = await servicio.sincronizarConfirmados(undefined, env.ct.pausaMs);
    if (resultados.length === 0) return;

    const actualizados = resultados.filter((r) => r.actualizado).length;
    const conProblema = resultados.filter((r) => !r.actualizado);
    await registrarEvento({
      nivel: conProblema.length ? "aviso" : "info",
      tipo: "inventario_sincronizado",
      mensaje: `Existencias: ${actualizados} de ${resultados.length} actualizadas`,
      detalle: conProblema.length
        ? conProblema.slice(0, 20).map((r) => `${r.ctSku}: ${r.motivo}`)
        : null,
    });
  } catch (e) {
    console.error("[inventario] no se pudo correr:", (e as Error).message);
    await registrarEvento({
      nivel: "error", tipo: "inventario_no_corrio", mensaje: (e as Error).message,
    });
  } finally {
    corriendo = false;
  }
}

export function iniciarSincronizacionInventario(): boolean {
  const minutos = env.app.minutosInventario;
  if (!minutos || minutos <= 0) return false;
  if (temporizador) return true;

  temporizador = setInterval(unaPasada, minutos * 60 * 1000);
  temporizador.unref?.();
  console.log(`Sincronización de existencias cada ${minutos} min.`);
  return true;
}
