/**
 * src/entities/Evento.ts
 * ======================
 * Bitácora. Railway borra los logs a los 7 días (plan Hobby); lo que importa
 * para reconstruir qué pasó con una orden se guarda aquí, sin límite práctico.
 *
 * Nunca guarda secretos: ni cabeceras, ni tokens, ni el cuerpo de la petición.
 */
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type NivelEvento = "info" | "aviso" | "error";

@Entity({ name: "bitacora" })
export class Evento {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @CreateDateColumn()
  fecha!: Date;

  @Column({ type: "varchar" })
  nivel!: NivelEvento;

  /** Qué pasó, en una palabra: webhook_recibido, orden_procesada, acceso_rechazado… */
  @Index()
  @Column({ type: "varchar" })
  tipo!: string;

  @Index()
  @Column({ type: "varchar", nullable: true })
  shopifyOrderId!: string | null;

  @Column({ type: "text" })
  mensaje!: string;

  @Column({ type: "text", nullable: true })
  detalle!: string | null;
}
