/**
 * src/app.ts
 * ==========
 * Servidor Express 5 del middleware. Arranca SIN configuración y SIN datos:
 * `GET /health` responde 200 siempre, y dice qué credenciales faltan. Cada
 * endpoint que de verdad necesita una credencial falla solo, con el nombre de
 * la variable que hay que llenar.
 *
 * Rutas:
 *   GET  /health                              vivo + qué está configurado
 *   GET  /mappings                            mapeos guardados
 *   POST /mappings                            alta/confirmación de un mapeo
 *   POST /inventory/sync                      RF-02: CT -> Shopify
 *   GET  /orders                              órdenes y su relación con CT
 *   GET  /orders/:shopifyOrderId              una orden
 *   POST /orders/confirm                      confirma en CT los pendientes
 *   POST /orders/:shopifyOrderId/retry        reprocesa una orden "blocked"
 *   GET  /bitacora?orden=&tipo=&nivel=&limit=  eventos guardados en la base
 *   POST /webhooks/shopify/orders-paid        RF-03: la orden pagada
 *
 * /mappings, /inventory, /orders y /bitacora piden la cabecera x-api-key (ADMIN_API_KEY).
 * /health y el webhook no: el primero no expone datos y el segundo valida HMAC.
 */
import express, { NextFunction, Request, Response } from "express";
import { env, estaDefinida, FaltaConfiguracion } from "./config/env";
import { esPostgres, inicializarBd, repositorios } from "./data-source";
import { iniciarConfirmacionAutomatica } from "./jobs/confirmScheduler";
import { requerirClaveAdmin } from "./middleware/autenticacion";
import { depurarBitacora, registrarEvento } from "./services/bitacora";
import { normalizarVariante } from "./entities/ProductMapping";
import { crearRutasWebhook } from "./routes/shopifyWebhooks";
import { InventorySyncService } from "./services/InventorySyncService";
import { OrderService } from "./services/OrderService";
import { ShopifyClient } from "./services/ShopifyClient";
import { advertirSiSimulado, crearClienteCt } from "./services/ctFactory";

export const app = express();

// El webhook necesita el cuerpo crudo, así que se monta ANTES del json().
app.use(crearRutasWebhook());
app.use(express.json({ limit: "2mb" }));

// Endpoints de gestión: sólo con la clave de administración.
app.use(["/mappings", "/inventory", "/orders", "/bitacora"], requerirClaveAdmin);

// ------------------------------------------------------------------ health ---

app.get("/health", (_peticion: Request, respuesta: Response) => {
  const configuracion = {
    shopify: {
      dominio: estaDefinida("SHOPIFY_SHOP_DOMAIN"),
      // Dos caminos válidos: token fijo de una app vieja, o client
      // credentials del Dev Dashboard (token de 24 h que se renueva solo).
      credenciales:
        estaDefinida("SHOPIFY_ACCESS_TOKEN") ||
        (estaDefinida("SHOPIFY_CLIENT_ID") && estaDefinida("SHOPIFY_CLIENT_SECRET")),
      tipoDeToken: estaDefinida("SHOPIFY_ACCESS_TOKEN")
        ? "fijo (app del admin)"
        : "client credentials (24 h)",
      webhookSecret: estaDefinida("SHOPIFY_WEBHOOK_SECRET"),
      locationId: estaDefinida("SHOPIFY_LOCATION_ID"),
    },
    ct: {
      modo: env.ct.modo,
      simulado: env.ct.modo === "simulado",
      escenarioSimulado: env.ct.modo === "simulado" ? env.ct.escenarioSimulado : undefined,
      baseUrl: env.ct.baseUrl,
      credenciales:
        estaDefinida("CT_ACCESS_TOKEN") ||
        (estaDefinida("CT_EMAIL") && estaDefinida("CT_CLIENTE") && estaDefinida("CT_RFC")),
      almacen: estaDefinida("CT_ALMACEN"),
      // Sale por el proxy de IP fija cuando hay clave de proxy.
      proxy: estaDefinida("CT_PROXY_KEY"),
    },
    seguridad: { claveAdmin: estaDefinida("ADMIN_API_KEY") },
    baseDeDatos: esPostgres() ? "postgres" : "sqlite",
    urlPublica: env.app.baseUrl || "(sin definir)",
    confirmacionAutomaticaMin: env.app.minutosConfirmacion,
  };

  // En modo simulado las credenciales de CT no hacen falta: no se usan.
  const requeridas = env.ct.modo === "simulado"
    ? ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_WEBHOOK_SECRET", "SHOPIFY_LOCATION_ID",
       "CT_ALMACEN", "ADMIN_API_KEY"]
    : ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_WEBHOOK_SECRET", "SHOPIFY_LOCATION_ID",
       "CT_EMAIL", "CT_CLIENTE", "CT_RFC", "CT_ALMACEN", "ADMIN_API_KEY"];
  const faltantes = requeridas.filter((v) => !estaDefinida(v));

  // El token de Shopify se resuelve por cualquiera de los dos caminos.
  if (!configuracion.shopify.credenciales) {
    faltantes.push("SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (o SHOPIFY_ACCESS_TOKEN)");
  }

  respuesta.json({
    ok: true,
    servicio: "schu-ct-middleware",
    hora: new Date().toISOString(),
    configuracion,
    faltantes,
    listoParaOperar: faltantes.length === 0,
  });
});

