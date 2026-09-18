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
import { ipCliente, registrarEvento } from "../services/bitacora";
import { InventorySyncService } from "../services/InventorySyncService";
import { EnvioCt } from "../services/CtClient";
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

  const envio = direccionDeEnvio(payload);

  return {
    id: String(payload?.id ?? ""),
    name: payload?.name ?? null,
    lineas,
    envio,
  };
}

/**
 * Dirección de envío de Shopify traducida a los campos de CT.
 *
 * CT no acepta campos vacíos cuando ellos generan la guía, y Shopify no tiene
 * "colonia" ni "entre calles". Mientras el checkout no capture la colonia:
 *   · calle y noExterior ← "Av. Juárez 1250" se parte en nombre y número
 *   · noInterior   ← la segunda línea si dice interior, depto, piso o casa
 *   · colonia      ← "Empresa", o la segunda línea si no es un interior
 *   · entreCalles y lo que falte de interior ← CT_RELLENO_ENVIO ("S/N")
 * Lo que de plano falte lo detiene OrderService con "envio_incompleto": es
 * mejor avisar que mandar a CT una dirección que no puede surtir.
 */
const ES_INTERIOR = /^(int\.?|interior|dep(to|artamento)\.?|piso|casa|local|of(ic)?\.?|edif)/i;

export function direccionDeEnvio(payload: any): EnvioCt | undefined {
  const d = payload?.shipping_address;
  if (!d) return undefined;

  const linea1 = String(d.address1 ?? "").trim();
  const linea2 = String(d.address2 ?? "").trim();
  const relleno = env.ct.rellenoEnvio;
  // "Av. Juárez 1250" -> calle "Av. Juárez", número "1250".
  const conNumero = linea1.match(/^(.*?)[\s#]*(\d+[A-Za-z]?)\s*$/);
  const calle = conNumero ? conNumero[1].trim() : linea1;

  const esInterior = ES_INTERIOR.test(linea2);
  // La segunda línea es el número exterior sólo si la calle no traía uno.
  const linea2EsExterior = !esInterior && /\d/.test(linea2) && !conNumero;
  const noExterior = conNumero?.[2] ?? (linea2EsExterior ? linea2 : "");
  const noInterior = esInterior ? linea2 : relleno;
  const colonia = String(d.company ?? "").trim() ||
    (esInterior || linea2EsExterior ? "" : linea2);

  return {
    nombre: [d.first_name, d.last_name].filter(Boolean).join(" ").trim(),
    direccion: calle,
    entreCalles: relleno,
    noExterior,
    noInterior,
    colonia,
    estado: String(d.province ?? "").trim(),
    ciudad: String(d.city ?? "").trim(),
    codigoPostal: Number(String(d.zip ?? "").replace(/\D/g, "")) || 0,
    telefono: Number(String(d.phone ?? "").replace(/\D/g, "")) || 0,
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
        void registrarEvento({
          nivel: "aviso", tipo: "webhook_firma_invalida",
          mensaje: `Webhook con firma inválida desde ${ipCliente(peticion)}`,
        });
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
      void registrarEvento({
        tipo: "webhook_recibido", shopifyOrderId: orden.id,
        mensaje: `Orden pagada ${orden.name ?? orden.id} con ${orden.lineas.length} línea(s)`,
      });

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
