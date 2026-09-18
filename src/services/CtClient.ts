/**
 * src/services/CtClient.ts
 * ========================
 * Cliente del API-CONNECT de CT Online.
 * Contrato tomado de la documentación pública: https://api.ctonline.mx/documentacion.html
 *
 *   POST /cliente/token          { email, cliente, rfc } -> { token, time }
 *   GET  /existencia/:codigo     -> { "01A": { existencia: n }, ... }
 *   GET  /existencia/detalle/:codigo/:almacen
 *   GET  /existencia/promociones[/:codigo]
 *   POST /pedido                 -> respuestaCT.pedidoWeb (folio)
 *   POST /pedido/confirmar       { folio }   ventana de 48 h
 *   GET  /pedido/estatus/:folio
 *   GET  /pedido/listar
 *
 *   GET  /existencia/:codigo/TOTAL -> { existencia_total: n }
 *
 * Todas las llamadas van con el header `x-auth`. Si CT_PROXY_KEY está, además
 * llevan `x-proxy-key`: salen por el proxy con IP fija, que la valida y la quita.
 *
 * Sin librería HTTP: fetch nativo, como recomienda la sección 7 del ETS.
 */
import { env } from "../config/env";

/** Respuesta de POST /cliente/token */
export interface RespuestaToken {
  token: string;
  time: string;
}

/** GET /existencia/:codigo — una llave por almacén */
export type ExistenciaPorAlmacen = Record<string, { existencia: number }>;

/** GET /existencia/:codigo/TOTAL */
export interface ExistenciaTotal {
  existencia_total: number;
}

/** GET /existencia/detalle/:codigo/:almacen */
export interface DetalleExistencia {
  precio: number;
  moneda: string;
  tipoCambio: number;
  existencia: number;
  promocion?: unknown;
  codigoSAT?: number;
}

export interface EnvioCt {
  nombre: string;
  direccion: string;
  entreCalles: string;
  noExterior: string;
  noInterior: string;
  colonia: string;
  estado: string;
  ciudad: string;
  codigoPostal: number;
  telefono: number;
}

export interface LineaPedidoCt {
  cantidad: number;
  clave: string;
  precio: number;
  moneda: string;
}

/** Body de POST /pedido */
export interface PedidoCt {
  /** Referencia numérica nuestra: la llave de idempotencia. */
  idPedido: number;
  almacen: string;
  tipoPago: string;
  cfdi: string;
  envio: EnvioCt[];
  producto: LineaPedidoCt[];
}

export interface RespuestaPedidoCt extends PedidoCt {
  respuestaCT: {
    pedidoWeb: string;
    tipoDeCambio: number;
    estatus: string;
    errores: unknown[];
  };
}

export interface RespuestaConfirmacionCt {
  okCode: string;
  okMessage: string;
  okReference: string;
}

export interface EstatusPedidoCt {
  status: string;
  folio: string;
  uuid: string;
}

/**
 * Error normalizado. `reintentable` distingue lo que sí se puede repetir.
 * `sinEnviar` marca los fallos ocurridos ANTES de que la petición saliera
 * (por ejemplo, no se pudo obtener el token): ahí no hay nada incierto.
 */
export class ErrorCt extends Error {
  constructor(
    mensaje: string,
    public readonly httpStatus: number,
    public readonly cuerpo: unknown,
    public readonly reintentable: boolean,
    public readonly sinEnviar: boolean = false
  ) {
    super(mensaje);
    this.name = "ErrorCt";
  }
}

interface OpcionesPeticion {
  metodo?: "GET" | "POST";
  cuerpo?: unknown;
  requiereToken?: boolean;
  /** 0 para operaciones NO idempotentes (crear pedido). */
  reintentos?: number;
  timeoutMs?: number;
}

/**
 * Lo que los servicios necesitan de CT. La implementación real (CtClient) y la
 * simulada (CtSimulado) cumplen este mismo contrato, así que el resto del
 * middleware no sabe —ni debe saber— contra cuál está hablando.
 */
