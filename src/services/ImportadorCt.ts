/**
 * src/services/ImportadorCt.ts
 * ============================
 * Importa productos del catálogo de CT a Shopify, para venderlos sin tenerlos
 * en inventario (dropshipping), como ofrece CT Connect.
 *
 * Por cada artículo:
 *   1. Pregunta a CT precio, moneda y existencia (/existencia/detalle).
 *   2. Calcula el precio de venta (costo + margen + IVA, en pesos).
 *   3. Si no existe, lo crea en Shopify como BORRADOR, con imágenes, marca y
 *      categoría. Si ya lo había creado este importador, sólo actualiza precio
 *      y costo: el título y la descripción que alguien haya editado se respetan.
 *   4. Fija la existencia y deja el mapeo confirmado.
 *
 * Tres reglas:
 *   · Sin `aplicar` no escribe nada: sólo consulta a CT y reporta.
 *   · Nunca publica: los productos nacen en borrador y una persona los activa.
 *   · Una clave que ya está mapeada a un producto dado de alta a mano no se
 *     toca: ni se duplica ni se cambia el precio que SCHU le puso.
 *
 * El mapeo nace confirmado porque el producto se creó a partir de la propia
 * ficha de CT: no hay dos artículos que puedan no ser el mismo, que es el
 * riesgo que la confirmación manual existe para evitar.
 */
import { Repository } from "typeorm";
import { env } from "../config/env";
import { normalizarVariante, ProductMapping } from "../entities/ProductMapping";
import { registrarEvento } from "./bitacora";
import {
  descripcionHtml, handleCt, precioVenta, ProductoCt, ReglasPrecio, reglasPrecio, tagsCt,
} from "./catalogoCt";
import { ClienteCt, ErrorCt } from "./CtClient";
import { margenSeguridad } from "./InventorySyncService";
import { ShopifyClient } from "./ShopifyClient";

export const CONFIRMADO_POR = "importacion-ct";

export interface ResultadoImportacion {
  clave: string;
  nombre: string;
  accion: "crear" | "actualizar" | "omitir" | "error";
  costo: number | null;
  moneda: string | null;
  precioVenta: number | null;
  existencia: number | null;
  cantidadPublicada: number | null;
  productId?: string;
  motivo?: string;
}

export interface OpcionesImportacion {
  aplicar: boolean;
  pausaMs?: number;
  reglas?: ReglasPrecio;
}

export class ImportadorCt {
  constructor(
    private readonly ct: ClienteCt,
    private readonly shopify: ShopifyClient,
    private readonly mapeos: Repository<ProductMapping>
  ) {}

  async importar(productos: ProductoCt[], opciones: OpcionesImportacion): Promise<ResultadoImportacion[]> {
    const reglas = opciones.reglas ?? reglasPrecio();
    const resultados: ResultadoImportacion[] = [];

    for (const [i, producto] of productos.entries()) {
      if (i > 0 && opciones.pausaMs) await new Promise((r) => setTimeout(r, opciones.pausaMs));
      try {
        resultados.push(await this.uno(producto, opciones.aplicar, reglas));
      } catch (e) {
        resultados.push({
          ...vacio(producto), accion: "error", motivo: (e as Error).message,
        });
        // Con CT limitando o sin conexión, seguir sólo acumula errores.
        if (e instanceof ErrorCt && (e.httpStatus === 429 || e.sinEnviar)) {
          resultados[resultados.length - 1].motivo +=
            ` · se detuvo la importación (${productos.length - i - 1} pendientes)`;
          break;
        }
      }
    }

    if (opciones.aplicar) {
      const cuenta = (a: string) => resultados.filter((r) => r.accion === a).length;
      await registrarEvento({
        nivel: cuenta("error") ? "aviso" : "info",
        tipo: "catalogo_importado",
        mensaje: `Catálogo CT: ${cuenta("crear")} creados, ${cuenta("actualizar")} actualizados, ` +
          `${cuenta("omitir")} omitidos, ${cuenta("error")} con error`,
        detalle: resultados.filter((r) => r.accion === "error" || r.accion === "omitir")
          .slice(0, 30).map((r) => `${r.clave}: ${r.motivo}`),
      });
    }
    return resultados;
  }

