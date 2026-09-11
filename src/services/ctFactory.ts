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

export function crearClienteCt(): ClienteCt {
  return env.ct.modo === "simulado" ? new CtSimulado() : new CtClient();
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
