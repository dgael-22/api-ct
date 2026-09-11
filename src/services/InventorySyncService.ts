/**
 * src/services/InventorySyncService.ts
 * ====================================
 * RF-02 y RF-07. Toma un ProductMapping confirmado, pregunta a CT cuánto hay
 * y escribe esa cantidad en el InventoryItem y la Location correctos de Shopify.
 *
 * El middleware NO inventaría ni suma stock por cuenta propia: CT es la fuente
 * de la disponibilidad y aquí sólo se copia.
 */
import { Repository } from "typeorm";
import { env } from "../config/env";
import { ProductMapping } from "../entities/ProductMapping";
import { CtClient } from "./CtClient";
import { ShopifyClient } from "./ShopifyClient";

/**
 * HUECO ABIERTO (sección 12.1 del ETS): CT sólo expone `existencia` y nadie ha
 * confirmado por escrito si esa cantidad ya descuenta mercancía comprometida.
 * Hasta que lo confirmen se resta un margen, para no publicar stock que en
 * realidad está apartado. Cuando CT responda, se pone en 0.
 */
export const MARGEN_SEGURIDAD = 1;

export interface ResultadoSincronizacion {
  shopifySku: string;
  ctSku: string;
  almacen: string;
  existenciaEnCt: number;
  cantidadPublicada: number;
  actualizado: boolean;
  motivo?: string;
}

export class InventorySyncService {
  constructor(
    private readonly ct: CtClient,
    private readonly shopify: ShopifyClient,
    private readonly mapeos: Repository<ProductMapping>
  ) {}

  /** Cantidad que se publica a partir de lo que reporta CT. Nunca negativa. */
  calcularPublicable(existencia: number): number {
    return Math.max(0, existencia - MARGEN_SEGURIDAD);
  }

  /** Sincroniza un mapeo. Sólo se acepta si está confirmado (RF-01). */
  async sincronizarUno(mapeo: ProductMapping): Promise<ResultadoSincronizacion> {
    const almacen = mapeo.locationId ? env.ct.almacen : env.ct.almacen;
    const base = {
      shopifySku: mapeo.shopifySku,
      ctSku: mapeo.ctSku,
      almacen,
      existenciaEnCt: 0,
      cantidadPublicada: 0,
      actualizado: false,
    };

    if (mapeo.status !== "confirmed") {
      return { ...base, motivo: "el mapeo no está confirmado; no se sincroniza" };
    }

    const porAlmacen = await this.ct.existenciaPorAlmacen(mapeo.ctSku);
    const reportada = porAlmacen?.[almacen]?.existencia;

    // Distinguir "no existe la clave" de "existe con cero".
    if (reportada === undefined) {
      return {
        ...base,
        motivo:
          `CT no reporta el almacén ${almacen} para la clave ${mapeo.ctSku}. ` +
          `Puede ser clave inexistente o almacén equivocado: no se publica 0 a ciegas.`,
      };
    }

    const cantidad = this.calcularPublicable(reportada);

    let inventoryItemId = mapeo.inventoryItemId;
    if (!inventoryItemId) {
      const variante = await this.shopify.obtenerVariante(mapeo.shopifyVariantId);
      inventoryItemId = variante.inventoryItemId;
      if (inventoryItemId) {
        mapeo.inventoryItemId = inventoryItemId;
        await this.mapeos.save(mapeo);
      }
    }

    if (!inventoryItemId) {
      return {
        ...base,
        existenciaEnCt: reportada,
        cantidadPublicada: cantidad,
        motivo: "la variante de Shopify no tiene InventoryItem",
      };
    }

    const locationId = mapeo.locationId || env.shopify.locationId;
    await this.shopify.fijarInventario(inventoryItemId, locationId, cantidad);

    return {
      ...base,
      existenciaEnCt: reportada,
      cantidadPublicada: cantidad,
      actualizado: true,
    };
  }

  /** Sincroniza todos los mapeos confirmados. */
  async sincronizarConfirmados(limite?: number): Promise<ResultadoSincronizacion[]> {
    const mapeos = await this.mapeos.find({
      where: { status: "confirmed" },
      take: limite,
    });
    const resultados: ResultadoSincronizacion[] = [];
    for (const mapeo of mapeos) {
      try {
        resultados.push(await this.sincronizarUno(mapeo));
      } catch (e) {
        resultados.push({
          shopifySku: mapeo.shopifySku,
          ctSku: mapeo.ctSku,
          almacen: env.ct.almacen,
          existenciaEnCt: 0,
          cantidadPublicada: 0,
          actualizado: false,
          motivo: `error: ${(e as Error).message}`,
        });
      }
    }
    return resultados;
  }

  /** RF-07. Después de un pedido aceptado, el stock de CT cambió: reconsultar. */
  async resincronizarClaves(ctSkus: string[]): Promise<ResultadoSincronizacion[]> {
    const resultados: ResultadoSincronizacion[] = [];
    for (const ctSku of [...new Set(ctSkus)]) {
      const mapeos = await this.mapeos.find({ where: { ctSku, status: "confirmed" } });
      for (const mapeo of mapeos) {
        try {
          resultados.push(await this.sincronizarUno(mapeo));
        } catch (e) {
          resultados.push({
            shopifySku: mapeo.shopifySku, ctSku, almacen: env.ct.almacen,
            existenciaEnCt: 0, cantidadPublicada: 0, actualizado: false,
            motivo: `error: ${(e as Error).message}`,
          });
        }
      }
    }
    return resultados;
  }
}
