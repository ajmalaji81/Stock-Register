import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { startSession } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { signupSchema } from "@/lib/schemas";
import { StockError } from "@/lib/engine";
import { trialEndFrom } from "@/lib/plans";

export async function POST(req: Request) {
  return handle(async () => {
    const { name, email, password } = signupSchema.parse(await req.json());
    if (await prisma.user.findUnique({ where: { email } }))
      throw new StockError("An account with this email already exists. Log in instead.", 409);
    if (await prisma.staffMember.findUnique({ where: { email } }))
      throw new StockError("This email is used by a staff login. Log in with it, or sign up with a different email.", 409);
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: await bcrypt.hash(password, 12),
        trialEndsAt: trialEndFrom(new Date()),
        godowns: { create: { name: "Main Shop" } },
      },
    });
    await startSession(user.id);
    return json({ ok: true }, 201);
  });
}
