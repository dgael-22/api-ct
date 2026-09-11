/**
 * src/services/CtSimulado.ts
 * ==========================
 * CT de mentiras, con el mismo contrato que el de verdad.
 *
 * Existe para que todo el circuito —webhook, traducción, pedido, confirmación,
 * resincronización de stock— se pueda probar de extremo a extremo SIN esperar
 * a que CT autorice la integración. La sección 9 del ETS lo contempla: simular
 * al proveedor con mocks antes de tener el ambiente autorizado.
 *
 * Responde con las MISMAS formas que documenta CT
 * (https://api.ctonline.mx/documentacion.html). Si esas formas resultan ser
 * otras en la realidad, lo que cambia es el cliente real, no el resto.
 *
 * Tres cosas lo hacen útil de verdad:
 *
 *  1. El stock es determinista: la misma clave siempre da la misma cantidad,
 *     así que las pruebas son repetibles.
 *  2. Un pedido aceptado DESCUENTA el stock. Así la resincronización (RF-07)
 *     muestra un cambio real, en vez de repetir el mismo número.
 *  3. Con CT_SIMULADO_ESCENARIO se fuerzan los casos feos —sin stock, rechazo,
 *     caída— que con CT real no se pueden provocar a voluntad.
 *
 * NUNCA debe quedarse encendido contra una tienda real: lo que "vende" no
 * existe. Por eso `simulado` es true, /health lo informa y el arranque lo grita.
 */
import { env } from "../config/env";
import {
  ClienteCt, DetalleExistencia, ErrorCt, EstatusPedidoCt, ExistenciaPorAlmacen,
  PedidoCt, RespuestaConfirmacionCt, RespuestaPedidoCt,
} from "./CtClient";

/** Qué debe hacer el CT simulado ante un pedido. */
export type Escenario =
  | "ok"          // acepta y confirma
  | "sin_stock"   // existencias en 0
  | "rechazo"     // CT devuelve errores
  | "caida";      // no responde: dispara la detención de "respuesta incierta"

interface PedidoGuardado {
  folio: string;
  idPedido: number;
  estatus: string;
  confirmado: boolean;
  lineas: { clave: string; cantidad: number }[];
}

export class CtSimulado implements ClienteCt {
  readonly simulado = true;

  private consecutivo = 1;
  private readonly pedidos = new Map<string, PedidoGuardado>();
  /** Descuentos acumulados por clave, para que el stock baje al vender. */
  private readonly vendido = new Map<string, number>();

  constructor(
    private readonly escenario: Escenario = env.ct.escenarioSimulado as Escenario,
    private readonly almacen: string = "01A"
  ) {}

  // ------------------------------------------------------------------ token

  async obtenerToken(): Promise<string> {
    return "token-simulado-no-sirve-contra-ct-real";
  }

  // ------------------------------------------------------------ existencias

  /**
   * Cantidad estable por clave: se deriva de la propia clave, así que la misma
   * consulta siempre da lo mismo y las pruebas son repetibles.
   */
  private base(codigo: string): number {
    if (this.escenario === "sin_stock") return 0;
    let suma = 0;
    for (const caracter of codigo) suma += caracter.charCodeAt(0);
    return (suma % 40) + 5;   // entre 5 y 44
  }

  private disponible(codigo: string): number {
    const descontado = this.vendido.get(codigo) ?? 0;
    return Math.max(0, this.base(codigo) - descontado);
  }

  async existenciaPorAlmacen(codigo: string): Promise<ExistenciaPorAlmacen> {
    this.simularCaida();
    const cantidad = this.disponible(codigo);
    return {
      [this.almacen]: { existencia: cantidad },
      "02A": { existencia: Math.floor(cantidad / 2) },
    };
  }

  async existenciaTotal(codigo: string): Promise<ExistenciaPorAlmacen> {
    this.simularCaida();
    const cantidad = this.disponible(codigo);
    return { TOTAL: { existencia: cantidad + Math.floor(cantidad / 2) } };
  }

