/**
 * src/services/OrderService.ts
 * ============================
 * RF-03 a RF-07. Traduce la orden pagada de Shopify a un pedido de CT,
 * guarda la relación y devuelve el resultado a Shopify.
 *
 * Las tres detenciones indispensables (sección 3.1 del ETS) están aquí:
 *
 *   1. SKU sin mapeo confirmado  -> estado "blocked" con el motivo; no se envía
 *                                   a CT y se puede reintentar al confirmar el mapeo.
 *   2. CT rechaza o no hay stock -> se guarda el rechazo, no se marca surtida.
 *   3. Respuesta incierta        -> estado "uncertain" (timeout, red, 408 o 5xx); se
 *                                   verifica en CT ANTES de volver a crear el pedido.
 */
import { Repository } from "typeorm";
import { env } from "../config/env";
import { OrderMapping } from "../entities/OrderMapping";
import { normalizarVariante, ProductMapping } from "../entities/ProductMapping";
import { registrarEvento } from "./bitacora";
import { ClienteCt, EnvioCt, ErrorCt, LineaPedidoCt, PedidoCt } from "./CtClient";
import { InventorySyncService } from "./InventorySyncService";
import { ShopifyClient } from "./ShopifyClient";

/** Línea de la orden, ya reducida a lo que el middleware necesita. */
export interface LineaOrden {
  sku: string | null;
  variantId: string | null;
  cantidad: number;
  /** Precio de VENTA en Shopify. Sólo referencia: a CT viaja su propio precio. */
  precio: number;
  moneda: string;
}

/** La orden de Shopify reducida a lo mínimo (RF-03: sólo lo necesario). */
export interface OrdenShopify {
  id: string;
  name: string | null;
  lineas: LineaOrden[];
  envio?: EnvioCt;
  /** PENDIENTE con CT: catálogo de tipoPago y uso de CFDI que aplica a SCHU. */
  tipoPago?: string;
  cfdi?: string;
}

/**
 * Horas que da CT para confirmar un pedido antes de cancelarlo por su cuenta.
 * Sale de la documentación de CT, no del ETS: el documento se escribió antes
 * de conocer el API real, donde crear el pedido y confirmarlo son DOS pasos.
 */
export const HORAS_PARA_CONFIRMAR = 48;

export class ErrorDetencion extends Error {
  constructor(mensaje: string, public readonly motivo: string) {
    super(mensaje);
    this.name = "ErrorDetencion";
  }
}

export interface ResultadoOrden {
  registro: OrderMapping;
  reflejadoEnShopify: boolean;
  stockResincronizado: number;
}

export class OrderService {
  constructor(
    private readonly ct: ClienteCt,
    private readonly shopify: ShopifyClient,
    private readonly ordenes: Repository<OrderMapping>,
    private readonly mapeos: Repository<ProductMapping>,
    private readonly inventario?: InventorySyncService
  ) {}

  /**
   * Referencia externa numérica para CT (`idPedido`). Derivarla del ID de
   * Shopify la hace estable: la misma orden siempre produce el mismo número,
   * así que un reintento no crea un segundo pedido.
   */
  calcularReferencia(shopifyOrderId: string): number {
    const digitos = shopifyOrderId.replace(/\D/g, "");
    if (!digitos) {
      throw new ErrorDetencion(`ID de orden inesperado: ${shopifyOrderId}`, "id_invalido");
    }
    // Últimos 9 dígitos: cabe en un entero de 32 bits.
    return Number(digitos.slice(-9));
  }

