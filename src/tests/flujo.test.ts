/**
 * src/tests/flujo.test.ts
 * =======================
 * El flujo del pedido y los endpoints protegidos, sin red, sin base de datos y
 * sin CT: repositorios en memoria y el CT simulado.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";

import { requerirClaveAdmin } from "../middleware/autenticacion";
import { extraerOrden, firmaValida } from "../routes/shopifyWebhooks";
import { ErrorCt, PedidoCt, RespuestaPedidoCt } from "../services/CtClient";
import { CtSimulado, Escenario } from "../services/CtSimulado";
import { crearClienteCt, reiniciarClienteCt } from "../services/ctFactory";
import { OrdenShopify, OrderService } from "../services/OrderService";
import type { ShopifyClient } from "../services/ShopifyClient";

process.env.CT_ALMACEN = "01A";
process.env.CT_MODO = "simulado";
process.env.CT_SIMULADO_ESCENARIO = "ok";

// ------------------------------------------------------------ utilidades ---

/** Lo mínimo de un Repository de TypeORM que usan los servicios. */
class RepoFalso<T extends { id?: number }> {
  filas: T[] = [];
  private siguiente = 1;
  create(datos: Partial<T>): T {
    return { confirmAttempts: 0, ...datos } as unknown as T;
  }
  async save(fila: T): Promise<T> {
    if (!fila.id) {
      fila.id = this.siguiente++;
      this.filas.push(fila);
    }
    return fila;
  }
  private coincide(fila: T, where: Record<string, unknown> = {}): boolean {
    return Object.entries(where).every(([k, v]) => (fila as Record<string, unknown>)[k] === v);
  }
  async findOne({ where }: { where: Record<string, unknown> }): Promise<T | null> {
    return this.filas.find((f) => this.coincide(f, where)) ?? null;
  }
  async find(opciones: { where?: Record<string, unknown> } = {}): Promise<T[]> {
    return this.filas.filter((f) => this.coincide(f, opciones.where));
  }
}

const avisosShopify: string[] = [];
const shopify = {
  registrarResultadoEnOrden: async (_id: string, _folio: string | null, estado: string) => {
    avisosShopify.push(estado);
  },
} as unknown as ShopifyClient;

function montar(ct: CtSimulado) {
  const ordenes = new RepoFalso<any>();
  const mapeos = new RepoFalso<any>();
  const servicio = new OrderService(ct, shopify, ordenes as any, mapeos as any);
  return { ordenes, mapeos, servicio };
}

async function confirmarMapeo(mapeos: RepoFalso<any>, sku = "SKU-1"): Promise<void> {
  await mapeos.save(mapeos.create({ shopifySku: sku, ctSku: `CT-${sku}`, status: "confirmed" }));
}

const orden = (id: string, sku = "SKU-1"): OrdenShopify => ({
  id, name: `#${id}`,
  lineas: [{ sku, variantId: "1", cantidad: 1, precio: 100, moneda: "MXN" }],
});

/** CT simulado cuyo crearPedido falla con el error que se le indique. */
class CtQueFalla extends CtSimulado {
  constructor(private readonly error: ErrorCt) { super("ok" as Escenario); }
  override async crearPedido(_p: PedidoCt): Promise<RespuestaPedidoCt> { throw this.error; }
}

// ------------------------------------------------------------- webhook ---

test("la firma del webhook se valida contra el cuerpo crudo", () => {
  const cuerpo = Buffer.from('{"id":1}');
  const firma = crypto.createHmac("sha256", "secreto").update(cuerpo).digest("base64");
  assert.equal(firmaValida(cuerpo, firma, "secreto"), true);
  assert.equal(firmaValida(Buffer.from('{"id":2}'), firma, "secreto"), false);
  assert.equal(firmaValida(cuerpo, "", "secreto"), false);
});

test("extraerOrden reduce el payload a lo necesario", () => {
  const o = extraerOrden({ id: 55, name: "#1001", currency: "MXN",
    line_items: [{ sku: "A1", variant_id: 9, quantity: 2, price: "10.50" }] });
  assert.equal(o.id, "55");
  assert.deepEqual(o.lineas[0], { sku: "A1", variantId: "9", cantidad: 2, precio: 10.5, moneda: "MXN" });
});

// ---------------------------------------------------------- las detenciones ---

test("camino feliz: se crea, se confirma y no se duplica", async () => {
  const ct = new CtSimulado("ok");
  const { mapeos, servicio } = montar(ct);
  await confirmarMapeo(mapeos);

  const r = await servicio.procesar(orden("1001"));
  assert.equal(r.registro.status, "accepted");
  assert.match(r.registro.ctOrderId ?? "", /^W01-/);

  const otra = await servicio.procesar(orden("1001"));
  assert.equal(otra.registro.status, "accepted");
  assert.equal((await ct.listarPedidos() as unknown[]).length, 1, "la misma orden no crea dos pedidos");
});

