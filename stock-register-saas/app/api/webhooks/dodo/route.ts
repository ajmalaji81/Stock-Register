import { Webhook } from "standardwebhooks";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { json } from "@/lib/http";

interface DodoEvent {
  type: string;
  data: {
    payment_id?: string;
    total_amount?: number;
    currency?: string;
    status?: string | null;
    metadata?: Record<string, string>;
    customer?: { email?: string };
    product_cart?: { product_id: string; quantity: number }[] | null;
  };
}

/**
 * Dodo Payments webhook. Verifies the Standard Webhooks signature, then on
 * `payment.succeeded` for our Lifetime product upgrades the buyer to PRO.
 * Safe to receive the same event twice.
 */
export async function POST(req: Request) {
  const secret = process.env.DODO_WEBHOOK_SECRET;
  if (!secret) {
    console.error("DODO_WEBHOOK_SECRET is not set");
    return json({ error: "Webhook not configured" }, 500);
  }

  const raw = await req.text();
  const headers = {
    "webhook-id": req.headers.get("webhook-id") ?? "",
    "webhook-signature": req.headers.get("webhook-signature") ?? "",
    "webhook-timestamp": req.headers.get("webhook-timestamp") ?? "",
  };

  let event: DodoEvent;
  try {
    event = new Webhook(secret).verify(raw, headers) as DodoEvent;
  } catch {
    return json({ error: "Invalid signature" }, 401);
  }

  if (event.type !== "payment.succeeded") return json({ received: true });

  const p = event.data;
  const productId = process.env.DODO_PRODUCT_ID;
  const cart = p.product_cart ?? [];
  if (productId && cart.length > 0 && !cart.some((c) => c.product_id === productId)) {
    return json({ received: true, ignored: "other product" });
  }
  if (!p.payment_id) return json({ error: "Missing payment_id" }, 400);

  const user =
    (p.metadata?.userId && (await prisma.user.findUnique({ where: { id: p.metadata.userId } }))) ||
    (p.customer?.email && (await prisma.user.findUnique({ where: { email: p.customer.email.toLowerCase() } }))) ||
    null;
  if (!user) {
    // Acknowledge so Dodo stops retrying; the payment is visible in the Dodo dashboard for manual handling.
    console.error(`Dodo payment ${p.payment_id}: no matching user`);
    return json({ received: true, ignored: "no user" });
  }

  try {
    await prisma.$transaction([
      prisma.webhookEvent.create({ data: { id: headers["webhook-id"], type: event.type } }),
      prisma.payment.upsert({
        where: { dodoPaymentId: p.payment_id },
        create: {
          userId: user.id,
          dodoPaymentId: p.payment_id,
          status: "succeeded",
          amount: p.total_amount ?? 0,
          currency: p.currency ?? "",
        },
        update: { status: "succeeded" },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { plan: "PRO", proSince: user.proSince ?? new Date() },
      }),
    ]);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return json({ received: true, duplicate: true });
    }
    console.error(err);
    return json({ error: "Failed to process" }, 500); // Dodo will retry
  }

  return json({ received: true });
}
