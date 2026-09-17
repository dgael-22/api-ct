/**
 * src/config/env.ts
 * =================
 * Carga y valida las variables de entorno de la sección 11.1 del ETS.
 *
 * Regla: ningún valor real vive en el código. Todo sale de .env, que no entra
 * a Git. Las variables se leen de forma perezosa (getters), para que la API
 * arranque aunque falte configuración: sólo truena el endpoint que de verdad
 * necesita esa credencial, con un mensaje que dice cuál falta.
 */
import * as dotenv from "dotenv";

dotenv.config();

export class FaltaConfiguracion extends Error {
  constructor(public readonly variable: string) {
    super(
      `Falta la variable de entorno ${variable}. Cópiala de .env.example a .env ` +
        `y ponle el valor real.`
    );
    this.name = "FaltaConfiguracion";
  }
}

function requerida(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor || valor === "replace_me") throw new FaltaConfiguracion(nombre);
  return valor;
}

function opcional(nombre: string, porDefecto: string): string {
  const valor = process.env[nombre];
  return valor && valor !== "replace_me" ? valor : porDefecto;
}

/** ¿Está configurada? Sirve para que /health informe sin tronar. */
export function estaDefinida(nombre: string): boolean {
  const valor = process.env[nombre];
  return Boolean(valor && valor !== "replace_me");
}

export const env = {
  app: {
    /** Railway inyecta PORT; en local sale del .env o 3000. */
    get puerto(): number { return Number(opcional("PORT", "3000")); },
    /**
     * URL pública del servicio. En Railway no hace falta escribirla: la
     * plataforma expone RAILWAY_PUBLIC_DOMAIN y de ahí se arma.
     */
    get baseUrl(): string {
      const propia = opcional("APP_BASE_URL", "");
      if (propia) return propia.replace(/\/$/, "");
      const railway = opcional("RAILWAY_PUBLIC_DOMAIN", "");
      return railway ? `https://${railway}` : "";
    },
    get entorno(): string { return opcional("NODE_ENV", "development"); },
    /** Clave de los endpoints de gestión (cabecera x-api-key). Sin ella no se abren. */
    get claveAdmin(): string { return requerida("ADMIN_API_KEY"); },
    /**
     * Minutos entre confirmaciones automáticas de pedidos. 0 = apagado.
     * En Railway conviene 15: CT cancela solo lo que no se confirma en 48 h,
     * y ahí no hay nadie corriendo el comando a mano.
     */
    get minutosConfirmacion(): number {
      return Number(opcional("CONFIRM_INTERVAL_MINUTES", "0"));
    },
  },

  shopify: {
    get dominio(): string { return requerida("SHOPIFY_SHOP_DOMAIN"); },
    get clientId(): string { return requerida("SHOPIFY_CLIENT_ID"); },
    get clientSecret(): string { return requerida("SHOPIFY_CLIENT_SECRET"); },
    get apiVersion(): string { return opcional("SHOPIFY_API_VERSION", "2025-07"); },
    /**
     * Token permanente de una app vieja creada en el admin (`shpat_...`).
     * Opcional: las apps del Dev Dashboard ya no dan uno — ahí el token se
     * pide con client credentials y dura 24 h.
     */
    get tokenFijo(): string { return opcional("SHOPIFY_ACCESS_TOKEN", ""); },
    get webhookSecret(): string { return requerida("SHOPIFY_WEBHOOK_SECRET"); },
    get locationId(): string { return requerida("SHOPIFY_LOCATION_ID"); },
  },

  ct: {
    get baseUrl(): string {
      return opcional("CT_BASE_URL", "https://api.ctonline.mx").replace(/\/$/, "");
    },
    /**
     * "real" habla con CT; "simulado" usa CtSimulado, para probar el circuito
     * completo sin esperar a que CT autorice la integración.
     */
    get modo(): string { return opcional("CT_MODO", "real").toLowerCase(); },
    /** Sólo en modo simulado: ok | sin_stock | rechazo | caida */
    get escenarioSimulado(): string {
      return opcional("CT_SIMULADO_ESCENARIO", "ok").toLowerCase();
    },
    /** Token ya emitido. Si no está, CtClient lo pide con email/cliente/rfc. */
    get accessToken(): string { return opcional("CT_ACCESS_TOKEN", ""); },
    get email(): string { return requerida("CT_EMAIL"); },
    get cliente(): string { return requerida("CT_CLIENTE"); },
    get rfc(): string { return requerida("CT_RFC"); },
    get almacen(): string { return requerida("CT_ALMACEN"); },
  },

  db: {
    /** sqlite:./data/schu-ct.sqlite  |  postgresql://... */
    get url(): string { return opcional("DATABASE_URL", "sqlite:./data/schu-ct.sqlite"); },
    /**
     * SSL hacia PostgreSQL. En Railway, por la red interna
     * (`postgres.railway.internal`) va en false; por la URL pública, en true.
     */
    get ssl(): boolean {
      return opcional("DB_SSL", "false").toLowerCase() === "true";
    },
  },
};