  /**
   * Vuelve a procesar una orden "blocked" con la copia guardada al recibirla.
   * Cualquier otro estado se rechaza: "uncertain" se verifica en CT a mano y
   * lo demás ya tuvo respuesta de CT.
   */
  async reintentar(
    shopifyOrderId: string
  ): Promise<ResultadoOrden | { error: string; detalle: string }> {
    const registro = await this.ordenes.findOne({ where: { shopifyOrderId } });
    if (!registro) {
      return { error: "orden_no_registrada", detalle: `No hay registro de la orden ${shopifyOrderId}.` };
    }
    if (registro.status !== "blocked") {
      return {
        error: "estado_no_reintentable",
        detalle: `La orden está en "${registro.status}". Sólo se reintentan las "blocked".`,
      };
    }
    if (!registro.orderPayload) {
      return {
        error: "sin_copia_de_la_orden",
        detalle: "La orden se recibió antes de que se guardara su contenido. Reenvía el webhook desde Shopify.",
      };
    }
    await registrarEvento({
      tipo: "reintento", shopifyOrderId,
      mensaje: `Reintento manual (estaba detenida por ${registro.ctStatus ?? "motivo desconocido"})`,
    });
    return this.procesar(JSON.parse(registro.orderPayload) as OrdenShopify);
  }

  /** Flujo completo de una orden elegible. Deja el resultado en la bitácora. */
  async procesar(orden: OrdenShopify): Promise<ResultadoOrden> {
    try {
      const resultado = await this.procesarOrden(orden);
      const { status, ctStatus, ctOrderId, lastResponse } = resultado.registro;
      await registrarEvento({
        // "uncertain" pide que alguien revise en CT: es lo más urgente.
        nivel: status === "uncertain" ? "error" : status === "accepted" ? "info" : "aviso",
        tipo: "orden_procesada",
        shopifyOrderId: orden.id,
        mensaje: `${orden.name ?? orden.id} -> ${status}` +
          (ctOrderId ? ` (CT ${ctOrderId})` : "") + (ctStatus ? ` · ${ctStatus}` : ""),
        detalle: status === "accepted" ? null : lastResponse,
      });
      return resultado;
    } catch (e) {
      await registrarEvento({
        nivel: "error", tipo: "orden_fallida", shopifyOrderId: orden.id,
        mensaje: `${orden.name ?? orden.id}: ${(e as Error).message}`,
      });
      throw e;
    }
  }

