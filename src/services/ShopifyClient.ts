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
 *
 * SOBRE EL TOKEN — esto cambió en Shopify y es la razón de la mitad de este
 * archivo. Ya no se pueden crear apps personalizadas desde el admin de la
 * tienda, y las apps del Dev Dashboard NO dan un token permanente: se obtiene
 * por "client credentials" y **expira en 24 horas**.
 *
 *   POST https://{tienda}/admin/oauth/access_token
 *   grant_type=client_credentials&client_id=...&client_secret=...
 *   -> { access_token, scope, expires_in }
 *
 * Por eso el token se pide solo y se renueva antes de vencer. Si alguien tiene
 * todavía un token permanente de una app vieja (`shpat_...`), se usa ése y no
 * se pide nada.
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

interface RespuestaToken {
  access_token: string;
  scope?: string;
  expires_in?: number;
}

export class ShopifyClient {
  private clienteGraphql: InstanceType<
    ReturnType<typeof shopifyApi>["clients"]["Graphql"]
  > | null = null;

  private token: string | null = null;
  private tokenExpiraEn = 0;

  /**
   * Devuelve un token vigente. Si hay uno fijo en la configuración se usa tal
   * cual; si no, se pide por client credentials y se renueva un minuto antes
   * de vencer.
   */
  private async obtenerToken(): Promise<string> {
    if (env.shopify.tokenFijo) return env.shopify.tokenFijo;
    if (this.token && Date.now() < this.tokenExpiraEn) return this.token;

    const cuerpo = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.shopify.clientId,
      client_secret: env.shopify.clientSecret,
    });

    const respuesta = await fetch(
      `https://${env.shopify.dominio}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: cuerpo,
      }
    );

    const texto = await respuesta.text();
    if (!respuesta.ok) {
      throw new ErrorShopify(
        `Shopify no emitió el token (${respuesta.status}). ` +
          `Revisa SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET y que la app esté ` +
          `instalada en ${env.shopify.dominio}.`,
        texto.slice(0, 300)
      );
    }

    let datos: RespuestaToken;
    try {
      datos = JSON.parse(texto) as RespuestaToken;
    } catch {
      throw new ErrorShopify("Shopify devolvió algo que no es JSON al pedir el token", texto.slice(0, 200));
    }
    if (!datos.access_token) {
      throw new ErrorShopify("Shopify no devolvió access_token", datos);
    }

    this.token = datos.access_token;
    // Un minuto de colchón: nunca usar un token que está por vencer.
    const segundos = datos.expires_in ?? 86_399;
    this.tokenExpiraEn = Date.now() + Math.max(0, segundos - 60) * 1000;
    // El cliente cacheado trae el token viejo: se descarta.
    this.clienteGraphql = null;
    return this.token;
  }

  /** Se construye a demanda: así la API arranca sin credenciales. */
  private async graphql() {
    const token = await this.obtenerToken();
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
      adminApiAccessToken: token,
    });

    const sesion: Session = shopify.session.customAppSession(env.shopify.dominio);
    this.clienteGraphql = new shopify.clients.Graphql({ session: sesion });
    return this.clienteGraphql;
  }

  private async consultar<T>(operacion: string, variables?: Record<string, unknown>): Promise<T> {
    const cliente = await this.graphql();
    const respuesta = await cliente.request<T>(operacion, { variables });
    if (respuesta.errors) {
      throw new ErrorShopify("Shopify devolvió errores de GraphQL", respuesta.errors);
    }
    if (!respuesta.data) {
      throw new ErrorShopify("Shopify no devolvió datos", respuesta);
    }
    return respuesta.data as T;
  }

  // -------------------------------------------------------------- locations

  /**
   * Locations de la tienda. De aquí sale el SHOPIFY_LOCATION_ID, y sirve como
   * primera prueba de que el token y los scopes funcionan.
   */
  async listarLocations(): Promise<{ id: string; name: string; isActive: boolean }[]> {
    const datos = await this.consultar<{
      locations: { edges: { node: { id: string; name: string; isActive: boolean } }[] };
    }>(
      `query locations {
         locations(first: 20) {
           edges { node { id name isActive } }
         }
       }`
    );
    return datos.locations.edges.map((e) => e.node);
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

  /** Producto al que pertenece una variante (para actualizar lo ya importado). */
  async productoDeVariante(variantId: string): Promise<string | null> {
    const gid = variantId.startsWith("gid://")
      ? variantId
      : `gid://shopify/ProductVariant/${variantId}`;
    const datos = await this.consultar<{ productVariant: { product: { id: string } } | null }>(
      `query productoDeVariante($id: ID!) {
         productVariant(id: $id) { product { id } }
       }`,
      { id: gid }
    );
    return datos.productVariant?.product.id ?? null;
  }

  /** Busca por handle; sirve cuando el mapeo local se perdió pero el producto existe. */
  async productoPorHandle(
    handle: string
  ): Promise<{ productId: string; variantId: string; inventoryItemId: string } | null> {
    const datos = await this.consultar<{
      products: {
        nodes: {
          id: string; handle: string;
          variants: { nodes: { id: string; inventoryItem: { id: string } | null }[] };
        }[];
      };
    }>(
      `query productoPorHandle($q: String!) {
         products(first: 1, query: $q) {
           nodes { id handle variants(first: 1) { nodes { id inventoryItem { id } } } }
         }
       }`,
      { q: `handle:${handle}` }
    );
    const nodo = datos.products.nodes[0];
    const variante = nodo?.variants.nodes[0];
    if (!nodo || nodo.handle !== handle || !variante?.inventoryItem) return null;
    return { productId: nodo.id, variantId: variante.id, inventoryItemId: variante.inventoryItem.id };
  }

  /** Precio de venta y costo de una variante; no toca título ni descripción. */
  async actualizarPrecio(productId: string, variantId: string, precio: number, costo: number): Promise<void> {
    const gid = variantId.startsWith("gid://")
      ? variantId
      : `gid://shopify/ProductVariant/${variantId}`;
    const datos = await this.consultar<{ productVariantsBulkUpdate: { userErrors: ErrorUsuario[] } }>(
      `mutation actualizarPrecio($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
         productVariantsBulkUpdate(productId: $productId, variants: $variants) {
           userErrors { field message }
         }
       }`,
      {
        productId,
        variants: [{ id: gid, price: precio.toFixed(2), inventoryItem: { cost: costo.toFixed(2) } }],
      }
    );
    const errores = datos.productVariantsBulkUpdate.userErrors;
    if (errores?.length) {
      throw new ErrorShopify(
        "Shopify rechazó el precio: " + errores.map((e) => e.message).join("; "), errores
      );
    }
  }

  /**
   * Crea o actualiza un producto de una sola variante con `productSet`.
   * Con `productId` actualiza; sin él, crea. Devuelve los IDs que hacen falta
   * para el mapeo y el inventario.
   */
  async guardarProducto(
    entrada: Record<string, unknown>,
    productId?: string | null
  ): Promise<{ productId: string; variantId: string; inventoryItemId: string }> {
    const datos = await this.consultar<{
      productSet: {
        product: {
          id: string;
          variants: { nodes: { id: string; inventoryItem: { id: string } | null }[] };
        } | null;
        userErrors: ErrorUsuario[];
      };
    }>(
      `mutation guardarProducto($input: ProductSetInput!) {
         productSet(input: $input, synchronous: true) {
           product {
             id
             variants(first: 1) { nodes { id inventoryItem { id } } }
           }
           userErrors { field message }
         }
       }`,
      { input: productId ? { ...entrada, id: productId } : entrada }
    );

    const { product, userErrors } = datos.productSet;
    if (userErrors?.length || !product) {
      throw new ErrorShopify(
        "Shopify rechazó el producto: " +
          (userErrors ?? []).map((e) => `${(e.field ?? []).join(".")}: ${e.message}`).join("; "),
        userErrors
      );
    }
    const variante = product.variants.nodes[0];
    if (!variante?.inventoryItem) {
      throw new ErrorShopify("Shopify guardó el producto pero no devolvió su variante", product);
    }
    return { productId: product.id, variantId: variante.id, inventoryItemId: variante.inventoryItem.id };
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
