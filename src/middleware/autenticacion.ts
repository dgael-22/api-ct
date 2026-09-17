/**
 * src/middleware/autenticacion.ts
 * ===============================
 * Clave de administración para los endpoints de gestión (/mappings,
 * /inventory, /orders). Estaban abiertos en internet: cualquiera podía leer
 * órdenes o confirmar un mapeo falso, y un mapeo confirmado es lo que autoriza
 * comprarle a CT.
 *
 * La clave va en la cabecera `x-api-key` (o `Authorization: Bearer <clave>`).
 * Falla cerrado: si ADMIN_API_KEY no está configurada, NO se abre nada.
 *
 * Quedan fuera a propósito: /health (no expone datos) y el webhook de Shopify,
 * que ya valida su propia firma HMAC.
 */
import crypto from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { env, FaltaConfiguracion } from "../config/env";

/** Compara en tiempo constante aunque las longitudes difieran. */
function mismaClave(recibida: string, esperada: string): boolean {
  const a = crypto.createHash("sha256").update(recibida).digest();
  const b = crypto.createHash("sha256").update(esperada).digest();
  return crypto.timingSafeEqual(a, b);
}

export function requerirClaveAdmin(peticion: Request, respuesta: Response, siguiente: NextFunction): void {
  let esperada: string;
  try {
    esperada = env.app.claveAdmin;
  } catch (e) {
    respuesta.status(503).json({
      error: "falta_configuracion",
      variable: e instanceof FaltaConfiguracion ? e.variable : "ADMIN_API_KEY",
      detalle: "Sin clave de administración no se abre ningún endpoint de gestión.",
    });
    return;
  }

  const cabecera = String(peticion.header("x-api-key") ?? "");
  const bearer = String(peticion.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const recibida = cabecera || bearer;

  if (!recibida || !mismaClave(recibida, esperada)) {
    respuesta.status(401).json({
      error: "no_autorizado",
      detalle: "Falta la cabecera x-api-key o no es válida.",
    });
    return;
  }
  siguiente();
}