  private async uno(p: ProductoCt, aplicar: boolean, reglas: ReglasPrecio): Promise<ResultadoImportacion> {
    const base = vacio(p);

    // Una clave mapeada a mano pertenece a un producto que SCHU ya maneja.
    const mapeo = await this.mapeos.findOne({ where: { ctSku: p.clave } });
    if (mapeo && mapeo.confirmedBy !== CONFIRMADO_POR) {
      return {
        ...base, accion: "omitir",
        motivo: "La clave ya está mapeada a un producto dado de alta en la tienda; no se duplica ni se cambia su precio.",
      };
    }

    const [detalle] = await this.ct.detalle(p.clave, env.ct.almacen);
    if (!detalle) {
      return { ...base, accion: "omitir", motivo: `CT no reporta la clave en el almacén ${env.ct.almacen}.` };
    }
    const costo = Number(detalle.precio);
    const moneda = String(detalle.moneda ?? "").toUpperCase();
    const venta = precioVenta(costo, moneda, Number(detalle.tipoCambio) || null, reglas);
    const existencia = Math.max(0, Number(detalle.existencia) || 0);
    const publicada = Math.max(0, existencia - margenSeguridad());
    const conPrecio = { ...base, costo, moneda, precioVenta: venta, existencia, cantidadPublicada: publicada };

    if (venta === null) {
      return { ...conPrecio, accion: "omitir", motivo: `No se pudo calcular el precio (${costo} ${moneda}).` };
    }
    const costoMxn = moneda === "USD" ? costo * Number(detalle.tipoCambio) : costo;

    if (!aplicar) {
      return { ...conPrecio, accion: mapeo ? "actualizar" : "crear", motivo: "simulación: no se escribió nada" };
    }

    const handle = handleCt(p.clave);
    let ids: { productId: string; variantId: string; inventoryItemId: string } | null = null;

    if (mapeo) {
      const productId = await this.shopify.productoDeVariante(mapeo.shopifyVariantId);
      if (productId && mapeo.inventoryItemId) {
        ids = { productId, variantId: mapeo.shopifyVariantId, inventoryItemId: mapeo.inventoryItemId };
      }
    }
    // Sin mapeo local pero creado antes (otra base, prueba borrada): se reconoce por handle.
    ids = ids ?? await this.shopify.productoPorHandle(handle);

    let accion: "crear" | "actualizar";
    if (ids) {
      accion = "actualizar";
      await this.shopify.actualizarPrecio(ids.productId, ids.variantId, venta, costoMxn);
    } else {
      accion = "crear";
      ids = await this.shopify.guardarProducto(this.entradaNueva(p, handle, venta, costoMxn));
    }

    await this.shopify.fijarInventario(ids.inventoryItemId, env.shopify.locationId, publicada);
    await this.guardarMapeo(p, ids, mapeo);
    return { ...conPrecio, accion, productId: ids.productId };
  }

  private entradaNueva(p: ProductoCt, handle: string, precio: number, costo: number): Record<string, unknown> {
    return {
      title: p.nombre,
      handle,
      descriptionHtml: descripcionHtml(p),
      vendor: p.marca ?? "CT",
      productType: p.subcategoria ?? p.categoria ?? "",
      status: "DRAFT",
      tags: tagsCt(p),
      productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
      variants: [{
        optionValues: [{ optionName: "Title", name: "Default Title" }],
        price: precio.toFixed(2),
        // CONTINUE = se sigue vendiendo en cero (SHOPIFY_VENDER_SIN_STOCK).
        inventoryPolicy: env.shopify.venderSinStock ? "CONTINUE" : "DENY",
        barcode: p.codigoBarras ?? undefined,
        inventoryItem: { sku: p.clave, tracked: true, cost: costo.toFixed(2) },
      }],
      metafields: [{
        namespace: "custom", key: "ct_clave", type: "single_line_text_field", value: p.clave,
      }],
      files: p.imagenes.slice(0, 10).map((url) => ({
        originalSource: url, contentType: "IMAGE", alt: p.nombre,
      })),
    };
  }

  private async guardarMapeo(
    p: ProductoCt,
    ids: { variantId: string; inventoryItemId: string },
    existente: ProductMapping | null
  ): Promise<void> {
    const variante = normalizarVariante(ids.variantId);
    const mapeo = existente
      ?? await this.mapeos.findOne({ where: { shopifyVariantId: variante } })
      ?? this.mapeos.create({ shopifyVariantId: variante, shopifySku: p.clave, ctSku: p.clave });
    mapeo.shopifyVariantId = variante;
    mapeo.shopifySku = p.clave;
    mapeo.ctSku = p.clave;
    mapeo.partNumber = p.numeroParte;
    mapeo.inventoryItemId = ids.inventoryItemId;
    mapeo.locationId = env.shopify.locationId;
    mapeo.status = "confirmed";
    mapeo.confirmedBy = CONFIRMADO_POR;
    mapeo.reason = "Producto creado a partir del catálogo de CT";
    await this.mapeos.save(mapeo);
  }
}

function vacio(p: ProductoCt): ResultadoImportacion {
  return {
    clave: p.clave, nombre: p.nombre, accion: "omitir",
    costo: null, moneda: null, precioVenta: null, existencia: null, cantidadPublicada: null,
  };
}