// ---------------------------------------------------------------- mappings ---

app.get("/mappings", async (peticion: Request, respuesta: Response) => {
  const { productos } = repositorios();
  const estado = peticion.query.status as string | undefined;
  const mapeos = await productos.find({
    where: estado ? { status: estado as never } : {},
    take: Number(peticion.query.limit ?? 100),
    order: { id: "ASC" },
  });
  respuesta.json({ total: mapeos.length, mappings: mapeos });
});

/**
 * RF-01. Alta o confirmación de un mapeo. Confirmar es un acto explícito:
 * hay que mandar status "confirmed" y quién lo confirma. Nunca es automático.
 */
app.post("/mappings", async (peticion: Request, respuesta: Response) => {
  const { productos } = repositorios();
  const cuerpo = peticion.body ?? {};

  // El SKU de Shopify es opcional: hay artículos dados de alta sin él y el
  // pedido busca el mapeo por variante.
  if (!cuerpo.shopifyVariantId || !cuerpo.ctSku) {
    respuesta.status(400).json({
      error: "faltan_campos",
      requeridos: ["shopifyVariantId", "ctSku"],
    });
    return;
  }
  if (cuerpo.status === "confirmed" && !cuerpo.confirmedBy) {
    respuesta.status(400).json({
      error: "confirmacion_sin_responsable",
      detalle: "Para confirmar un mapeo hay que decir quién lo confirma.",
    });
    return;
  }

  const variante = normalizarVariante(cuerpo.shopifyVariantId);
  const existente = await productos.findOne({ where: { shopifyVariantId: variante } });
  const mapeo = existente ?? productos.create({
    shopifyVariantId: variante,
    shopifySku: String(cuerpo.shopifySku ?? ""),
    ctSku: String(cuerpo.ctSku),
  });

  mapeo.shopifySku = String(cuerpo.shopifySku ?? mapeo.shopifySku ?? "");
  mapeo.ctSku = String(cuerpo.ctSku);
  mapeo.ctProductId = cuerpo.ctProductId ? String(cuerpo.ctProductId) : mapeo.ctProductId ?? null;
  mapeo.partNumber = cuerpo.partNumber ? String(cuerpo.partNumber) : mapeo.partNumber ?? null;
  mapeo.inventoryItemId = cuerpo.inventoryItemId
    ? String(cuerpo.inventoryItemId)
    : mapeo.inventoryItemId ?? null;
  mapeo.locationId = cuerpo.locationId ? String(cuerpo.locationId) : mapeo.locationId ?? null;
  mapeo.status = (cuerpo.status ?? mapeo.status ?? "pending") as never;
  mapeo.reason = cuerpo.reason ? String(cuerpo.reason) : mapeo.reason ?? null;
  mapeo.confirmedBy = cuerpo.confirmedBy ? String(cuerpo.confirmedBy) : mapeo.confirmedBy ?? null;

  await productos.save(mapeo);
  respuesta.status(existente ? 200 : 201).json(mapeo);
});

// --------------------------------------------------------------- inventario ---

/** RF-02. Copia a Shopify la disponibilidad que reporta CT. */
app.post("/inventory/sync", async (peticion: Request, respuesta: Response, siguiente: NextFunction) => {
  try {
    const { productos } = repositorios();
    const servicio = new InventorySyncService(crearClienteCt(), new ShopifyClient(), productos);
    const limite = peticion.body?.limit ? Number(peticion.body.limit) : undefined;
    const resultados = await servicio.sincronizarConfirmados(limite);
    respuesta.json({
      revisados: resultados.length,
      actualizados: resultados.filter((r) => r.actualizado).length,
      resultados,
    });
  } catch (e) {
    siguiente(e);
  }
});

// ------------------------------------------------------------------ ordenes ---

app.get("/orders", async (peticion: Request, respuesta: Response) => {
  const { ordenes } = repositorios();
  const estado = peticion.query.status as string | undefined;
  const registros = await ordenes.find({
    where: estado ? { status: estado as never } : {},
    take: Number(peticion.query.limit ?? 50),
    order: { id: "DESC" },
  });
  respuesta.json({ total: registros.length, orders: registros });
});

/**
 * Segundo paso del pedido de CT: confirmar. CT cancela solo lo que no se
 * confirma dentro de su ventana, así que esto también corre como comando
 * programado (`npm run confirm:orders`).
 */
