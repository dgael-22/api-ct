/**
 * src/services/bitacora.ts
 * ========================
 * Escribe en la tabla `bitacora`. Dos reglas:
 *
 *   1. NUNCA rompe el flujo: si la base no está lista (pruebas, arranque) o la
 *      escritura falla, el evento sólo sale por consola.
 *   2. NUNCA recibe secretos. Quien llama pasa textos ya limpios.
 */
import type { Request } from "express";
import { LessThan } from "typeorm";
import { AppDataSource } from "../data-source";
import { Evento, NivelEvento } from "../entities/Evento";

const MAXIMO_DETALLE = 4000;

export interface DatosEvento {
  nivel?: NivelEvento;
  tipo: string;
  mensaje: string;
  shopifyOrderId?: string | null;
  detalle?: unknown;
}

function comoTexto(detalle: unknown): string | null {
  if (detalle === undefined || detalle === null || detalle === "") return null;
  const texto = typeof detalle === "string" ? detalle : JSON.stringify(detalle);
  return texto.length > MAXIMO_DETALLE ? `${texto.slice(0, MAXIMO_DETALLE)}…` : texto;
}

/**
 * IP de quien hizo la petición. Detrás del proxy de Railway `peticion.ip` es
 * la interna (100.64.x.x); la real llega en X-Real-IP. Sólo sirve para la
 * bitácora: no se usa para autorizar nada.
 */
export function ipCliente(peticion: Request): string {
  return String(peticion.header("x-real-ip") ?? "").trim() || peticion.ip || "desconocida";
}

export async function registrarEvento(datos: DatosEvento): Promise<void> {
  const nivel = datos.nivel ?? "info";
  if (!AppDataSource.isInitialized) return;
  try {
    const repo = AppDataSource.getRepository(Evento);
    await repo.save(repo.create({
      nivel,
      tipo: datos.tipo,
      mensaje: datos.mensaje,
      shopifyOrderId: datos.shopifyOrderId ?? null,
      detalle: comoTexto(datos.detalle),
    }));
  } catch (e) {
    console.error(`[bitacora] no se pudo guardar "${datos.tipo}":`, (e as Error).message);
  }
}

/** Borra los eventos más viejos que `dias`. Devuelve cuántos borró. */
export async function depurarBitacora(dias: number): Promise<number> {
  if (!AppDataSource.isInitialized || !(dias > 0)) return 0;
  const limite = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  const resultado = await AppDataSource.getRepository(Evento).delete({ fecha: LessThan(limite) });
  return resultado.affected ?? 0;
}