export interface ClienteCt {
  obtenerToken(forzar?: boolean): Promise<string>;
  existenciaPorAlmacen(codigo: string): Promise<ExistenciaPorAlmacen>;
  existenciaTotal(codigo: string): Promise<ExistenciaTotal>;
  detalle(codigo: string, almacen: string): Promise<DetalleExistencia[]>;
  catalogoCompleto(): Promise<unknown[]>;
  crearPedido(pedido: PedidoCt): Promise<RespuestaPedidoCt>;
  confirmarPedido(folio: string): Promise<RespuestaConfirmacionCt>;
  estatusPedido(folio: string): Promise<EstatusPedidoCt[]>;
  listarPedidos(): Promise<unknown>;
  tipoCambio(): Promise<unknown>;
  /** true cuando NO se está hablando con CT de verdad. */
  readonly simulado: boolean;
}

/**
 * CT permite 100 peticiones por minuto. El limitador las cuenta y espera lo
 * necesario antes de pasarse, en vez de que CT responda 429 a media compra.
 * Es por proceso, que es como corre el middleware (una instancia de CtClient).
 */
class LimitePorMinuto {
  private marcas: number[] = [];

  constructor(private readonly maximo: number) {}

  async esperarTurno(): Promise<void> {
    if (!(this.maximo > 0)) return;
    for (;;) {
      const hace60s = Date.now() - 60_000;
      this.marcas = this.marcas.filter((m) => m > hace60s);
      if (this.marcas.length < this.maximo) {
        this.marcas.push(Date.now());
        return;
      }
      // La más vieja dice cuándo se libera un lugar.
      const espera = this.marcas[0] - hace60s;
      await new Promise((r) => setTimeout(r, Math.max(espera, 50)));
    }
  }
}

export class CtClient implements ClienteCt {
  /** Este sí habla con CT. */
  readonly simulado = false;

  private readonly limite = new LimitePorMinuto(env.ct.limitePorMinuto);

  private token: string | null = null;
  private tokenExpiraEn = 0;

  constructor(private readonly baseUrl: string = env.ct.baseUrl) {
    // Si ya viene un token emitido en la configuración, se usa ése.
    const preexistente = env.ct.accessToken;
    if (preexistente) {
      this.token = preexistente;
      this.tokenExpiraEn = Number.MAX_SAFE_INTEGER;
    }
  }

  // ------------------------------------------------------------------ token