app.post("/orders/confirm", async (_peticion: Request, respuesta: Response, siguiente: NextFunction) => {
  try {
    const { ordenes, productos } = repositorios();
    const ct = crearClienteCt();
    const shopify = new ShopifyClient();
    const servicio = new OrderService(
      ct, shopify, ordenes, productos,
      new InventorySyncService(ct, shopify, productos)
    );
    respuesta.json(await servicio.confirmarPendientes());
  } catch (e) {
    siguiente(e);
  }
});

/**
 * Reprocesa una orden "blocked" (sin mapeo, sin precio o sin conexión con CT)
 * con las líneas que se guardaron al recibirla. Es manual a propósito: entre
 * el bloqueo y el reintento alguien pudo haberla surtido por otro lado.
 */
app.post("/orders/:shopifyOrderId/retry", async (peticion: Request, respuesta: Response, siguiente: NextFunction) => {
  try {
    const { ordenes, productos } = repositorios();
    const ct = crearClienteCt();
    const shopify = new ShopifyClient();
    const servicio = new OrderService(
      ct, shopify, ordenes, productos,
      new InventorySyncService(ct, shopify, productos)
    );
    const resultado = await servicio.reintentar(String(peticion.params.shopifyOrderId));
    if ("error" in resultado) {
      respuesta.status(resultado.error === "orden_no_registrada" ? 404 : 409).json(resultado);
      return;
    }
    respuesta.json(resultado.registro);
  } catch (e) {
    siguiente(e);
  }
});

app.get("/orders/:shopifyOrderId", async (peticion: Request, respuesta: Response) => {
  const { ordenes } = repositorios();
  const registro = await ordenes.findOne({
    where: { shopifyOrderId: String(peticion.params.shopifyOrderId) },
  });
  if (!registro) {
    respuesta.status(404).json({ error: "orden_no_registrada" });
    return;
  }
  respuesta.json(registro);
});

// ----------------------------------------------------------------- bitácora ---

/** Lo más reciente primero. Filtros opcionales: orden, tipo, nivel. */
app.get("/bitacora", async (peticion: Request, respuesta: Response) => {
  const { eventos } = repositorios();
  const filtro: Record<string, string> = {};
  if (peticion.query.orden) filtro.shopifyOrderId = String(peticion.query.orden);
  if (peticion.query.tipo) filtro.tipo = String(peticion.query.tipo);
  if (peticion.query.nivel) filtro.nivel = String(peticion.query.nivel);
  const limite = Math.min(Math.max(Number(peticion.query.limit ?? 100) || 100, 1), 500);
  const registros = await eventos.find({
    where: filtro as never,
    take: limite,
    order: { id: "DESC" },
  });
  respuesta.json({ total: registros.length, eventos: registros });
});

// ------------------------------------------------------------------ errores ---

app.use((error: Error, peticion: Request, respuesta: Response, _siguiente: NextFunction) => {
  // Falta configuración: es un 503, no un error del cliente.
  if (error instanceof FaltaConfiguracion) {
    respuesta.status(503).json({ error: "falta_configuracion", variable: error.variable, detalle: error.message });
    return;
  }
  console.error("[error]", error.message);
  void registrarEvento({
    nivel: "error", tipo: "error_interno",
    mensaje: `${peticion.method} ${peticion.originalUrl.split("?")[0]}: ${error.message}`,
  });
  respuesta.status(500).json({ error: error.name || "error_interno", detalle: error.message });
});

// ------------------------------------------------------------------ arranque ---

export async function arrancar(): Promise<void> {
  await inicializarBd();

  // Escucha en 0.0.0.0 porque en un contenedor (Railway) el tráfico no llega
  // por loopback. En local es equivalente a localhost.
  app.listen(env.app.puerto, "0.0.0.0", () => {
    const publica = env.app.baseUrl || `http://localhost:${env.app.puerto}`;
    console.log(`Middleware escuchando en el puerto ${env.app.puerto}`);
    console.log(`Comprueba con:  curl ${publica}/health`);
    if (env.app.baseUrl) {
      console.log(`Webhook para Shopify:  ${publica}/webhooks/shopify/orders-paid`);
    }
    iniciarConfirmacionAutomatica();
    advertirSiSimulado();
    void registrarEvento({ tipo: "arranque", mensaje: `Servicio iniciado (CT ${env.ct.modo})` });
  });

  // Limpieza diaria de la bitácora (BITACORA_DIAS, 365 por defecto).
  const depurar = () => depurarBitacora(env.app.diasBitacora)
    .then((n) => { if (n) console.log(`[bitacora] ${n} eventos viejos borrados`); })
    .catch((e) => console.error("[bitacora] no se pudo depurar:", (e as Error).message));
  void depurar();
  setInterval(depurar, 24 * 60 * 60 * 1000).unref?.();
}

if (require.main === module) {
  arrancar().catch((e) => {
    console.error("No se pudo arrancar:", (e as Error).message);
    process.exit(1);
  });
}
