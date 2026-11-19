import { redirect } from "next/navigation";
import { currentActor } from "@/lib/actor";
import { StockError } from "@/lib/engine";
import { amountInWords, KIND_LABEL, PAYMENT_MODE_LABEL, r2 } from "@/lib/gst";
import { getSharedVoucher, getVoucher, profileOf, type BusinessProfile, type VoucherDTO } from "@/lib/voucher-service";
import PrintBar from "@/components/invoice/PrintBar";

export const metadata = { title: "Invoice — GodownBook", robots: { index: false } };

type Format = "a4" | "t58" | "t80";
type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ format?: string; t?: string }> };

const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rs = (n: number) => `₹${inr.format(n)}`;
const num = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });

function title(v: VoucherDTO): string {
  if (v.kind === "SALE") return v.gstEnabled ? "TAX INVOICE" : "BILL OF SUPPLY";
  return KIND_LABEL[v.kind].toUpperCase();
}

export default async function PrintVoucherPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const format: Format = sp.format === "t58" || sp.format === "t80" ? sp.format : "a4";

  let voucher: VoucherDTO;
  let profile: BusinessProfile;
  if (sp.t) {
    const shared = await getSharedVoucher(id, sp.t);
    if (!shared) return <NotFound />;
    ({ voucher, profile } = shared);
  } else {
    const actor = await currentActor();
    if (!actor) redirect(`/login`);
    try {
      voucher = await getVoucher(actor, id);
    } catch (e) {
      if (e instanceof StockError) return <NotFound />;
      throw e;
    }
    profile = profileOf(actor.owner);
  }

  return (
    <div className="min-h-full bg-surface print:bg-white">
      <PrintBar id={id} format={format} token={sp.t} />
      {format === "a4" ? <A4 v={voucher} p={profile} /> : <Thermal v={voucher} p={profile} width={format === "t58" ? 58 : 80} />}
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-full items-center justify-center p-8 text-center">
      <div>
        <h1 className="text-2xl font-bold">Invoice not found</h1>
        <p className="mt-2 text-ink/70">The link may be wrong, or you don&apos;t have access to it.</p>
      </div>
    </div>
  );
}

function Cancelled({ v }: { v: VoucherDTO }) {
  if (v.status !== "CANCELLED") return null;
  return <div className="my-2 border-2 border-out py-1 text-center font-bold tracking-widest text-out">CANCELLED</div>;
}

function taxBreakup(v: VoucherDTO) {
  const m = new Map<number, { rate: number; taxable: number; tax: number }>();
  for (const l of v.lines ?? []) {
    const e = m.get(l.taxRate) ?? { rate: l.taxRate, taxable: 0, tax: 0 };
    e.taxable += l.taxable;
    e.tax += l.tax;
    m.set(l.taxRate, e);
  }
  return [...m.values()].sort((a, b) => a.rate - b.rate).map((e) => ({ ...e, taxable: r2(e.taxable), tax: r2(e.tax) }));
}