  private async procesarOrden(orden: OrdenShopify): Promise<ResultadoOrden> {
    const registro = await this.registrar(orden);

    // Idempotencia: si ya se envió, no se vuelve a enviar. "blocked" sí se
    // reintenta: nunca llegó a CT, así que no hay pedido que duplicar.
    if (registro.status !== "received" && registro.status !== "blocked") {
      return { registro, reflejadoEnShopify: false, stockResincronizado: 0 };
    }

    // --- Detención 1: toda línea necesita mapeo confirmado (RF-01, RF-04) ---
    // Antes el error salía sin guardar nada: la orden quedaba en "received",
    // sin motivo y sin aviso en Shopify. Ahora queda registrada.
    let productos: LineaPedidoCt[];
    let clavesCt: string[];
    try {
      ({ productos, clavesCt } = await this.traducirLineas(orden.lineas));
    } catch (e) {
      if (!(e instanceof ErrorDetencion)) throw e;
      return this.detener(registro, e.motivo, e.message);
    }

    const payload: PedidoCt = {
      idPedido: registro.externalReference as number,
      almacen: env.ct.almacen,
      tipoPago: orden.tipoPago ?? "99",
      cfdi: orden.cfdi ?? "G01",
      envio: orden.envio ? [orden.envio] : [],
      producto: productos,
    };
    registro.requestPayload = JSON.stringify(payload);
    // Un reintento no debe arrastrar el motivo de la detención anterior.
    registro.ctStatus = null;
    await this.ordenes.save(registro);

    try {
      const respuesta = await this.ct.crearPedido(payload);
      const folio = respuesta?.respuestaCT?.pedidoWeb;
      const errores = respuesta?.respuestaCT?.errores ?? [];

      // --- Detención 2: CT rechazó ---------------------------------------
      if (!folio || errores.length > 0) {
        registro.status = "rejected";
        registro.ctStatus = respuesta?.respuestaCT?.estatus ?? "rechazado";
        registro.lastResponse = JSON.stringify(errores.length ? errores : respuesta);
        await this.ordenes.save(registro);
        const reflejado = await this.reflejar(registro);
        return { registro, reflejadoEnShopify: reflejado, stockResincronizado: 0 };
      }

      // RF-05. Guardar la relación Shopify <-> CT antes que nada: si algo
      // falla después, el folio ya quedó registrado y nadie pide dos veces.
      const ahora = new Date();
      registro.ctOrderId = folio;
      registro.ctStatus = respuesta.respuestaCT.estatus;
      registro.status = "sent";
      registro.sentAt = ahora;
      registro.confirmDeadline = new Date(
        ahora.getTime() + HORAS_PARA_CONFIRMAR * 60 * 60 * 1000
      );
      registro.lastResponse = JSON.stringify(respuesta.respuestaCT);
      await this.ordenes.save(registro);

      // Segundo paso del pedido: CT cancela solo lo que no se confirma.
      // La orden de Shopify ya está pagada, así que se confirma de inmediato.
      const confirmado = await this.confirmar(registro);

      // RF-06 y RF-07. El stock sólo se resincroniza si la compra quedó en
      // firme: si no se confirmó, CT todavía no descontó nada.
      const reflejado = await this.reflejar(confirmado);
      const resincronizados =
        confirmado.status === "accepted" ? await this.resincronizar(clavesCt) : 0;

      return {
        registro: confirmado,
        reflejadoEnShopify: reflejado,
        stockResincronizado: resincronizados,
      };
    } catch (e) {
      const error = e as ErrorCt;

      // Falló antes de salir (sin token): CT no recibió nada. No es incierto.
      if (error instanceof ErrorCt && error.sinEnviar) {
        return this.detener(registro, "ct_sin_conexion", error.message);
      }

      // --- Detención 3: respuesta incierta -------------------------------
      // Timeout, red, 408 o 5xx: el pedido pudo haberse creado (un 502/504 de
      // la pasarela puede llegar DESPUÉS de que CT lo procesó). CT documenta
      // 408 en POST /pedido: también es un timeout. NO se reintenta.
      const incierta = error instanceof ErrorCt &&
        (error.httpStatus === 0 || error.httpStatus === 408 || error.httpStatus >= 500);
      if (incierta) {
        registro.status = "uncertain";
        registro.lastResponse =
          `Respuesta incierta de CT. Verificar en /pedido/listar si el pedido con ` +
          `idPedido ${registro.externalReference} se creó, ANTES de reintentar. ` +
          error.message;
        await this.ordenes.save(registro);
        return { registro, reflejadoEnShopify: false, stockResincronizado: 0 };
      }

      registro.status = "rejected";
      registro.lastResponse = `${error.message} ${JSON.stringify(
        (error as ErrorCt).cuerpo ?? {}
      )}`;
      await this.ordenes.save(registro);
      const reflejado = await this.reflejar(registro);
      return { registro, reflejadoEnShopify: reflejado, stockResincronizado: 0 };
    }
  }