  async obtenerToken(forzar = false): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiraEn && !forzar) return this.token;

    const respuesta = await this.peticion<RespuestaToken>("/cliente/token", {
      metodo: "POST",
      cuerpo: { email: env.ct.email, cliente: env.ct.cliente, rfc: env.ct.rfc },
      requiereToken: false,
      reintentos: 2,
    });

    if (!respuesta?.token) {
      throw new ErrorCt("CT no devolvió token en /cliente/token", 0, respuesta, false);
    }
    this.token = respuesta.token;
    // CT (17 sep 2026): el token se genera cada 24 h. Se renueva una hora
    // antes de vencer, y de todos modos ante un 401.
    this.tokenExpiraEn = Date.now() + 23 * 60 * 60 * 1000;
    return this.token;
  }

  // ------------------------------------------------------------ existencias

  /** RF-02. Existencia del artículo en todos los almacenes. */
  existenciaPorAlmacen(codigo: string): Promise<ExistenciaPorAlmacen> {
    return this.peticion(`/existencia/${encodeURIComponent(codigo)}`, { reintentos: 2 });
  }

  existenciaTotal(codigo: string): Promise<ExistenciaTotal> {
    return this.peticion(`/existencia/${encodeURIComponent(codigo)}/TOTAL`, { reintentos: 2 });
  }

  detalle(codigo: string, almacen: string): Promise<DetalleExistencia[]> {
    return this.peticion(
      `/existencia/detalle/${encodeURIComponent(codigo)}/${encodeURIComponent(almacen)}`,
      { reintentos: 2 }
    );
  }

  catalogoCompleto(): Promise<unknown[]> {
    return this.peticion("/existencia/promociones", { reintentos: 1, timeoutMs: 180_000 });
  }

  // ----------------------------------------------------------------- pedido

  /**
   * RF-04. Crea el pedido en CT. `reintentos: 0` a propósito: si la conexión
   * se corta NO sabemos si CT lo procesó, y repetir duplica la compra.
   * Quien llama debe consultar /pedido/listar antes de intentar otra vez.
   */
  crearPedido(pedido: PedidoCt): Promise<RespuestaPedidoCt> {
    return this.peticion("/pedido", {
      metodo: "POST", cuerpo: pedido, reintentos: 0, timeoutMs: 60_000,
    });
  }

  /** Segundo paso: CT cancela solo el pedido que no se confirma en 48 h. */
  confirmarPedido(folio: string): Promise<RespuestaConfirmacionCt> {
    return this.peticion("/pedido/confirmar", {
      metodo: "POST", cuerpo: { folio }, reintentos: 1, timeoutMs: 60_000,
    });
  }

  estatusPedido(folio: string): Promise<EstatusPedidoCt[]> {
    return this.peticion(`/pedido/estatus/${encodeURIComponent(folio)}`, { reintentos: 2 });
  }

  listarPedidos(): Promise<unknown> {
    return this.peticion("/pedido/listar", { reintentos: 2 });
  }

  tipoCambio(): Promise<unknown> {
    return this.peticion("/pedido/tipoCambio", { reintentos: 2 });
  }

  // ---------------------------------------------------------------- interno

  private async peticion<T>(ruta: string, opciones: OpcionesPeticion = {}): Promise<T> {
    const {
      metodo = "GET", cuerpo, requiereToken = true,
      reintentos = 1, timeoutMs = 30_000,
    } = opciones;

    let intento = 0;
    let renovadoPor401 = false;

    for (;;) {
      await this.limite.esperarTurno();
      const cabeceras: Record<string, string> = { "Content-Type": "application/json" };
      if (requiereToken) cabeceras["x-auth"] = await this.tokenAntesDeEnviar();
      if (env.ct.proxyKey) cabeceras["x-proxy-key"] = env.ct.proxyKey;

      const abortador = new AbortController();
      const temporizador = setTimeout(() => abortador.abort(), timeoutMs);

      try {
        const respuesta = await fetch(`${this.baseUrl}${ruta}`, {
          method: metodo,
          headers: cabeceras,
          body: cuerpo ? JSON.stringify(cuerpo) : undefined,
          signal: abortador.signal,
        });

        const texto = await respuesta.text();
        const datos = texto ? this.parsear(texto) : null;

        if (respuesta.ok) return datos as T;

        // 401: token vencido. Se renueva UNA vez y se reintenta.
        if (respuesta.status === 401 && requiereToken && !renovadoPor401) {
          renovadoPor401 = true;
          this.token = null;
          // CT respondió 401: no procesó nada. Si renovar falla, sigue sin enviarse.
          await this.tokenAntesDeEnviar(true);
          continue;
        }

        const reintentable = respuesta.status >= 500;   // 503 = mantenimiento de CT
        const error = new ErrorCt(
          `CT respondió ${respuesta.status} en ${metodo} ${ruta}`,
          respuesta.status, datos ?? texto, reintentable
        );
        if (reintentable && intento < reintentos) {
          intento++;
          await this.esperar(this.retroceso(intento));
          continue;
        }
        throw error;
      } catch (e) {
        if (e instanceof ErrorCt) throw e;
        // Red o timeout: no sabemos si CT lo procesó.
        const error = new ErrorCt(
          `Fallo de red o timeout en ${metodo} ${ruta}: ${(e as Error).message}`,
          0, null, true
        );
        if (intento < reintentos) {
          intento++;
          await this.esperar(this.retroceso(intento));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(temporizador);
      }
    }
  }

  /** El token, marcando cualquier fallo como "la petición no salió". */
  private async tokenAntesDeEnviar(forzar = false): Promise<string> {
    try {
      return await this.obtenerToken(forzar);
    } catch (e) {
      const base = e instanceof ErrorCt ? e : null;
      throw new ErrorCt(
        `No se obtuvo token de CT, la petición no se envió: ${(e as Error).message}`,
        base?.httpStatus ?? 0, base?.cuerpo ?? null, base?.reintentable ?? true, true
      );
    }
  }

  private parsear(texto: string): unknown {
    try { return JSON.parse(texto); } catch { return texto; }
  }

  private retroceso(intento: number): number {
    return Math.min(1000 * 2 ** (intento - 1), 8000);
  }

  private esperar(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
