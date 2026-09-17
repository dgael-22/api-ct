/**
 * src/entities/OrderMapping.ts
 * ============================
 * RF-05. Relación entre la orden comercial de Shopify y el pedido de CT.
 *
 * Campos según la sección 5 del ETS, más lo que exige la tercera detención
 * indispensable: cuando la respuesta de CT es incierta (timeout, conexión
 * cortada) el estado queda en "uncertain" y NADIE reintenta a ciegas, porque
 * reintentar sin verificar duplica la compra.
 */
import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from "typeorm";
import { TIPO_FECHA } from "./tipos";

export type EstadoOrden =
  | "received"    // llegó el webhook
  | "blocked"     // detenida ANTES de llegar a CT (sin mapeo, sin token): se puede reintentar
  | "sent"        // se creó el pedido en CT, falta confirmarlo
  | "accepted"    // CT lo confirmó: la compra quedó en firme
  | "rejected"    // CT lo rechazó
  | "expired"     // se pasó la ventana de confirmación y CT lo canceló
  | "uncertain";  // no sabemos: revisar en CT antes de reintentar

@Entity({ name: "order_mapping" })
export class OrderMapping {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index({ unique: true })
  @Column({ type: "varchar" })
  shopifyOrderId!: string;

  /** Nombre visible de la orden, ej. "#1054". */
  @Column({ type: "varchar", nullable: true })
  shopifyOrderName!: string | null;

  /** Folio que devuelve CT. Nulo mientras no haya respuesta. */
  @Index()
  @Column({ type: "varchar", nullable: true })
  ctOrderId!: string | null;

  /** Estatus tal como lo devolvió CT, sin interpretarlo. */
  @Column({ type: "varchar", nullable: true })
  ctStatus!: string | null;

  @Column({ type: "varchar", default: "received" })
  status!: EstadoOrden;

  /**
   * Referencia externa que viaja a CT (campo `idPedido`). Se calcula ANTES de
   * llamar y se guarda: es la llave de idempotencia que evita el pedido doble.
   */
  @Index({ unique: true })
  @Column({ type: "integer", nullable: true })
  externalReference!: number | null;

  /** Momento en que CT creó el pedido: de aquí corre la ventana de confirmación. */
  @Column({ type: TIPO_FECHA, nullable: true })
  sentAt!: Date | null;

  /**
   * sentAt + HORAS_PARA_CONFIRMAR. Pasada esta fecha CT cancela el pedido solo,
   * así que confirmar no es opcional ni puede quedar para después.
   */
  @Column({ type: TIPO_FECHA, nullable: true })
  confirmDeadline!: Date | null;

  @Column({ type: TIPO_FECHA, nullable: true })
  confirmedAt!: Date | null;

  @Column({ type: "integer", default: 0 })
  confirmAttempts!: number;

  /** Copia del payload enviado, para auditoría. */
  @Column({ type: "text", nullable: true })
  requestPayload!: string | null;

  /** Última respuesta o error de CT, tal cual. */
  @Column({ type: "text", nullable: true })
  lastResponse!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
