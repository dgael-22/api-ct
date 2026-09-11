/**
 * src/services/OrderService.ts
 * ============================
 * RF-03 a RF-07. Traduce la orden pagada de Shopify a un pedido de CT,
 * guarda la relación y devuelve el resultado a Shopify.
 *
 * Las tres detenciones indispensables (sección 3.1 del ETS) están aquí:
 *
 *   1. SKU sin mapeo confirmado  -> se detiene la línea, no se envía a CT.
 *   2. CT rechaza o no hay stock -> se guarda el rechazo, no se marca surtida.
 *   3. Respuesta incierta        -> estado "uncertain"; se verifica en CT
 *                                   ANTES de volver a crear el pedido.
 */
import { Repository } from "typeorm";
import { env } from "../config/env";
import { OrderMapping } from "../entities/OrderMapping";
import { ProductMapping } from "../entities/ProductMapping";
import { CtClient, EnvioCt, ErrorCt, LineaPedidoCt, PedidoCt } from "./CtClient";
import { InventorySyncService } from "./InventorySyncService";
import { ShopifyClient } from "./ShopifyClient";

/** Línea de la orden, ya reducida a lo que el middleware necesita. */
export interface LineaOrden {
  sku: string | null;
  variantId: string | null;
  cantidad: number;
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
    private readonly ct: CtClient,
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

  /** Flujo completo de una orden elegible. */
  async procesar(orden: OrdenShopify): Promise<ResultadoOrden> {
    const registro = await this.registrar(orden);

    // Idempotencia: si ya se envió, no se vuelve a enviar.
    if (registro.status !== "received") {
      return { registro, reflejadoEnShopify: false, stockResincronizado: 0 };
    }

    // --- Detención 1: toda línea necesita mapeo confirmado (RF-01, RF-04) ---
    const { productos, clavesCt } = await this.traducirLineas(orden.lineas);

    const payload: PedidoCt = {
      idPedido: registro.externalReference as number,
      almacen: env.ct.almacen,
      tipoPago: orden.tipoPago ?? "99",
      cfdi: orden.cfdi ?? "G01",
      envio: orden.envio ? [orden.envio] : [],
      producto: productos,
    };
    registro.requestPayload = JSON.stringify(payload);
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

      // --- Detención 3: respuesta incierta -------------------------------
      // Timeout o red: el pedido pudo haberse creado. NO se reintenta.
      if (error instanceof ErrorCt && error.httpStatus === 0) {
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
      return registro;
    }

    registro.confirmAttempts += 1;
    try {
      const respuesta = await this.ct.confirmarPedido(registro.ctOrderId);
      registro.status = "accepted";
      registro.confirmedAt = new Date();
      registro.ctStatus = respuesta?.okReference ?? registro.ctStatus;
      registro.lastResponse = JSON.stringify(respuesta);
    } catch (e) {
      // El pedido EXISTE en CT; sólo no se pudo confirmar todavía. Se queda
      // en "sent" para que el job lo reintente antes del vencimiento.
      registro.lastResponse = `Confirmación fallida: ${(e as Error).message}`;
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
          porVencer.push(
            `${resultado.shopifyOrderName ?? resultado.shopifyOrderId} ` +
            `(CT ${resultado.ctOrderId}) vence en ${horas.toFixed(1)} h`
          );
        }
      }
    }
    return { confirmados, fallidos, vencidos, porVencer };
  }

  /** Crea o recupera el OrderMapping de esta orden. */
  private async registrar(orden: OrdenShopify): Promise<OrderMapping> {
    const existente = await this.ordenes.findOne({
      where: { shopifyOrderId: orden.id },
    });
    if (existente) return existente;

    const registro = this.ordenes.create({
      shopifyOrderId: orden.id,
      shopifyOrderName: orden.name ?? null,
      externalReference: this.calcularReferencia(orden.id),
      status: "received",
    });
    return this.ordenes.save(registro);
  }

  /** RF-04. Cambia los identificadores de Shopify por los de CT. */
  private async traducirLineas(
    lineas: LineaOrden[]
  ): Promise<{ productos: LineaPedidoCt[]; clavesCt: string[] }> {
    const productos: LineaPedidoCt[] = [];
    const clavesCt: string[] = [];

    for (const linea of lineas) {
      if (!linea.sku) {
        throw new ErrorDetencion("Hay una línea de la orden sin SKU", "sku_vacio");
      }
      const mapeo = await this.mapeos.findOne({
        where: { shopifySku: linea.sku, status: "confirmed" },
      });
      if (!mapeo) {
        throw new ErrorDetencion(
          `El SKU ${linea.sku} no tiene mapeo confirmado contra CT. No se envía el pedido.`,
          "mapeo_no_confirmado"
        );
      }
      productos.push({
        cantidad: linea.cantidad,
        clave: mapeo.ctSku,
        precio: linea.precio,
        moneda: linea.moneda,
      });
      clavesCt.push(mapeo.ctSku);
    }
    return { productos, clavesCt };
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
