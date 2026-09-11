/**
 * src/routes/shopifyWebhooks.ts
 * =============================
 * RF-03. Recibe el aviso de Shopify cuando una orden ya es elegible.
 * Para el prototipo la orden elegible es la orden PAGADA (`orders/paid`).
 *
 * Dos cosas que no se negocian:
 *
 *   1. La firma se valida ANTES de leer el contenido. Se usa el mecanismo
 *      documentado por Shopify —HMAC-SHA256 del cuerpo crudo con el secreto
 *      del webhook, comparado en tiempo constante— sobre el body sin parsear.
 *      Si no coincide: 401 y nada más.
 *
 *   2. Se responde 200 de inmediato y el trabajo sigue en segundo plano.
 *      Shopify reintenta si tarda, y reintentar traduce en pedidos duplicados.
 *      La idempotencia real la da OrderMapping, no la respuesta HTTP.
 */
import crypto from "node:crypto";
import express, { Request, Response, Router } from "express";
import { env } from "../config/env";
import { repositorios } from "../data-source";
import { InventorySyncService } from "../services/InventorySyncService";
import { LineaOrden, OrdenShopify, OrderService } from "../services/OrderService";
import { ShopifyClient } from "../services/ShopifyClient";
import { crearClienteCt } from "../services/ctFactory";

/** Compara la firma del webhook en tiempo constante. */
export function firmaValida(cuerpoCrudo: Buffer, firmaRecibida: string, secreto: string): boolean {
  if (!firmaRecibida) return false;
  const esperada = crypto.createHmac("sha256", secreto).update(cuerpoCrudo).digest("base64");
  const a = Buffer.from(esperada, "utf8");
  const b = Buffer.from(firmaRecibida, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Reduce el payload de Shopify a lo que el middleware necesita.
 * Sólo se lee lo indispensable para identificar la orden y sus líneas.
 */
export function extraerOrden(payload: any): OrdenShopify {
  const lineas: LineaOrden[] = (payload?.line_items ?? []).map((l: any) => ({
    sku: l?.sku ?? null,
    variantId: l?.variant_id ? String(l.variant_id) : null,
    cantidad: Number(l?.quantity ?? 0),
    precio: Number(l?.price ?? 0),
    moneda: payload?.currency ?? "MXN",
  }));

  const direccion = payload?.shipping_address;
  const envio = direccion
    ? {
        nombre: [direccion.first_name, direccion.last_name].filter(Boolean).join(" ").trim(),
        direccion: direccion.address1 ?? "",
        entreCalles: " ",
        noExterior: String(direccion.address2 ?? "").trim() || " ",
        noInterior: " ",
        colonia: direccion.company ?? " ",
        estado: direccion.province ?? "",
        ciudad: direccion.city ?? "",
        codigoPostal: Number(String(direccion.zip ?? "").replace(/\D/g, "")) || 0,
        telefono: Number(String(direccion.phone ?? "").replace(/\D/g, "")) || 0,
      }
    : undefined;

  return {
    id: String(payload?.id ?? ""),
    name: payload?.name ?? null,
    lineas,
    envio,
  };
}

export function crearRutasWebhook(): Router {
  const router = Router();

  router.post(
    "/webhooks/shopify/orders-paid",
    // Cuerpo CRUDO: la firma se calcula sobre los bytes exactos que envió Shopify.
    express.raw({ type: "*/*", limit: "5mb" }),
    async (peticion: Request, respuesta: Response) => {
      const crudo = peticion.body as Buffer;
      const firma = String(peticion.header("X-Shopify-Hmac-Sha256") ?? "");

      let secreto: string;
      try {
        secreto = env.shopify.webhookSecret;
      } catch (e) {
        // Sin secreto configurado no se puede validar nada: se rechaza.
        respuesta.status(503).json({ error: (e as Error).message });
        return;
      }

      if (!Buffer.isBuffer(crudo) || !firmaValida(crudo, firma, secreto)) {
        respuesta.status(401).json({ error: "firma_invalida" });
        return;
      }

      let payload: any;
      try {
        payload = JSON.parse(crudo.toString("utf8"));
      } catch {
        respuesta.status(400).json({ error: "cuerpo_no_es_json" });
        return;
      }

      const orden = extraerOrden(payload);
      if (!orden.id) {
        respuesta.status(400).json({ error: "orden_sin_id" });
        return;
      }

      // Se acusa recibo YA. Shopify no debe esperar a CT.
      respuesta.status(200).json({ recibido: true, orden: orden.id });

      // Y el trabajo continúa aparte.
      procesarEnSegundoPlano(orden).catch((e) => {
        console.error(
          `[webhook] la orden ${orden.id} falló en segundo plano:`,
          (e as Error).message
        );
      });
    }
  );

  return router;
}

async function procesarEnSegundoPlano(orden: OrdenShopify): Promise<void> {
  const { ordenes, productos } = repositorios();
  const ct = crearClienteCt();
  const shopify = new ShopifyClient();
  const inventario = new InventorySyncService(ct, shopify, productos);
  const servicio = new OrderService(ct, shopify, ordenes, productos, inventario);

  const resultado = await servicio.procesar(orden);
  console.log(
    `[webhook] orden ${orden.id} -> estado ${resultado.registro.status}` +
      (resultado.registro.ctOrderId ? ` (CT ${resultado.registro.ctOrderId})` : "")
  );
}