function A4({ v, p }: { v: VoucherDTO; p: BusinessProfile }) {
  const lines = v.lines ?? [];
  const showDisc = lines.some((l) => l.discountAmt > 0 || l.discountPct > 0);
  const breakup = v.gstEnabled ? taxBreakup(v) : [];
  return (
    <>
      <style>{`@page { size: A4; margin: 12mm; }`}</style>
      <article className="mx-auto my-6 w-full max-w-[210mm] bg-white p-6 text-[13px] leading-snug text-black shadow-[0_10px_40px_-15px_rgb(0_0_0/0.35)] sm:p-10 print:my-0 print:max-w-none print:p-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-black pb-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">{p.businessName || "Your business name"}</h1>
            {p.address && <p className="whitespace-pre-line">{p.address}</p>}
            <p>
              {p.state && <>State: {p.state} · </>}
              {p.phone && <>Ph: {p.phone}</>}
            </p>
            {p.gstin && <p className="font-semibold">GSTIN: {p.gstin}</p>}
          </div>
          <div className="text-right">
            <div className="text-lg font-bold tracking-wide">{title(v)}</div>
            <div>No: <b>{v.number}</b></div>
            <div>Date: <b>{v.date}</b></div>
            {v.sourceNumber && <div>Ref: {v.sourceNumber}</div>}
          </div>
        </header>
        <Cancelled v={v} />

        <section className="grid gap-4 border-b border-black/30 py-3 sm:grid-cols-2">
          <div>
            <div className="text-xs font-bold uppercase text-black/60">{v.kind.startsWith("PURCHASE") ? "Supplier" : "Bill to"}</div>
            <div className="font-bold">{v.partyName}</div>
            {v.partyAddress && <div className="whitespace-pre-line">{v.partyAddress}</div>}
            {v.partyPhone && <div>Ph: {v.partyPhone}</div>}
            {v.partyGstin && <div>GSTIN: {v.partyGstin}</div>}
            {v.partyState && <div>State: {v.partyState}</div>}
          </div>
          {v.gstEnabled && (
            <div className="sm:text-right">
              <div className="text-xs font-bold uppercase text-black/60">Place of supply</div>
              <div>{v.placeOfSupply || "—"}</div>
              <div className="text-xs text-black/60">{v.interState ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)"}</div>
            </div>
          )}
        </section>

        <table className="mt-3 w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-y-2 border-black text-left">
              <th className="py-1.5 pr-2">#</th>
              <th className="py-1.5 pr-2">Item</th>
              <th className="py-1.5 pr-2">HSN</th>
              <th className="py-1.5 pr-2 text-right">Qty</th>
              <th className="py-1.5 pr-2 text-right">Rate</th>
              {showDisc && <th className="py-1.5 pr-2 text-right">Disc</th>}
              <th className="py-1.5 pr-2 text-right">Taxable</th>
              {v.gstEnabled && <th className="py-1.5 pr-2 text-right">GST</th>}
              <th className="py-1.5 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id} className="border-b border-black/15 align-top">
                <td className="py-1.5 pr-2">{i + 1}</td>
                <td className="py-1.5 pr-2">{l.itemName}{l.description && <div className="text-black/60">{l.description}</div>}</td>
                <td className="py-1.5 pr-2">{l.hsn}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{num.format(l.qty)} {l.unit}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{inr.format(l.rate)}</td>
                {showDisc && (
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {l.discountAmt > 0 ? (
                      <>
                        {inr.format(l.discountAmt)}
                        <div className="text-black/60">{pct(l.discountPct)}</div>
                      </>
                    ) : (
                      ""
                    )}
                  </td>
                )}
                <td className="py-1.5 pr-2 text-right tabular-nums">{inr.format(l.taxable)}</td>
                {v.gstEnabled && <td className="py-1.5 pr-2 text-right tabular-nums">{l.taxRate}%<div className="text-black/60">{inr.format(l.tax)}</div></td>}
                <td className="py-1.5 text-right font-semibold tabular-nums">{inr.format(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto]">
          <div className="space-y-3">
            <div>
              <div className="text-xs font-bold uppercase text-black/60">Amount in words</div>
              <div className="font-semibold">{amountInWords(v.total)}</div>
            </div>
            {breakup.length > 0 && (
              <table className="text-[11px]">
                <thead>
                  <tr className="border-b border-black text-left">
                    <th className="pr-4">GST %</th>
                    <th className="pr-4 text-right">Taxable</th>
                    {v.interState ? <th className="pr-4 text-right">IGST</th> : <><th className="pr-4 text-right">CGST</th><th className="pr-4 text-right">SGST</th></>}
                  </tr>
                </thead>
                <tbody>
                  {breakup.map((b) => (
                    <tr key={b.rate}>
                      <td className="pr-4">{b.rate}%</td>
                      <td className="pr-4 text-right tabular-nums">{inr.format(b.taxable)}</td>
                      {v.interState ? (
                        <td className="pr-4 text-right tabular-nums">{inr.format(b.tax)}</td>
                      ) : (
                        <>
                          <td className="pr-4 text-right tabular-nums">{inr.format(r2(b.tax / 2))}</td>
                          <td className="pr-4 text-right tabular-nums">{inr.format(r2(b.tax - r2(b.tax / 2)))}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {v.notes && <p><b>Notes:</b> {v.notes}</p>}
          </div>
          <dl className="min-w-[220px] space-y-1 tabular-nums">
            <Tot label="Taxable value" value={rs(v.subtotal)} />
            {v.discount > 0 && <Tot label="Discount (incl. above)" value={rs(v.discount)} />}
            {v.gstEnabled && (v.interState ? <Tot label="IGST" value={rs(v.igst)} /> : <><Tot label="CGST" value={rs(v.cgst)} /><Tot label="SGST" value={rs(v.sgst)} /></>)}
            {v.roundOff !== 0 && <Tot label="Round off" value={rs(v.roundOff)} />}
            <div className="flex justify-between gap-6 border-y-2 border-black py-1 text-base font-bold"><dt>Total</dt><dd>{rs(v.total)}</dd></div>
            {v.paid > 0 && <><Tot label="Paid" value={rs(v.paid)} /><Tot label="Balance due" value={rs(v.balanceDue)} /></>}
          </dl>
        </section>
        <PaymentDetails v={v} />

        <footer className="mt-6 grid gap-4 border-t border-black/30 pt-3 sm:grid-cols-2">
          <div className="space-y-2 text-[12px]">
            {p.bankDetails && <div><div className="font-bold">Bank details</div><div className="whitespace-pre-line">{p.bankDetails}</div></div>}
            {p.invoiceTerms && <div><div className="font-bold">Terms &amp; conditions</div><div className="whitespace-pre-line">{p.invoiceTerms}</div></div>}
          </div>
          <div className="self-end text-right">
            <div className="mb-10">For <b>{p.businessName || "the business"}</b></div>
            <div className="text-xs">Authorised signatory</div>
          </div>
        </footer>
        <Prepared v={v} className="mt-4 text-[11px] text-black/60" />
        <p className="mt-4 text-center text-[10px] text-black/40">Made with GodownBook</p>
      </article>
    </>
  );
}

/** Who prepared (and last edited) the bill. Names only, never emails. */
function Prepared({ v, className = "" }: { v: VoucherDTO; className?: string }) {
  const at = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
  if (!v.createdBy && !v.updatedAt) return null;
  return (
    <div className={className}>
      {v.createdBy && <div>Prepared by {v.createdBy} · {at(v.createdAt)}</div>}
      {v.updatedAt && <div>Last edited by {v.updatedBy || "owner"} · {at(v.updatedAt)}</div>}
    </div>
  );
}

const pct = (n: number) => `${Number(n.toFixed(2))}%`;

/** How the customer paid (split payment), incl. finance details. A4 only; thermal has a compact copy. */
function PaymentDetails({ v }: { v: VoucherDTO }) {
  if (v.payments.length === 0) return null;
  return (
    <section className="mt-4 border-t border-black/30 pt-3">
      <div className="text-xs font-bold uppercase text-black/60">Payment details</div>
      <table className="mt-1 w-full max-w-[520px] text-[12px]">
        <tbody>
          {v.payments.map((p) => (
            <tr key={p.id} className="border-b border-black/10 align-top">
              <td className="py-1 pr-3 font-semibold">{PAYMENT_MODE_LABEL[p.mode] ?? p.mode}</td>
              <td className="py-1 pr-3">
                {p.mode === "FINANCE" ? (
                  <>
                    <div>
                      <b>{p.financier}</b> · Disbursement amount {rs(p.amount)}
                    </div>
                    <div className="text-black/70">Payment info: {p.paymentInfo || "—"}</div>
                    <div className="text-black/70">Scheme: {p.scheme || "—"}</div>
                  </>
                ) : (
                  <span className="text-black/70">{p.reference}</span>
                )}
              </td>
              <td className="py-1 text-right tabular-nums">{rs(p.amount)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="py-1 pr-3">Total paid</td>
            <td />
            <td className="py-1 text-right tabular-nums">{rs(v.paidAtBilling)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function Tot({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-6">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Thermal({ v, p, width }: { v: VoucherDTO; p: BusinessProfile; width: 58 | 80 }) {
  const lines = v.lines ?? [];
  const small = width === 58;
  return (
    <>
      <style>{`@page { size: ${width}mm auto; margin: 2mm; }`}</style>
      <article
        className={`mx-auto my-6 bg-white p-3 font-mono leading-tight text-black shadow-[0_10px_40px_-15px_rgb(0_0_0/0.35)] print:my-0 print:p-0 print:shadow-none ${small ? "text-[10px]" : "text-[11.5px]"}`}
        style={{ width: `${width - 4}mm` }}
      >
        <div className="text-center">
          <div className={`font-bold ${small ? "text-[12px]" : "text-[14px]"}`}>{p.businessName || "Your business"}</div>
          {p.address && <div className="whitespace-pre-line">{p.address}</div>}
          {p.phone && <div>Ph: {p.phone}</div>}
          {p.gstin && <div>GSTIN: {p.gstin}</div>}
          <div className="mt-1 font-bold">{title(v)}</div>
        </div>
        <Cancelled v={v} />
        <div className="my-1 border-y border-dashed border-black py-1">
          <div className="flex justify-between"><span>No: {v.number}</span><span>{v.date}</span></div>
          <div>To: {v.partyName}</div>
          {v.partyGstin && <div>GSTIN: {v.partyGstin}</div>}
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-dashed border-black text-left">
              <th>Item</th>
              <th className="text-right">Qty</th>
              {!small && <th className="text-right">Rate</th>}
              <th className="text-right">Amt</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="align-top">
                <td className="pr-1">
                  {l.itemName}
                  {v.gstEnabled && l.taxRate ? <span> ({l.taxRate}%)</span> : null}
                  {l.discountAmt > 0 ? <div>Disc -{inr.format(l.discountAmt)} ({pct(l.discountPct)})</div> : null}
                </td>
                <td className="text-right">{num.format(l.qty)}</td>
                {!small && <td className="text-right">{inr.format(l.rate)}</td>}
                <td className="text-right">{inr.format(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-1 space-y-0.5 border-t border-dashed border-black pt-1">
          <Tot label="Taxable" value={inr.format(v.subtotal)} />
          {v.gstEnabled && (v.interState ? <Tot label="IGST" value={inr.format(v.igst)} /> : <><Tot label="CGST" value={inr.format(v.cgst)} /><Tot label="SGST" value={inr.format(v.sgst)} /></>)}
          {v.roundOff !== 0 && <Tot label="Round off" value={inr.format(v.roundOff)} />}
          <div className={`flex justify-between border-y border-black py-0.5 font-bold ${small ? "text-[12px]" : "text-[14px]"}`}><dt>TOTAL</dt><dd>{rs(v.total)}</dd></div>
          {v.discount > 0 && <Tot label="You saved" value={inr.format(v.discount)} />}
          {v.paid > 0 && <><Tot label="Paid" value={inr.format(v.paid)} /><Tot label="Balance due" value={inr.format(v.balanceDue)} /></>}
        </dl>
        {v.payments.length > 0 && (
          <div className="mt-1 border-t border-dashed border-black pt-1">
            {v.payments.map((p) => (
              <div key={p.id}>
                <div className="flex justify-between">
                  <span>{p.mode === "FINANCE" ? `Finance: ${p.financier}` : `${PAYMENT_MODE_LABEL[p.mode] ?? p.mode}${p.reference ? ` ${p.reference}` : ""}`}</span>
                  <span>{inr.format(p.amount)}</span>
                </div>
                {p.mode === "FINANCE" && (
                  <div>
                    Disb. {inr.format(p.amount)} · Ref {p.paymentInfo} · {p.scheme}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mt-1">{amountInWords(v.total)}</div>
        {p.invoiceTerms && <div className="mt-1 whitespace-pre-line border-t border-dashed border-black pt-1">{p.invoiceTerms}</div>}
        <Prepared v={v} className="mt-1 border-t border-dashed border-black pt-1" />
        <div className="mt-2 text-center">Thank you! Visit again.</div>
      </article>
    </>
  );
}
