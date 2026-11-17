import Link from "next/link";
import { headers } from "next/headers";
import { currentUser } from "@/lib/auth";
import { countryFromHeaders, priceFor } from "@/lib/ppp";
import { effectivePlan, trialDaysLeft } from "@/lib/plans";
import Logo from "@/components/Logo";
import Pricing from "@/components/Pricing";
import UpgradeButton from "@/components/UpgradeButton";

export const metadata = { title: "Upgrade — GodownBook" };

export default async function UpgradePage() {
  const [user, h] = await Promise.all([currentUser(), headers()]);
  const price = priceFor(countryFromHeaders(h));
  const plan = user ? effectivePlan(user) : null;

  return (
    <div className="bg-dots min-h-full px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between">
          <Logo href={user ? "/app" : "/"} />
          <Link href={user ? "/app" : "/"} className="text-sm font-semibold underline">← Back</Link>
        </div>
        {user?.plan === "PRO" ? (
          <div className="card-3d pop-in p-8 text-center">
            <h1 className="text-2xl font-bold text-in">You have Lifetime Pro ✓</h1>
            <p className="mt-2">Unlimited items and godowns are unlocked on your account.</p>
            <Link href="/app" className="btn-3d btn-edge-ink mt-5 inline-block rounded-xl bg-ink px-4 py-2 font-semibold text-paper">Open my book</Link>
          </div>
        ) : (
          <>
            {plan === "TRIAL" && (
              <p className="card-3d mb-4 inline-block border-in/40 px-3 py-2 text-sm font-semibold text-in">
                Your free Pro trial has {trialDaysLeft(user?.trialEndsAt ?? null)} days left. Buy Lifetime Pro to keep unlimited items and godowns after it ends.
              </p>
            )}
            {plan === "FREE" && user?.trialEndsAt && (
              <p className="card-3d mb-4 inline-block border-low/40 px-3 py-2 text-sm font-semibold text-low">
                Your 90-day Pro trial has ended. Your data is safe; new items and godowns are limited to the Free plan.
              </p>
            )}
            <h1 className="mb-2 text-3xl font-bold tracking-tight">Unlock unlimited stock, once and for all.</h1>
            <p className="mb-8 text-ink/70">One payment. No monthly fees. Secure checkout by Dodo Payments.</p>
            <Pricing
              price={price}
              freeCta={
                <Link href={user ? "/app" : "/signup"} className="btn-3d btn-edge-ghost mb-1 block rounded-xl border-2 border-ink bg-paper py-2.5 text-center font-semibold">
                  {user ? "Stay on Free" : "Start free"}
                </Link>
              }
              proCta={
                user ? (
                  <UpgradeButton label="Get Lifetime Pro" />
                ) : (
                  <Link href="/signup" className="btn-3d btn-edge-in mb-1 block rounded-xl bg-brand py-3 text-center font-bold text-ink">Sign up to upgrade</Link>
                )
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
