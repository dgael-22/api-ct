/**
 * src/entities/ProductMapping.ts
 * ==============================
 * RF-01. Relación APROBADA entre la variante de Shopify y el producto de CT.
 *
 * Campos según la sección 5 del ETS. La regla que importa: un mapeo sólo se
 * usa para sincronizar o vender cuando `status` es "confirmed". Que el SKU
 * exista en los dos lados no basta — el caso "ABC-16GB" que en CT es de 8 GB
 * es justamente el error que esta tabla evita.
 */
import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from "typeorm";

export type EstadoMapeo = "confirmed" | "pending" | "conflict";

/**
 * El ID de variante llega de dos formas: "gid://shopify/ProductVariant/123"
 * (exportaciones y GraphQL) y "123" (webhook). Se guarda y se busca siempre
 * como el número, para que las dos coincidan.
 */
export function normalizarVariante(id: string | number | null | undefined): string {
  const texto = String(id ?? "").trim();
  return texto.match(/(\d+)$/)?.[1] ?? texto;
}

@Entity({ name: "product_mapping" })
export class ProductMapping {
  @PrimaryGeneratedColumn()
  id!: number;

  // ---- lado Shopify ----
  @Index({ unique: true })
  @Column({ type: "varchar" })
  shopifyVariantId!: string;

  @Column({ type: "varchar", nullable: true })
  inventoryItemId!: string | null;

  @Column({ type: "varchar", nullable: true })
  locationId!: string | null;

  @Index()
  @Column({ type: "varchar" })
  shopifySku!: string;

  // ---- lado CT ----
  @Column({ type: "varchar", nullable: true })
  ctProductId!: string | null;

  @Index()
  @Column({ type: "varchar" })
  ctSku!: string;

  /** Número de parte del fabricante: el dato que confirma que es el mismo artículo. */
  @Column({ type: "varchar", nullable: true })
  partNumber!: string | null;

  // ---- estado del mapeo ----
  @Column({ type: "varchar", default: "pending" })
  status!: EstadoMapeo;

  /** Por qué quedó pendiente o en conflicto. */
  @Column({ type: "text", nullable: true })
  reason!: string | null;

  /** La confirmación es humana, nunca automática. */
  @Column({ type: "varchar", nullable: true })
  confirmedBy!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