  async detalle(codigo: string, almacen: string): Promise<DetalleExistencia[]> {
    this.simularCaida();
    return [{
      precio: 100 + (this.base(codigo) % 900),
      moneda: "MXN",
      tipoCambio: 17.5,
      existencia: this.disponible(codigo),
      promocion: null,
      codigoSAT: 43211900,
    }];
  }

  async catalogoCompleto(): Promise<unknown[]> {
    this.simularCaida();
    return [];
  }

  // ---------------------------------------------------------------- pedidos

  async crearPedido(pedido: PedidoCt): Promise<RespuestaPedidoCt> {
    this.simularCaida();

    // Idempotencia también aquí: el mismo idPedido no crea dos folios.
    const previo = [...this.pedidos.values()].find((p) => p.idPedido === pedido.idPedido);
    if (previo) {
      return this.respuesta(pedido, previo.folio, previo.estatus, []);
    }

    if (this.escenario === "rechazo") {
      return this.respuesta(pedido, "", "Rechazado", [
        { codigo: "SIM-001", mensaje: "Pedido rechazado por el CT simulado" },
      ]);
    }

    // Sin existencias suficientes: CT no surte.
    const faltantes = pedido.producto.filter(
      (linea) => this.disponible(linea.clave) < linea.cantidad
    );
    if (faltantes.length) {
      return this.respuesta(pedido, "", "Sin existencia", faltantes.map((l) => ({
        codigo: "SIM-002",
        mensaje: `Sin existencia suficiente para ${l.clave}`,
        clave: l.clave,
      })));
    }

    const folio = `W01-${String(this.consecutivo++).padStart(6, "0")}`;
    this.pedidos.set(folio, {
      folio,
      idPedido: pedido.idPedido,
      estatus: "Pendiente",
      confirmado: false,
      lineas: pedido.producto.map((l) => ({ clave: l.clave, cantidad: l.cantidad })),
    });
    return this.respuesta(pedido, folio, "Pendiente", []);
  }

  async confirmarPedido(folio: string): Promise<RespuestaConfirmacionCt> {
    this.simularCaida();
    const pedido = this.pedidos.get(folio);
    if (!pedido) {
      throw new ErrorCt(`El CT simulado no conoce el folio ${folio}`, 410, null, false);
    }

    if (!pedido.confirmado) {
      pedido.confirmado = true;
      pedido.estatus = "Confirmado";
      // Aquí baja el stock: por eso la resincronización posterior sí cambia.
      for (const linea of pedido.lineas) {
        this.vendido.set(linea.clave, (this.vendido.get(linea.clave) ?? 0) + linea.cantidad);
      }
    }

    return {
      okCode: "2000",
      okMessage: "¡Ok, se procesó satisfactoriamente!",
      okReference: "Se ha confirmado el pedido",
    };
  }

  async estatusPedido(folio: string): Promise<EstatusPedidoCt[]> {
    this.simularCaida();
    const pedido = this.pedidos.get(folio);
    if (!pedido) return [];
    return [{ status: pedido.estatus, folio: pedido.folio, uuid: `sim-${pedido.folio}` }];
  }

  async listarPedidos(): Promise<unknown> {
    this.simularCaida();
    return [...this.pedidos.values()].map((p) => ({
      folio: p.folio, idPedido: p.idPedido, estatus: p.estatus,
    }));
  }

  async tipoCambio(): Promise<unknown> {
    this.simularCaida();
    return { fecha: new Date().toISOString(), tipoCambio: 17.5 };
  }

  // --------------------------------------------------------------- interno

  /**
   * Reproduce una conexión cortada: el mismo ErrorCt con httpStatus 0 que
   * produce el cliente real, que es lo que dispara el estado "uncertain".
   */
  private simularCaida(): void {
    if (this.escenario === "caida") {
      throw new ErrorCt(
        "Fallo de red simulado: no se sabe si CT procesó la solicitud",
        0, null, true
      );
    }
  }

  private respuesta(
    pedido: PedidoCt, folio: string, estatus: string, errores: unknown[]
  ): RespuestaPedidoCt {
    return {
      ...pedido,
      respuestaCT: { pedidoWeb: folio, tipoDeCambio: 17.5, estatus, errores },
    };
  }
}