  /**
   * Segundo paso del pedido de CT. Se llama solo después de crear, y también
   * lo llama el job para los que quedaron a medias.
   *
   * Si la ventana ya venció no se intenta: CT lo canceló y hay que decirlo,
   * no fingir que sigue vivo.
   */
  async confirmar(registro: OrderMapping): Promise<OrderMapping> {
    if (registro.status === "accepted") return registro;
    if (!registro.ctOrderId) {
      throw new ErrorDetencion(
        `La orden ${registro.shopifyOrderName ?? registro.shopifyOrderId} no tiene folio de CT`,
        "sin_folio"
      );
    }

    if (registro.confirmDeadline && new Date() > registro.confirmDeadline) {
      registro.status = "expired";
      registro.lastResponse =
        `Se pasó la ventana de ${HORAS_PARA_CONFIRMAR} h; CT ya canceló el pedido ` +
        `${registro.ctOrderId}. Hay que levantarlo de nuevo a mano.`;
      await this.ordenes.save(registro);
      await registrarEvento({
        nivel: "error", tipo: "pedido_vencido", shopifyOrderId: registro.shopifyOrderId,
        mensaje: registro.lastResponse,
      });
      return registro;
    }

    registro.confirmAttempts += 1;
    try {
      const respuesta = await this.ct.confirmarPedido(registro.ctOrderId);
      registro.status = "accepted";
      registro.confirmedAt = new Date();
      registro.ctStatus = respuesta?.okReference ?? registro.ctStatus;
      registro.lastResponse = JSON.stringify(respuesta);
      await registrarEvento({
        tipo: "pedido_confirmado", shopifyOrderId: registro.shopifyOrderId,
        mensaje: `CT confirmó el pedido ${registro.ctOrderId}`,
      });
    } catch (e) {
      // El pedido EXISTE en CT; sólo no se pudo confirmar todavía. Se queda
      // en "sent" para que el job lo reintente antes del vencimiento.
      registro.lastResponse = `Confirmación fallida: ${(e as Error).message}`;
      await registrarEvento({
        nivel: "aviso", tipo: "confirmacion_fallida", shopifyOrderId: registro.shopifyOrderId,
        mensaje: `Intento ${registro.confirmAttempts} de confirmar ${registro.ctOrderId}: ${(e as Error).message}`,
      });
    }
    await this.ordenes.save(registro);
    return registro;
  }

  /**
   * Los pedidos creados que aún no se confirmaron. Sin esto, un corte de red
   * de un minuto convierte una venta en un pedido cancelado por CT.
   */
  async confirmarPendientes(): Promise<{
    confirmados: number; fallidos: number; vencidos: number; porVencer: string[];
  }> {
    const pendientes = await this.ordenes.find({ where: { status: "sent" } });
    let confirmados = 0, fallidos = 0, vencidos = 0;
    const porVencer: string[] = [];
    const ahora = Date.now();

    for (const registro of pendientes) {
      const resultado = await this.confirmar(registro);
      if (resultado.status === "accepted") confirmados++;
      else if (resultado.status === "expired") vencidos++;
      else {
        fallidos++;
        const horas = resultado.confirmDeadline
          ? (resultado.confirmDeadline.getTime() - ahora) / 3_600_000
          : Number.POSITIVE_INFINITY;
        if (horas <= 6) {
          const aviso =
            `${resultado.shopifyOrderName ?? resultado.shopifyOrderId} ` +
            `(CT ${resultado.ctOrderId}) vence en ${horas.toFixed(1)} h`;
          porVencer.push(aviso);
          await registrarEvento({
            nivel: "error", tipo: "pedido_por_vencer",
            shopifyOrderId: resultado.shopifyOrderId, mensaje: aviso,
          });
        }
      }
    }
    return { confirmados, fallidos, vencidos, porVencer };
  }

  /** Detiene la orden antes de CT: queda el motivo en la base y en Shopify. */
  private async detener(registro: OrderMapping, motivo: string, detalle: string): Promise<ResultadoOrden> {
    registro.status = "blocked";
    registro.ctStatus = motivo;
    registro.lastResponse = `Detenida antes de enviar a CT (${motivo}): ${detalle}`;
    await this.ordenes.save(registro);
    const reflejado = await this.reflejar(registro);
    return { registro, reflejadoEnShopify: reflejado, stockResincronizado: 0 };
  }

  /** Crea o recupera el OrderMapping de esta orden. */
  private async registrar(orden: OrdenShopify): Promise<OrderMapping> {
    const existente = await this.ordenes.findOne({
      where: { shopifyOrderId: orden.id },
    });
    if (existente) {
      // Órdenes anteriores a la columna: se completa para poder reintentarlas.
      if (!existente.orderPayload) {
        existente.orderPayload = JSON.stringify(orden);
        await this.ordenes.save(existente);
      }
      return existente;
    }

    const registro = this.ordenes.create({
      shopifyOrderId: orden.id,
      shopifyOrderName: orden.name ?? null,
      externalReference: this.calcularReferencia(orden.id),
      status: "received",
      orderPayload: JSON.stringify(orden),
    });
    return this.ordenes.save(registro);
  }

