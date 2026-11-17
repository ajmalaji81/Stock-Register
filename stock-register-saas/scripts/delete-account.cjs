// Permanently delete an owner account and ALL its data (items, godowns, bills, parties, staff...).
//   node scripts/delete-account.cjs demo@godownbook.in
// Bills are deleted first because bill lines/parties/godowns are protected (onDelete: Restrict)
// so a plain user delete would be refused.
const { PrismaClient } = require("@prisma/client");
const email = (process.argv[2] || process.env.EMAIL || "").toLowerCase();
if (!email) {
  console.error("Usage: node delete-account.cjs <email>");
  process.exit(1);
}
const prisma = new PrismaClient();
(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return console.log(`No account for ${email}`);
  await prisma.$transaction([
    prisma.voucher.deleteMany({ where: { userId: user.id } }),
    prisma.user.delete({ where: { id: user.id } }),
  ]);
  console.log(`Deleted ${email} and all its data`);
})()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
