import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { cancelVoucher } from "@/lib/voucher-service";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  return handle(async () => json(await cancelVoucher(await requireActor(), (await params).id)));
}
