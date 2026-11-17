import { z } from "zod";
import { requirePermission } from "@/lib/actor";
import { logActivity } from "@/lib/activity";
import { prisma } from "@/lib/db";
import { StockError } from "@/lib/engine";
import { handle, json } from "@/lib/http";
import { limitsFor } from "@/lib/plans";
import { itemSchema } from "@/lib/schemas";
import { createItem } from "@/lib/stock-service";

const bodySchema = z.object({
  rows: z
    .array(
      z.object({
        name: z.string(),
        sku: z.string(),
        category: z.string().default(""),
        unit: z.string().default("pcs"),
        purchasePrice: z.coerce.number().default(0),
        salePrice: z.coerce.number().default(0),
        minStockAlert: z.coerce.number().default(0),
        hsn: z.string().default(""),
        gstRate: z.coerce.number().default(0),
        openingQty: z.coerce.number().default(0),
        openingGodown: z.string().default(""),
        line: z.number().int().optional(),
      }),
    )
    .min(1, "Nothing to import")
    .max(2000, "Import at most 2000 rows at a time"),
});

/** Bulk-create items. Each row is its own transaction; returns a result per row. */
export async function POST(req: Request) {
  return handle(async () => {
    const actor = await requirePermission("items.manage");
    const { rows } = bodySchema.parse(await req.json());
    const godowns = await prisma.godown.findMany({ where: { userId: actor.accountId }, select: { id: true, name: true } });
    const byName = new Map(godowns.map((g) => [g.name.toLowerCase(), g.id]));
    const max = limitsFor(actor.owner).maxItems;
    let count = await prisma.item.count({ where: { userId: actor.accountId } });

    const results: { line: number; ok: boolean; error?: string }[] = [];
    let created = 0;
    for (const [i, r] of rows.entries()) {
      const line = r.line ?? i + 2;
      try {
        if (max !== null && count >= max)
          throw new StockError(`Free plan is limited to ${max} items. Get Lifetime Pro for unlimited items.`, 402, "LIMIT");
        let openingGodownId: string | undefined;
        if (r.openingQty > 0) {
          openingGodownId = r.openingGodown ? byName.get(r.openingGodown.trim().toLowerCase()) : godowns[0]?.id;
          if (!openingGodownId) throw new StockError(`Godown "${r.openingGodown}" not found`);
        }
        const input = itemSchema.parse({ ...r, openingGodownId, openingQty: r.openingQty || undefined });
        await createItem(actor, input);
        count++;
        created++;
        results.push({ line, ok: true });
      } catch (e) {
        const msg =
          e instanceof z.ZodError
            ? e.issues[0]?.message ?? "Invalid row"
            : (e as { code?: string }).code === "P2002"
              ? `SKU "${r.sku}" already exists`
              : e instanceof StockError
                ? e.message
                : "Couldn't import this row";
        if (!(e instanceof StockError) && !(e instanceof z.ZodError) && (e as { code?: string }).code !== "P2002") console.error(e);
        results.push({ line, ok: false, error: msg });
      }
    }
    if (created > 0) await logActivity(prisma, actor, "item.import", `${created} items imported`);
    return json({ created, failed: results.length - created, results });
  });
}
