import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { voucherCreateSchema, voucherListSchema } from "@/lib/voucher-schemas";
import { createVoucher, listVouchers } from "@/lib/voucher-service";

// GET: list bills/documents the actor may see. Filters: kind (comma-separated), partyId, status, from, to, q.
export async function GET(req: Request) {
  return handle(async () => {
    const actor = await requireActor();
    const params = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
    return json(await listVouchers(actor, voucherListSchema.parse(params)));
  });
}

// POST: create a bill/document. Permission depends on kind (checked in the service).
export async function POST(req: Request) {
  return handle(async () => {
    const actor = await requireActor();
    return json(await createVoucher(actor, voucherCreateSchema.parse(await req.json())), 201);
  });
}
