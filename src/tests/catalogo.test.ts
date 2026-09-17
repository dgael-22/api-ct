/**
 * src/tests/catalogo.test.ts
 * ==========================
 * Importación de productos de CT a Shopify, sin red ni base de datos:
 * CT simulado, Shopify falso y repositorio en memoria.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filtrarCatalogo, handleCt, normalizarProductoCt, precioVenta, type ProductoCt,
} from "../services/catalogoCt";
import { DetalleExistencia, ErrorCt } from "../services/CtClient";
import { CtSimulado } from "../services/CtSimulado";
import { CONFIRMADO_POR, ImportadorCt } from "../services/ImportadorCt";
import type { ShopifyClient } from "../services/ShopifyClient";

process.env.CT_ALMACEN = "01A";
process.env.SHOPIFY_LOCATION_ID = "gid://shopify/Location/1";

const reglas = { margenPct: 20, ivaPct: 16, precioIncluyeIva: false };

// ------------------------------------------------------------ normalizar ---

test("normalizar reconoce varios nombres de campo", () => {
  const p = normalizarProductoCt({
    codigo: "MON010", descripcion_corta: "Monitor 27", Marca: "Acme", Categoria: "Monitores",
    imagen: "https://a.com/1.png, https://a.com/2.png, no-es-url", upc: 123, precio: "1500.5", moneda: "mxn",
  });
  assert.ok(p);
  assert.equal(p.clave, "MON010");
  assert.equal(p.nombre, "Monitor 27");
  assert.equal(p.marca, "Acme");
  assert.equal(p.categoria, "Monitores");
  assert.deepEqual(p.imagenes, ["https://a.com/1.png", "https://a.com/2.png"]);
  assert.equal(p.codigoBarras, "123");
  assert.equal(p.precio, 1500.5);
  assert.equal(p.moneda, "MXN");
});

test("sin clave o sin nombre no hay producto", () => {
  assert.equal(normalizarProductoCt({ nombre: "Algo" }), null);
  assert.equal(normalizarProductoCt({ clave: "X1" }), null);
});

test("filtrar por categoría o subcategoría, marca y límite", () => {
  const base = (clave: string, categoria: string, subcategoria: string | null, marca: string) =>
    normalizarProductoCt({ clave, nombre: clave, categoria, subcategoria, marca }) as ProductoCt;
  const catalogo = [
    base("A", "Computadoras", "Laptops", "Acme"),
    base("B", "Computadoras", "Escritorio", "Otra"),
    base("C", "Monitores", null, "Acme"),
  ];
  assert.deepEqual(filtrarCatalogo(catalogo, { categorias: ["laptops"] }).map((p) => p.clave), ["A"]);
  assert.deepEqual(filtrarCatalogo(catalogo, { categorias: ["Computadoras"], marcas: ["ACME"] }).map((p) => p.clave), ["A"]);
  assert.deepEqual(filtrarCatalogo(catalogo, { limite: 2 }).map((p) => p.clave), ["A", "B"]);
  assert.equal(filtrarCatalogo(catalogo, {}).length, 3);
});

// --------------------------------------------------------------- precios ---

test("precio de venta: costo + margen + IVA, redondeado al peso", () => {
  assert.equal(precioVenta(1000, "MXN", null, reglas), 1392);
  // 100 USD × 17.5 × 1.20 × 1.16 = 2436
  assert.equal(precioVenta(100, "USD", 17.5, reglas), 2436);
  assert.equal(precioVenta(1000, "MXN", null, { ...reglas, precioIncluyeIva: true }), 1200);
  assert.equal(precioVenta(1000.01, "MXN", null, { margenPct: 0, ivaPct: 0, precioIncluyeIva: true }), 1001);
});

test("sin tipo de cambio o con moneda desconocida no hay precio", () => {
  assert.equal(precioVenta(100, "USD", null, reglas), null);
  assert.equal(precioVenta(100, "EUR", 20, reglas), null);
  assert.equal(precioVenta(0, "MXN", null, reglas), null);
});

test("el handle es estable y limpio", () => {
  assert.equal(handleCt("ACC-BLC/010 Ñ"), "ct-acc-blc-010-n");
});

// ------------------------------------------------------------ importador ---

class RepoFalso {
  filas: any[] = [];
  create(d: any) { return { ...d }; }
  async save(f: any) { if (!this.filas.includes(f)) this.filas.push(f); return f; }
  async findOne({ where }: { where: Record<string, unknown> }) {
    return this.filas.find((f) => Object.entries(where).every(([k, v]) => f[k] === v)) ?? null;
  }
}

function shopifyFalso() {
  const llamadas: { metodo: string; args: unknown[] }[] = [];
  let n = 0;
  const anotar = (metodo: string, valor: unknown) => async (...args: unknown[]) => {
    llamadas.push({ metodo, args });
    return typeof valor === "function" ? (valor as () => unknown)() : valor;
  };
  const cliente = {
    guardarProducto: anotar("guardarProducto", () => {
      n++;
      return {
        productId: `gid://shopify/Product/${n}`,
        variantId: `gid://shopify/ProductVariant/${100 + n}`,
        inventoryItemId: `gid://shopify/InventoryItem/${200 + n}`,
      };
    }),
    productoDeVariante: anotar("productoDeVariante", "gid://shopify/Product/1"),
    productoPorHandle: anotar("productoPorHandle", null),
    actualizarPrecio: anotar("actualizarPrecio", undefined),
    fijarInventario: anotar("fijarInventario", undefined),
  } as unknown as ShopifyClient;
  return { cliente, llamadas, de: (m: string) => llamadas.filter((l) => l.metodo === m) };
}

const producto = normalizarProductoCt({
  clave: "LAP001", nombre: "Laptop", marca: "Acme", categoria: "Computadoras",
  imagen: "https://a.com/l.png",
}) as ProductoCt;

test("importar en simulación no escribe nada", async () => {
  const shopify = shopifyFalso();
  const repo = new RepoFalso();
  const r = await new ImportadorCt(new CtSimulado("ok"), shopify.cliente, repo as any)
    .importar([producto], { aplicar: false, reglas });
  assert.equal(r[0].accion, "crear");
  assert.ok(r[0].precioVenta && r[0].precioVenta > 0);
  assert.equal(shopify.llamadas.length, 0);
  assert.equal(repo.filas.length, 0);
});

test("importar crea en borrador, fija existencia y deja el mapeo; la segunda vez sólo actualiza precio", async () => {
  const ct = new CtSimulado("ok");
  const [detalle] = await ct.detalle("LAP001", "01A");
  const shopify = shopifyFalso();
  const repo = new RepoFalso();
  const importador = new ImportadorCt(ct, shopify.cliente, repo as any);

  const [primera] = await importador.importar([producto], { aplicar: true, reglas });
  assert.equal(primera.accion, "crear");
  const entrada = shopify.de("guardarProducto")[0].args[0] as any;
  assert.equal(entrada.status, "DRAFT");
  assert.equal(entrada.handle, "ct-lap001");
  assert.equal(entrada.vendor, "Acme");
  assert.equal(entrada.variants[0].price, precioVenta(detalle.precio, detalle.moneda, detalle.tipoCambio, reglas)!.toFixed(2));
  assert.equal(entrada.variants[0].inventoryItem.sku, "LAP001");
  assert.equal(entrada.files[0].originalSource, "https://a.com/l.png");
  assert.equal(shopify.de("fijarInventario")[0].args[2], detalle.existencia - 1);

  assert.equal(repo.filas.length, 1);
  assert.equal(repo.filas[0].status, "confirmed");
  assert.equal(repo.filas[0].confirmedBy, CONFIRMADO_POR);
  assert.equal(repo.filas[0].shopifyVariantId, "101");

  const [segunda] = await importador.importar([producto], { aplicar: true, reglas });
  assert.equal(segunda.accion, "actualizar");
  assert.equal(shopify.de("guardarProducto").length, 1, "no se crea otro");
  assert.equal(shopify.de("actualizarPrecio").length, 1);
  assert.equal(repo.filas.length, 1, "no se duplica el mapeo");
});

test("una clave mapeada a un producto dado de alta a mano no se toca", async () => {
  const shopify = shopifyFalso();
  const repo = new RepoFalso();
  await repo.save({ shopifyVariantId: "9", shopifySku: "SCHU-1", ctSku: "LAP001", status: "confirmed", confirmedBy: "Diego" });
  const [r] = await new ImportadorCt(new CtSimulado("ok"), shopify.cliente, repo as any)
    .importar([producto], { aplicar: true, reglas });
  assert.equal(r.accion, "omitir");
  assert.equal(shopify.llamadas.length, 0);
});

test("si CT limita las consultas (429), la importación se detiene", async () => {
  let consultas = 0;
  const ct = new (class extends CtSimulado {
    override async detalle(): Promise<DetalleExistencia[]> {
      consultas++;
      throw new ErrorCt("CT respondió 429", 429, null, false);
    }
  })("ok");
  const otro = { ...producto, clave: "LAP002" };
  const r = await new ImportadorCt(ct, shopifyFalso().cliente, new RepoFalso() as any)
    .importar([producto, otro], { aplicar: false, reglas });
  assert.equal(consultas, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].accion, "error");
  assert.match(r[0].motivo ?? "", /1 pendientes/);
});
