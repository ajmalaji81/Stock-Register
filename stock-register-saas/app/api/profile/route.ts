import { z } from "zod";
import { requireActor } from "@/lib/actor";
import { logActivity } from "@/lib/activity";
import { avatarError } from "@/lib/avatar";
import { prisma } from "@/lib/db";
import { StockError } from "@/lib/engine";
import { handle, json } from "@/lib/http";

const profileSchema = z.object({
  /** data: URL of the new picture, or null to remove it. */
  avatar: z.string().nullable(),
});

/** The signed-in person's own profile (owner or staff). */
export async function GET() {
  return handle(async () => {
    const a = await requireActor();
    return json({ name: a.name, email: a.email, role: a.role, avatar: a.avatar });
  });
}

/** Set or remove your own profile picture. Anyone signed in may change their own. */
export async function PATCH(req: Request) {
  return handle(async () => {
    const a = await requireActor();
    const { avatar } = profileSchema.parse(await req.json());
    if (avatar !== null) {
      const err = avatarError(avatar);
      if (err) throw new StockError(err, 400);
    }
    if (a.isOwner) await prisma.user.update({ where: { id: a.actorId }, data: { avatar } });
    else await prisma.staffMember.update({ where: { id: a.actorId }, data: { avatar } });
    await logActivity(prisma, a, "profile.update", avatar ? "New profile picture" : "Removed profile picture");
    return json({ ok: true, avatar });
  });
}
