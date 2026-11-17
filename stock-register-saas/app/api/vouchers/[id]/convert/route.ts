import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import type { VoucherKind } from "@/lib/gst";
import { voucherConvertSchema } from "@/lib/voucher-schemas";
import { convertVoucher } from "@/lib/voucher-service";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  return handle(async () => {
    const actor = await requireActor();
    const { to, date } = voucherConvertSchema.parse(await req.json());
    return json(await convertVoucher(actor, (await params).id, to as VoucherKind, date), 201);
  });
}
