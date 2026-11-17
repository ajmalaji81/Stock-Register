import { redirect } from "next/navigation";
import { currentActor } from "@/lib/actor";
import { roleLabel } from "@/lib/permissions";
import AppShell from "@/components/AppShell";

export const metadata = { title: "My Register — GodownBook" };

export default async function AppPage() {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  // Staff see their own name in the header; the business is still the owner's.
  return (
    <AppShell
      name={actor.isOwner ? actor.name : `${actor.name} · ${actor.owner.businessName || actor.owner.name}`}
      email={actor.email}
      roleLabel={roleLabel(actor.role)}
      avatar={actor.avatar}
    />
  );
}
