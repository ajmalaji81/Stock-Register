import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { reversePayment } from "@/lib/party-service";

type Ctx = { params: Promise<{ id: string }> };

/** Payments are immutable; this records an equal and opposite payment. Needs payments.manage. */
export async function POST(_req: Request, { params }: Ctx) {
  return handle(async () => json(await reversePayment(await requireActor(), (await params).id), 201));
}