test("detención 1: sin mapeo queda 'blocked' con motivo, y se reintenta al confirmarlo", async () => {
  const ct = new CtSimulado("ok");
  const { mapeos, servicio, ordenes } = montar(ct);

  const r = await servicio.procesar(orden("2001"));
  assert.equal(r.registro.status, "blocked");
  assert.equal(r.registro.ctStatus, "mapeo_no_confirmado");
  assert.match(r.registro.lastResponse ?? "", /SKU-1/);
  assert.equal(ordenes.filas.length, 1, "la orden quedó registrada");
  assert.ok(avisosShopify.includes("mapeo_no_confirmado"), "se avisó en Shopify");
  assert.equal((await ct.listarPedidos() as unknown[]).length, 0, "no llegó nada a CT");

  await confirmarMapeo(mapeos);
  const reintento = await servicio.procesar(orden("2001"));
  assert.equal(reintento.registro.status, "accepted");
});

test("detención 2: rechazo y sin existencia quedan 'rejected'", async () => {
  for (const escenario of ["rechazo", "sin_stock"] as Escenario[]) {
    const { mapeos, servicio } = montar(new CtSimulado(escenario));
    await confirmarMapeo(mapeos);
    const r = await servicio.procesar(orden(`3${escenario.length}`));
    assert.equal(r.registro.status, "rejected", escenario);
  }
});

test("detención 3: caída de red queda 'uncertain'", async () => {
  const { mapeos, servicio } = montar(new CtSimulado("caida"));
  await confirmarMapeo(mapeos);
  const r = await servicio.procesar(orden("4001"));
  assert.equal(r.registro.status, "uncertain");
});

test("detención 3: un 5xx al crear el pedido queda 'uncertain', no 'rejected'", async () => {
  const ct = new CtQueFalla(new ErrorCt("CT respondió 504 en POST /pedido", 504, null, true));
  const { mapeos, servicio } = montar(ct);
  await confirmarMapeo(mapeos);
  const r = await servicio.procesar(orden("5001"));
  assert.equal(r.registro.status, "uncertain");
});

test("sin token la petición no salió: queda 'blocked', no 'uncertain'", async () => {
  const ct = new CtQueFalla(new ErrorCt("No se obtuvo token de CT", 0, null, true, true));
  const { mapeos, servicio } = montar(ct);
  await confirmarMapeo(mapeos);
  const r = await servicio.procesar(orden("6001"));
  assert.equal(r.registro.status, "blocked");
  assert.equal(r.registro.ctStatus, "ct_sin_conexion");
});

// ------------------------------------------------------------ ctFactory ---

test("el CT simulado es uno por proceso: el job encuentra el folio del webhook", async () => {
  reiniciarClienteCt();
  const delWebhook = crearClienteCt();
  const delJob = crearClienteCt();
  assert.equal(delWebhook, delJob);

  const creado = await delWebhook.crearPedido({
    idPedido: 7001, almacen: "01A", tipoPago: "99", cfdi: "G01", envio: [],
    producto: [{ cantidad: 1, clave: "CT-X", precio: 1, moneda: "MXN" }],
  });
  const confirmado = await delJob.confirmarPedido(creado.respuestaCT.pedidoWeb);
  assert.equal(confirmado.okCode, "2000");
  reiniciarClienteCt();
});

// ------------------------------------------------------------ autenticación ---

test("los endpoints de gestión piden la clave y fallan cerrados sin configuración", async () => {
  const app = express();
  app.use("/orders", requerirClaveAdmin);
  app.get("/orders", (_q, r) => { r.json({ ok: true }); });
  const servidor = app.listen(0);
  const { port } = servidor.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/orders`;
  const anterior = process.env.ADMIN_API_KEY;

  try {
    process.env.ADMIN_API_KEY = "clave-de-prueba-123";
    assert.equal((await fetch(url)).status, 401, "sin clave");
    assert.equal((await fetch(url, { headers: { "x-api-key": "otra" } })).status, 401, "clave equivocada");
    assert.equal((await fetch(url, { headers: { "x-api-key": "clave-de-prueba-123" } })).status, 200);
    assert.equal((await fetch(url, { headers: { authorization: "Bearer clave-de-prueba-123" } })).status, 200);

    delete process.env.ADMIN_API_KEY;
    assert.equal((await fetch(url, { headers: { "x-api-key": "clave-de-prueba-123" } })).status, 503,
      "sin ADMIN_API_KEY no se abre nada");
  } finally {
    if (anterior === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = anterior;
    servidor.close();
  }
});
