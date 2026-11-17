// Seed a demo MOBILE RETAILER account through the public API (all business rules apply).
//
//   node scripts/seed-demo.mjs [baseUrl] [email] [password]
//   node scripts/seed-demo.mjs https://godownbook.ajmalaji.tech demo@godownbook.in 12345678
//
// Safe to re-run only on a fresh account: it refuses if the account already has items.
// Making the account Lifetime Pro is done separately (scripts/make-pro.cjs) because plans
// only change through the payment webhook in the API.

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const EMAIL = process.argv[3] || "demo@godownbook.in";
const PASSWORD = process.argv[4] || "12345678";

const jars = {};
async function api(who, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(jars[who] ? { cookie: jars[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const sc = res.headers.get("set-cookie");
  if (sc) jars[who] = sc.split(";")[0];
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${typeof data === "object" ? data.error : String(data).slice(0, 120)}`);
  return data;
}
const O = (method, path, body) => api("owner", method, path, body);

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const log = (...a) => console.log("•", ...a);

// ---------------------------------------------------------------- account
try {
  await api("owner", "POST", "/api/auth/signup", { name: "Demo Owner", email: EMAIL, password: PASSWORD });
  log("created owner", EMAIL);
} catch (e) {
  if (!String(e.message).includes("409")) throw e;
  await api("owner", "POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  log("owner exists, logged in");
}
let ws = await O("GET", "/api/workspace");
if (ws.items.length > 0) {
  console.log(`Account already has ${ws.items.length} items, not seeding again.`);
  process.exit(0);
}

await O("PUT", "/api/settings", {
  businessName: "Smart Mobiles (Demo)",
  gstin: "33AAACS1234D1Z5",
  address: "12, Ranganathan Street, T. Nagar, Chennai 600017",
  state: "Tamil Nadu",
  phone: "9840012345",
  invoicePrefix: "SM",
  invoiceTerms: "Goods once sold will not be taken back. Warranty as per manufacturer. Subject to Chennai jurisdiction.",
  bankDetails: "Demo Bank, A/c 1234567890, IFSC DEMO0001234",
});
log("business settings");

// ---------------------------------------------------------------- godowns
const main = ws.godowns[0];
await O("PATCH", `/api/godowns/${main.id}`, { name: "Main Showroom" });
for (const name of ["Anna Nagar Branch", "Velachery Branch", "Central Warehouse", "Service Centre"]) {
  await O("POST", "/api/godowns", { name });
}
ws = await O("GET", "/api/workspace");
const G = Object.fromEntries(ws.godowns.map((g) => [g.name, g.id]));
log("godowns:", Object.keys(G).join(", "));

// ---------------------------------------------------------------- items
// [name, sku, category, purchase, sale, minAlert, hsn, opening qty in Central Warehouse]
const ITEMS = [
  ["Samsung Galaxy S24 5G 8/256", "SAM-S24-256", "Smartphones", 64500, 74999, 3, "8517", 12],
  ["Samsung Galaxy A55 5G 8/128", "SAM-A55-128", "Smartphones", 33800, 39999, 4, "8517", 18],
  ["Samsung Galaxy M35 5G 6/128", "SAM-M35-128", "Smartphones", 15200, 17999, 5, "8517", 25],
  ["Apple iPhone 15 128GB", "APL-IP15-128", "Smartphones", 66000, 72900, 3, "8517", 10],
  ["Apple iPhone 15 Pro 256GB", "APL-IP15P-256", "Smartphones", 118000, 129900, 6, "8517", 5],
  ["Apple iPhone 13 128GB", "APL-IP13-128", "Smartphones", 45500, 49900, 6, "8517", 4],
  ["OnePlus 12R 8/128", "OP-12R-128", "Smartphones", 34500, 39999, 3, "8517", 14],
  ["OnePlus Nord CE4 8/128", "OP-CE4-128", "Smartphones", 21300, 24999, 4, "8517", 20],
  ["Xiaomi Redmi Note 13 Pro 8/256", "MI-RN13P-256", "Smartphones", 22400, 25999, 5, "8517", 22],
  ["Xiaomi Redmi 13C 4/128", "MI-R13C-128", "Smartphones", 8300, 9999, 8, "8517", 40],
  ["Vivo V30 5G 8/128", "VIVO-V30-128", "Smartphones", 29600, 33999, 3, "8517", 12],
  ["Vivo Y28 5G 6/128", "VIVO-Y28-128", "Smartphones", 12400, 14499, 6, "8517", 26],
  ["Oppo Reno 11 5G 8/128", "OPPO-R11-128", "Smartphones", 25200, 29999, 3, "8517", 10],
  ["Realme Narzo 70 Pro 8/128", "RLM-N70P-128", "Smartphones", 16300, 18999, 5, "8517", 24],
  ["Nokia 105 Dual SIM", "NOK-105", "Feature phones", 1050, 1299, 15, "8517", 60],
  ["Jio Bharat V2 4G", "JIO-BHV2", "Feature phones", 820, 999, 15, "8517", 45],
  ["Samsung 25W USB-C Charger", "ACC-SAM-25W", "Chargers", 820, 1299, 20, "8504", 80],
  ["Apple 20W USB-C Power Adapter", "ACC-APL-20W", "Chargers", 1350, 1900, 15, "8504", 50],
  ["boAt 33W Dual Port Charger", "ACC-BOAT-33W", "Chargers", 480, 799, 20, "8504", 70],
  ["USB-C to USB-C Cable 1m", "ACC-CBL-CC1", "Cables", 120, 299, 40, "8544", 200],
  ["Lightning to USB-C Cable 1m", "ACC-CBL-LC1", "Cables", 260, 599, 30, "8544", 120],
  ["boAt Airdopes 141 TWS", "ACC-BOAT-141", "Audio", 860, 1299, 15, "8518", 60],
  ["Samsung Galaxy Buds FE", "ACC-SAM-BFE", "Audio", 5200, 6999, 16, "8518", 15],
  ["Wired Earphones 3.5mm", "ACC-EAR-35", "Audio", 95, 249, 30, "8518", 150],
  ["Mi 10000mAh Power Bank", "ACC-MI-PB10K", "Power banks", 1050, 1499, 10, "8507", 40],
  ["Tempered Glass (assorted models)", "ACC-TG-ASSORT", "Screen guards", 22, 149, 100, "7007", 600],
  ["Silicone Back Cover (assorted)", "ACC-CASE-SIL", "Cases & covers", 45, 249, 80, "3926", 400],
  ["Flip Cover Premium (assorted)", "ACC-CASE-FLIP", "Cases & covers", 120, 449, 40, "4202", 150],
  ["SanDisk 128GB microSD", "ACC-SD-128", "Memory cards", 780, 1099, 10, "8523", 35],
  ["Display Replacement (service part)", "SRV-DISP-GEN", "Service parts", 1800, 3500, 12, "8517", 12],
];
for (const [name, sku, category, purchasePrice, salePrice, minStockAlert, hsn, openingQty] of ITEMS) {
  await O("POST", "/api/items", {
    name, sku, category, unit: "pcs", purchasePrice, salePrice, minStockAlert, hsn,
    gstRate: hsn === "4202" ? 12 : 18,
    openingQty, openingGodownId: G["Central Warehouse"],
  });
}
ws = await O("GET", "/api/workspace");
const I = Object.fromEntries(ws.items.map((i) => [i.sku, i]));
log(`${ws.items.length} items with opening stock in Central Warehouse`);

// ---------------------------------------------------------------- distribute stock to shops
const shopShare = { "Main Showroom": 0.35, "Anna Nagar Branch": 0.2, "Velachery Branch": 0.15 };
for (const [, sku, category, , , , , openingQty] of ITEMS) {
  if (category === "Service parts") {
    await O("POST", "/api/transfers", { itemId: I[sku].id, fromGodownId: G["Central Warehouse"], toGodownId: G["Service Centre"], qty: 8, date: day(-9), remarks: "Service stock" });
    continue;
  }
  for (const [shop, share] of Object.entries(shopShare)) {
    const qty = Math.max(1, Math.floor(openingQty * share));
    await O("POST", "/api/transfers", { itemId: I[sku].id, fromGodownId: G["Central Warehouse"], toGodownId: G[shop], qty, date: day(-9), remarks: "Stock allocation" });
  }
}
log("stock distributed to showroom, branches and service centre");

// ---------------------------------------------------------------- parties
const PARTIES = [
  { name: "Sri Balaji Mobile Distributors", type: "SUPPLIER", phone: "9840100001", gstin: "33AABFS1111K1Z2", state: "Tamil Nadu", address: "Ritchie Street, Chennai", openingBalance: -45000 },
  { name: "Galaxy Telecom Wholesale", type: "SUPPLIER", phone: "9845200002", gstin: "29AACCG2222L1Z9", state: "Karnataka", address: "SP Road, Bengaluru", openingBalance: 0 },
  { name: "Accessory Hub Traders", type: "SUPPLIER", phone: "9840300003", gstin: "33AAHFA3333M1Z4", state: "Tamil Nadu", address: "Parrys Corner, Chennai", openingBalance: -8200 },
  { name: "Metro Cellular Point", type: "CUSTOMER", phone: "9884400004", gstin: "33AAKFM4444N1Z1", state: "Tamil Nadu", address: "Tambaram, Chennai", openingBalance: 12500 },
  { name: "Kerala Mobile World", type: "CUSTOMER", phone: "9447500005", gstin: "32AAPFK5555P1Z7", state: "Kerala", address: "MG Road, Kochi", openingBalance: 0 },
  { name: "Karthik Raman", type: "CUSTOMER", phone: "9790600006", state: "Tamil Nadu", openingBalance: 0 },
  { name: "Priya Shankar", type: "CUSTOMER", phone: "9600700007", state: "Tamil Nadu", openingBalance: 0 },
  { name: "Arun Prakash", type: "CUSTOMER", phone: "9500800008", state: "Tamil Nadu", openingBalance: 2500 },
  { name: "TechFix Corporate Services", type: "BOTH", phone: "9840900009", gstin: "33AACCT9999Q1Z3", state: "Tamil Nadu", address: "OMR, Chennai", openingBalance: 0 },
];
const P = {};
for (const p of PARTIES) P[p.name] = (await O("POST", "/api/parties", { email: "", gstin: "", address: "", ...p })).id;
log(`${PARTIES.length} parties (suppliers + customers, incl. Karnataka & Kerala for IGST)`);

// ---------------------------------------------------------------- vouchers
const line = (sku, qty, rate, discountPct = 0) => ({ itemId: I[sku].id, qty, rate: rate ?? I[sku].purchasePrice, discountPct, taxRate: I[sku].gstRate, description: "" });
const sale = (sku, qty, discountPct = 0) => ({ itemId: I[sku].id, qty, rate: Math.round(I[sku].salePrice / 1.18), discountPct, taxRate: I[sku].gstRate, description: "" });
const V = (body) => O("POST", "/api/vouchers", { gstEnabled: true, placeOfSupply: "", notes: "", paidNow: 0, paymentMode: "CASH", ...body });

// Purchases (stock IN)
await V({ kind: "PURCHASE", date: day(-8), partyId: P["Sri Balaji Mobile Distributors"], godownId: G["Main Showroom"], lines: [line("SAM-A55-128", 5), line("SAM-M35-128", 8), line("MI-RN13P-256", 6)], notes: "Bill SBD/2231", paidNow: 100000, paymentMode: "BANK" });
await V({ kind: "PURCHASE", date: day(-7), partyId: P["Galaxy Telecom Wholesale"], godownId: G["Central Warehouse"], lines: [line("APL-IP15-128", 4), line("OP-12R-128", 5), line("VIVO-V30-128", 4)], notes: "Inter-state purchase (IGST)" });
await V({ kind: "PURCHASE", date: day(-6), partyId: P["Accessory Hub Traders"], godownId: G["Main Showroom"], lines: [line("ACC-TG-ASSORT", 200), line("ACC-CASE-SIL", 150), line("ACC-CBL-CC1", 60), line("ACC-BOAT-141", 20)], paidNow: 5000, paymentMode: "UPI" });
log("3 purchase bills");

// Sales (stock OUT) — walk-in cash sales, retail customers, B2B, inter-state B2B
await V({ kind: "SALE", date: day(-5), partyId: null, godownId: G["Main Showroom"], lines: [sale("SAM-M35-128", 1), sale("ACC-TG-ASSORT", 1), sale("ACC-CASE-SIL", 1)], notes: "Walk-in" });
await V({ kind: "SALE", date: day(-5), partyId: P["Karthik Raman"], godownId: G["Main Showroom"], lines: [sale("APL-IP15-128", 1), sale("ACC-APL-20W", 1), sale("ACC-CBL-LC1", 1)], paidNow: 75000, paymentMode: "UPI" });
await V({ kind: "SALE", date: day(-4), partyId: P["Priya Shankar"], godownId: G["Anna Nagar Branch"], lines: [sale("SAM-A55-128", 1, 5), sale("ACC-CASE-FLIP", 1), sale("ACC-TG-ASSORT", 1)], paidNow: 20000, paymentMode: "CASH" });
await V({ kind: "SALE", date: day(-4), partyId: P["Metro Cellular Point"], godownId: G["Main Showroom"], lines: [sale("MI-R13C-128", 6, 4), sale("NOK-105", 10, 5), sale("ACC-EAR-35", 20, 10)], notes: "B2B dealer order" });
await V({ kind: "SALE", date: day(-3), partyId: P["Kerala Mobile World"], godownId: G["Central Warehouse"], lines: [sale("VIVO-Y28-128", 5, 3), sale("RLM-N70P-128", 4, 3), sale("ACC-MI-PB10K", 6)], notes: "Inter-state B2B (IGST)" });
await V({ kind: "SALE", date: day(-2), partyId: null, godownId: G["Velachery Branch"], lines: [sale("OP-CE4-128", 1), sale("ACC-BOAT-33W", 1)], paidNow: 0 });
await V({ kind: "SALE", date: day(-1), partyId: P["Arun Prakash"], godownId: G["Anna Nagar Branch"], lines: [sale("SAM-S24-256", 1, 2), sale("ACC-SAM-BFE", 1)], paidNow: 50000, paymentMode: "BANK" });
await V({ kind: "SALE", date: day(0), partyId: null, godownId: G["Main Showroom"], lines: [sale("JIO-BHV2", 2), sale("ACC-SD-128", 1), sale("ACC-TG-ASSORT", 3)] });
await V({ kind: "SALE", date: day(0), partyId: P["TechFix Corporate Services"], godownId: G["Main Showroom"], lines: [sale("SAM-M35-128", 4, 6), sale("ACC-SAM-25W", 4)], notes: "Corporate order — 4 staff phones" });
await V({ kind: "SALE", date: day(0), partyId: null, godownId: G["Service Centre"], lines: [sale("SRV-DISP-GEN", 1)], notes: "Screen replacement job #S-104" });
log("10 sales bills (cash, retail, B2B, inter-state)");

// Sale return
await V({ kind: "SALE_RETURN", date: day(-1), partyId: P["Metro Cellular Point"], godownId: G["Main Showroom"], lines: [sale("ACC-EAR-35", 4, 10)], notes: "Defective earphones returned" });
log("1 sales return");

// Quotation → sales order (stock moves only when it becomes a sale)
const qt = await V({ kind: "QUOTATION", date: day(-2), partyId: P["TechFix Corporate Services"], godownId: G["Main Showroom"], lines: [sale("OP-12R-128", 10, 8), sale("ACC-CASE-SIL", 10)], notes: "Bulk quote for 10 phones" });
await O("POST", `/api/vouchers/${qt.id}/convert`, { to: "SALES_ORDER", date: day(-1) });
await V({ kind: "QUOTATION", date: day(0), partyId: P["Priya Shankar"], godownId: G["Anna Nagar Branch"], lines: [sale("APL-IP15P-256", 1)], notes: "Upgrade enquiry" });
// Delivery challan (goods out on approval) and a purchase order
await V({ kind: "CHALLAN", date: day(-1), partyId: P["Metro Cellular Point"], godownId: G["Central Warehouse"], lines: [sale("MI-R13C-128", 5)], notes: "Sent on approval" });
await V({ kind: "PURCHASE_ORDER", date: day(0), partyId: P["Sri Balaji Mobile Distributors"], godownId: G["Central Warehouse"], lines: [line("APL-IP13-128", 6), line("SAM-S24-256", 4)], notes: "Restock low iPhone 13 / S24" });
log("quotations, sales order, challan, purchase order");

// ---------------------------------------------------------------- payments & expenses
await O("POST", "/api/payments", { partyId: P["Sri Balaji Mobile Distributors"], direction: "OUT", amount: 45000, mode: "BANK", date: day(-3), reference: "NEFT 88213", notes: "Old balance cleared" });
await O("POST", "/api/payments", { partyId: P["Metro Cellular Point"], direction: "IN", amount: 30000, mode: "UPI", date: day(-1), reference: "UPI 4471", notes: "" });
await O("POST", "/api/payments", { partyId: P["Kerala Mobile World"], direction: "IN", amount: 50000, mode: "BANK", date: day(0), reference: "RTGS 1902", notes: "Part payment" });
for (const [category, amount, mode, d, notes] of [
  ["Rent", 45000, "BANK", -8, "Showroom rent"],
  ["Salary", 62000, "BANK", -7, "Staff salaries"],
  ["Electricity", 6400, "UPI", -5, "EB bill"],
  ["Transport", 1200, "CASH", -3, "Courier to Kochi"],
  ["Packaging", 850, "CASH", -1, "Carry bags"],
]) {
  await O("POST", "/api/expenses", { category, amount, mode, date: day(d), notes });
}
log("3 payments, 5 expenses");

// ---------------------------------------------------------------- adjustment
await O("POST", "/api/adjustments", { itemId: I["ACC-TG-ASSORT"].id, godownId: G["Main Showroom"], delta: -6, reason: "Damaged", note: "Cracked while fitting", date: day(-2) });
log("1 stock adjustment (damaged screen guards)");

// ---------------------------------------------------------------- staff (needs Pro or trial)
for (const s of [
  { name: "Ravi (Sales)", email: EMAIL.replace("@", "+sales@"), role: "SALES", godownIds: [G["Main Showroom"]] },
  { name: "Meena (Store Admin)", email: EMAIL.replace("@", "+admin@"), role: "STORE_ADMIN", godownIds: [] },
]) {
  await O("POST", "/api/staff", { ...s, password: PASSWORD });
  log(`staff ${s.email} (${s.role})`);
}

ws = await O("GET", "/api/workspace");
const low = ws.items.filter((i) => i.minStockAlert > 0 && Object.values(i.stock).reduce((a, b) => a + b, 0) <= i.minStockAlert);
console.log(`\nDone: ${ws.godowns.length} godowns, ${ws.items.length} items, ${low.length} low-stock items.`);
