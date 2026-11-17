import { requireActor } from "@/lib/actor";
import { handle, json } from "@/lib/http";
import { paymentQuerySchema, paymentSchema } from "@/lib/party-schemas";
import { createPayment, listPayments } from "@/lib/party-service";

export async function GET(req: Request) {
  return handle(async () => {
    const q = paymentQuerySchema.parse(Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== "")));
    return json(await listPayments(await requireActor(), q));
  });
}

export async function POST(req: Request) {
  return handle(async () => json(await createPayment(await requireActor(), paymentSchema.parse(await req.json())), 201));
}
