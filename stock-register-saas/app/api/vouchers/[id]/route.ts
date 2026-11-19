import { requireActor } from "@/lib/actor";
import { StockError } from "@/lib/engine";
import { handle, json } from "@/lib/http";
import { voucherEditSchema } from "@/lib/voucher-schemas";
import { editVoucher, getVoucher } from "@/lib/voucher-service";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return handle(async () => json(await getVoucher(await requireActor(), (await params).id)));
}

/** Edit a saved sales invoice. Owner only (403 for every staff role). */
export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const actor = await requireActor();
    if (!actor.isOwner) throw new StockError("Only the owner can edit invoices.", 403, "FORBIDDEN");
    return json(await editVoucher(actor, (await params).id, voucherEditSchema.parse(await req.json())));
  });
}
