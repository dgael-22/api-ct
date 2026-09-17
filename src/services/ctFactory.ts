/**
 * src/services/ctFactory.ts
 * =========================
 * Devuelve el cliente de CT que toca según la configuración.
 *
 *   CT_MODO=real       (por omisión)  habla con CT de verdad
 *   CT_MODO=simulado                  usa CtSimulado
 *
 * El modo se decide en UN solo lugar. Ningún servicio pregunta por él.
 */
import { env } from "../config/env";
import { ClienteCt, CtClient } from "./CtClient";
import { CtSimulado } from "./CtSimulado";

/**
 * UNA instancia por proceso. El CT simulado guarda sus pedidos en memoria: con
 * una instancia nueva por llamada, el folio que creaba el webhook no existía
 * para el job de confirmación ni para POST /orders/confirm, y el pedido se
 * quedaba en "sent" hasta vencer. Con el real también conviene: reutiliza el
 * token en vez de pedir uno por petición.
 */
let simulado: CtSimulado | null = null;
let real: CtClient | null = null;

export function crearClienteCt(): ClienteCt {
  if (env.ct.modo === "simulado") return (simulado ??= new CtSimulado());
  return (real ??= new CtClient());
}

/** Sólo para pruebas: olvida las instancias (y lo que el simulado recordaba). */
export function reiniciarClienteCt(): void {
  simulado = null;
  real = null;
}

/** Aviso visible al arrancar, para que nadie confunda datos simulados con reales. */
export function advertirSiSimulado(): void {
  if (env.ct.modo !== "simulado") return;
  console.warn(
    "\n" +
    "  ┌──────────────────────────────────────────────────────────────┐\n" +
    "  │  CT SIMULADO — no se está hablando con CT Online             │\n" +
    `  │  Escenario: ${env.ct.escenarioSimulado.padEnd(48)}│\n` +
    "  │  Los pedidos NO se surten y el stock NO es real.             │\n" +
    "  │  Para apagarlo: CT_MODO=real                                 │\n" +
    "  └──────────────────────────────────────────────────────────────┘\n"
  );
}