  /**
   * RF-04. Cambia los identificadores de Shopify por los de CT.
   * El mapeo se busca por VARIANTE, que siempre viene en la orden; el SKU es
   * sólo el respaldo para una línea sin variante (hay artículos sin SKU).
   */
  private async traducirLineas(
    lineas: LineaOrden[]
  ): Promise<{ productos: LineaPedidoCt[]; clavesCt: string[] }> {
    const productos: LineaPedidoCt[] = [];
    const clavesCt: string[] = [];

    for (const linea of lineas) {
      let mapeo: ProductMapping | null;
      let producto: string;
      if (linea.variantId) {
        const variante = normalizarVariante(linea.variantId);
        producto = `La variante ${variante}` + (linea.sku ? ` (SKU ${linea.sku})` : "");
        mapeo = await this.mapeos.findOne({
          where: { shopifyVariantId: variante, status: "confirmed" },
        });
      } else if (linea.sku) {
        producto = `El SKU ${linea.sku}`;
        mapeo = await this.mapeos.findOne({
          where: { shopifySku: linea.sku, status: "confirmed" },
        });
      } else {
        throw new ErrorDetencion(
          "Hay una línea de la orden sin variante ni SKU: no se puede identificar el producto.",
          "linea_sin_identificador"
        );
      }
      if (!mapeo) {
        throw new ErrorDetencion(
          `${producto} no tiene mapeo confirmado contra CT. No se envía el pedido.`,
          "mapeo_no_confirmado"
        );
      }
      // CT pide consultar precio y existencia antes de pedir, y el precio que
      // viaja es el de CT (nuestro costo) en SU moneda, no el de venta en Shopify.
      const { precio, moneda } = await this.precioCt(mapeo.ctSku);
      productos.push({
        cantidad: linea.cantidad,
        clave: mapeo.ctSku,
        precio,
        moneda,
      });
      clavesCt.push(mapeo.ctSku);
    }
    return { productos, clavesCt };
  }

  /**
   * Precio vigente en CT del almacén configurado (GET /existencia/detalle).
   * Si no se puede saber, la orden se detiene: todavía no salió nada a CT, así
   * que es "blocked" y se puede reintentar, nunca "uncertain".
   */
  private async precioCt(clave: string): Promise<{ precio: number; moneda: string }> {
    let detalle;
    try {
      [detalle] = await this.ct.detalle(clave, env.ct.almacen);
    } catch (e) {
      // Sin token (p. ej. aún sin credenciales de CT) la consulta ni salió.
      const sinConexion = e instanceof ErrorCt && e.sinEnviar;
      throw new ErrorDetencion(
        `No se pudo consultar el precio de ${clave} en CT. No se envía el pedido. ${(e as Error).message}`,
        sinConexion ? "ct_sin_conexion" : "precio_no_disponible"
      );
    }
    if (!detalle || !(Number(detalle.precio) > 0) || !detalle.moneda) {
      throw new ErrorDetencion(
        `CT no devolvió precio para ${clave} en el almacén ${env.ct.almacen}. No se envía el pedido.`,
        "precio_no_disponible"
      );
    }
    return { precio: Number(detalle.precio), moneda: detalle.moneda };
  }

  /** RF-06. Refleja en Shopify lo que dijo CT. Si falla, no rompe el flujo. */
  private async reflejar(registro: OrderMapping): Promise<boolean> {
    try {
      await this.shopify.registrarResultadoEnOrden(
        registro.shopifyOrderId,
        registro.ctOrderId,
        registro.ctStatus ?? registro.status
      );
      return true;
    } catch {
      return false;
    }
  }

  /** RF-07. El stock de CT cambió: volver a consultarlo y publicarlo. */
  private async resincronizar(clavesCt: string[]): Promise<number> {
    if (!this.inventario || clavesCt.length === 0) return 0;
    try {
      const resultados = await this.inventario.resincronizarClaves(clavesCt);
      return resultados.filter((r) => r.actualizado).length;
    } catch {
      return 0;
    }
  }
}
