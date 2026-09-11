/**
 * src/jobs/confirmScheduler.ts
 * ============================
 * Confirmación automática de pedidos dentro del propio proceso.
 *
 * ¿Por qué aquí y no un cron aparte? Porque CT cancela solo cualquier pedido
 * que no se confirme en 48 h, y en un despliegue de un solo servicio —como el
 * plan inicial de Railway— no hay nadie corriendo `npm run confirm:orders` a
 * mano. Un temporizador interno resuelve eso sin agregar infraestructura.
 *
 * Se enciende con CONFIRM_INTERVAL_MINUTES. En 0 (el valor por omisión) no
 * corre: en local se prefiere el comando manual.
 *
 * Cuando el volumen lo justifique, esto se cambia por una cola real
 * (BullMQ/Redis) o por un servicio cron aparte, como dice la sección 13 del
 * ETS. No antes.
 */
import { env } from "../config/env";
import { repositorios } from "../data-source";
import { CtClient } from "../services/CtClient";
import { InventorySyncService } from "../services/InventorySyncService";
import { OrderService } from "../services/OrderService";
import { ShopifyClient } from "../services/ShopifyClient";

let temporizador: NodeJS.Timeout | null = null;
let corriendo = false;

async function unaPasada(): Promise<void> {
  // Si la pasada anterior no terminó, no se encima otra.
  if (corriendo) return;
  corriendo = true;
  try {
    const { ordenes, productos } = repositorios();
    const ct = new CtClient();
    const shopify = new ShopifyClient();
    const servicio = new OrderService(
      ct, shopify, ordenes, productos,
      new InventorySyncService(ct, shopify, productos)
    );

    const resumen = await servicio.confirmarPendientes();
    if (resumen.confirmados || resumen.fallidos || resumen.vencidos) {
      console.log(
        `[confirmacion] confirmados: ${resumen.confirmados} · ` +
          `fallidos: ${resumen.fallidos} · vencidos: ${resumen.vencidos}`
      );
    }
    if (resumen.porVencer.length) {
      console.error(
        "[confirmacion] PEDIDOS POR VENCER: " + resumen.porVencer.join(" | ")
      );
    }
  } catch (e) {
    // Falta de configuración o CT caído: se avisa y se intenta en la siguiente.
    console.error("[confirmacion] no se pudo correr:", (e as Error).message);
  } finally {
    corriendo = false;
  }
}

export function iniciarConfirmacionAutomatica(): boolean {
  const minutos = env.app.minutosConfirmacion;
  if (!minutos || minutos <= 0) return false;
  if (temporizador) return true;

  const ms = minutos * 60 * 1000;
  temporizador = setInterval(unaPasada, ms);
  // No mantiene el proceso vivo por sí solo.
  temporizador.unref?.();
  console.log(`Confirmación automática de pedidos cada ${minutos} min.`);
  return true;
}

export function detenerConfirmacionAutomatica(): void {
  if (temporizador) {
    clearInterval(temporizador);
    temporizador = null;
  }
}
