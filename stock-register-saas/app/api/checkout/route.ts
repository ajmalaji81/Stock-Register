import { requirePermission } from "@/lib/actor";
import { appUrl, dodoClient } from "@/lib/dodo";
import { handle, json } from "@/lib/http";
import { countryFromHeaders, priceFor } from "@/lib/ppp";
import { StockError } from "@/lib/engine";

type CheckoutParams = Parameters<ReturnType<typeof dodoClient>["checkoutSessions"]["create"]>[0];

/** Starts a Dodo one-time checkout for Lifetime Pro, priced for the visitor's country. */
export async function POST(req: Request) {
  return handle(async () => {
    const actor = await requirePermission("billing.upgrade");
    const user = actor.owner;
    if (user.plan === "PRO") throw new StockError("You already have Lifetime Pro", 400);
    const productId = process.env.DODO_PRODUCT_ID;
    if (!productId) throw new Error("DODO_PRODUCT_ID is not set");

    const price = priceFor(countryFromHeaders(req.headers));
    const params: CheckoutParams = {
      // `amount` sets the price for a Pay-What-You-Want product (our PPP price).
      // If the product isn't PWYW, Dodo ignores it and charges the product's fixed price.
      product_cart: [{ product_id: productId, quantity: 1, amount: price.amountCents }],
      customer: { email: user.email, name: user.name },
      return_url: `${appUrl()}/upgrade/success`,
      cancel_url: `${appUrl()}/app`,
      metadata: {
        userId: user.id,
        pppCountry: price.country ?? "",
        pppAmountCents: String(price.amountCents),
      },
    };
    // Pre-filling the country lets Dodo's adaptive pricing show the local currency.
    if (price.country) params.billing_address = { country: price.country as NonNullable<CheckoutParams["billing_address"]>["country"] };

    const session = await dodoClient().checkoutSessions.create(params);
    if (!session.checkout_url) throw new Error("Dodo did not return a checkout URL");
    return json({ url: session.checkout_url });
  });
}
