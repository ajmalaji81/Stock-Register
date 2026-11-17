import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { getVoucher } from "@/lib/voucher-service";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return handle(async () => json(await getVoucher(await requireActor(), (await params).id)));
}
