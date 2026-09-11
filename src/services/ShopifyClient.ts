/**
 * src/services/ShopifyClient.ts
 * =============================
 * Acceso a la Admin API de Shopify usando la librería oficial
 * (@shopify/shopify-api), como recomienda la sección 7 del ETS: no se
 * reconstruye a mano la capa de GraphQL ni la autenticación.
 *
 * Lo que necesita el MVP:
 *   · leer la variante y su InventoryItem            (RF-01, RF-02)
 *   · fijar la cantidad disponible en una Location    (RF-02, RF-07)
 *   · dejar visible en la orden la referencia de CT   (RF-06)
 */
import "@shopify/shopify-api/adapters/node";
import { ApiVersion, Session, shopifyApi } from "@shopify/shopify-api";
import { env } from "../config/env";

export interface VarianteShopify {
  id: string;
  sku: string | null;
  inventoryItemId: string | null;
  title: string | null;
}

export interface ErrorUsuario {
  field?: string[] | null;
  message: string;
}

export class ErrorShopify extends Error {
  constructor(mensaje: string, public readonly detalle?: unknown) {
    super(mensaje);
    this.name = "ErrorShopify";
  }
}

export class ShopifyClient {
  private clienteGraphql: InstanceType<
    ReturnType<typeof shopifyApi>["clients"]["Graphql"]
  > | null = null;

  /** Se construye a demanda: así la API arranca sin credenciales. */
  private graphql() {
    if (this.clienteGraphql) return this.clienteGraphql;

    const shopify = shopifyApi({
      apiKey: env.shopify.clientId,
      apiSecretKey: env.shopify.clientSecret,
      apiVersion: env.shopify.apiVersion as ApiVersion,
      hostName: (env.app.baseUrl || `https://${env.shopify.dominio}`)
        .replace(/^https?:\/\//, ""),
      isEmbeddedApp: false,
      // App propia de la tienda: el token de Admin API va en la configuración.
      isCustomStoreApp: true,
      adminApiAccessToken: env.shopify.accessToken,
    });

    const sesion: Session = shopify.session.customAppSession(env.shopify.dominio);
    this.clienteGraphql = new shopify.clients.Graphql({ session: sesion });
    return this.clienteGraphql;
  }

  private async consultar<T>(operacion: string, variables?: Record<string, unknown>): Promise<T> {
    const respuesta = await this.graphql().request<T>(operacion, { variables });
    if (respuesta.errors) {
      throw new ErrorShopify("Shopify devolvió errores de GraphQL", respuesta.errors);
    }
    if (!respuesta.data) {
      throw new ErrorShopify("Shopify no devolvió datos", respuesta);
    }
    return respuesta.data as T;
  }

  // -------------------------------------------------------------- variantes

  /** RF-01. Lee la variante y su InventoryItem, que es lo que se inventaría. */
  async obtenerVariante(variantId: string): Promise<VarianteShopify> {
    const gid = variantId.startsWith("gid://")
      ? variantId
      : `gid://shopify/ProductVariant/${variantId}`;

    const datos = await this.consultar<{
      productVariant: {
        id: string; sku: string | null; title: string | null;
        inventoryItem: { id: string } | null;
      } | null;
    }>(
      `query variante($id: ID!) {
         productVariant(id: $id) {
           id
           sku
           title
           inventoryItem { id }
         }
       }`,
      { id: gid }
    );

    const v = datos.productVariant;
    if (!v) throw new ErrorShopify(`La variante ${variantId} no existe en Shopify`);

    return {
      id: v.id,
      sku: v.sku,
      title: v.title,
      inventoryItemId: v.inventoryItem?.id ?? null,
    };
  }

  // -------------------------------------------------------------- inventario

  /**
   * RF-02 y RF-07. Fija la cantidad DISPONIBLE del InventoryItem en la
   * Location indicada. Se usa `inventorySetQuantities` porque fija un valor
   * absoluto: el middleware no lleva su propia cuenta ni suma deltas — CT es
   * la fuente de la disponibilidad.
   */
  async fijarInventario(
    inventoryItemId: string,
    locationId: string,
    cantidad: number
  ): Promise<void> {
    const itemGid = inventoryItemId.startsWith("gid://")
      ? inventoryItemId
      : `gid://shopify/InventoryItem/${inventoryItemId}`;
    const locGid = locationId.startsWith("gid://")
      ? locationId
      : `gid://shopify/Location/${locationId}`;

    const datos = await this.consultar<{
      inventorySetQuantities: {
        inventoryAdjustmentGroup: { createdAt: string } | null;
        userErrors: ErrorUsuario[];
      };
    }>(
      `mutation fijarInventario($input: InventorySetQuantitiesInput!) {
         inventorySetQuantities(input: $input) {
           inventoryAdjustmentGroup { createdAt }
           userErrors { field message }
         }
       }`,
      {
        input: {
          name: "available",
          reason: "correction",
          // Sin comparar contra la cantidad previa: la verdad la trae CT.
          ignoreCompareQuantity: true,
          quantities: [
            { inventoryItemId: itemGid, locationId: locGid, quantity: cantidad },
          ],
        },
      }
    );

    const errores = datos.inventorySetQuantities.userErrors;
    if (errores?.length) {
      throw new ErrorShopify(
        `Shopify rechazó la actualización de inventario: ` +
          errores.map((e) => e.message).join("; "),
        errores
      );
    }
  }

  // ------------------------------------------------------------------ orden

  /**
   * RF-06. Deja el resultado de CT visible en la orden, sin tocar fulfillment
   * ni inventar estados comerciales: se escribe un metafield propio.
   */
  async registrarResultadoEnOrden(
    shopifyOrderId: string,
    ctOrderId: string | null,
    ctStatus: string
  ): Promise<void> {
    const gid = shopifyOrderId.startsWith("gid://")
      ? shopifyOrderId
      : `gid://shopify/Order/${shopifyOrderId}`;

    const datos = await this.consultar<{
      metafieldsSet: { userErrors: ErrorUsuario[] };
    }>(
      `mutation guardarResultado($metafields: [MetafieldsSetInput!]!) {
         metafieldsSet(metafields: $metafields) {
           userErrors { field message }
         }
       }`,
      {
        metafields: [
          {
            ownerId: gid,
            namespace: "schu_ct",
            key: "integration",
            type: "json",
            value: JSON.stringify({
              ctOrderId,
              ctStatus,
              updatedAt: new Date().toISOString(),
            }),
          },
        ],
      }
    );

    const errores = datos.metafieldsSet.userErrors;
    if (errores?.length) {
      throw new ErrorShopify(
        `Shopify rechazó el metafield: ` + errores.map((e) => e.message).join("; "),
        errores
      );
    }
  }
}
