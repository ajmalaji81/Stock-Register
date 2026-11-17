import { actorInfo, currentActor } from "@/lib/actor";
import { json } from "@/lib/http";

export async function GET() {
  const a = await currentActor();
  if (!a) return json({ user: null }, 401);
  return json({ user: { name: a.owner.name, email: a.owner.email, plan: a.owner.plan }, actor: actorInfo(a) });
}
