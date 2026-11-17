// Mark an account as Lifetime Pro directly in the database (for demo / support use).
//   node scripts/make-pro.cjs demo@godownbook.in
// Inside the Docker container:  docker exec -e EMAIL=demo@godownbook.in godownbook-app node /app/make-pro.cjs
const { PrismaClient } = require("@prisma/client");
const email = (process.argv[2] || process.env.EMAIL || "").toLowerCase();
if (!email) {
  console.error("Usage: node make-pro.cjs <email>");
  process.exit(1);
}
const prisma = new PrismaClient();
prisma.user
  .update({ where: { email }, data: { plan: "PRO", proSince: new Date() } })
  .then((u) => console.log(`${u.email} is now Lifetime Pro`))
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
