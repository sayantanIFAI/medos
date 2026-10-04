import { Decimal } from "@medos/shared";

/** Pure billing arithmetic. All money is Decimal (never JS floats); rounding is half-up to 2 decimal places. */

const D = (v: Decimal.Value) => new Decimal(v);
export const round2 = (v: Decimal.Value): Decimal => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export interface LineInput { quantity: Decimal.Value; unitPrice: Decimal.Value; discountAmount?: Decimal.Value; taxPercent: Decimal.Value }
export interface LineAmounts { gross: Decimal; discount: Decimal; net: Decimal; tax: Decimal; total: Decimal }

export function computeLine(l: LineInput): LineAmounts {
  const gross = round2(D(l.quantity).times(D(l.unitPrice)));
  const discount = round2(l.discountAmount ?? 0);
  if (discount.isNegative()) throw new RangeError("Discount cannot be negative");
  if (discount.gt(gross)) throw new RangeError("Discount cannot exceed the line amount");
  const net = gross.minus(discount);
  const tax = round2(net.times(D(l.taxPercent)).div(100));
  return { gross, discount, net, tax, total: net.plus(tax) };
}

export interface Totals { subtotal: Decimal; discountTotal: Decimal; taxTotal: Decimal; total: Decimal }

export function computeTotals(lines: LineAmounts[]): Totals {
  let subtotal = D(0);
  let discountTotal = D(0);
  let taxTotal = D(0);
  for (const l of lines) {
    subtotal = subtotal.plus(l.gross);
    discountTotal = discountTotal.plus(l.discount);
    taxTotal = taxTotal.plus(l.tax);
  }
  return { subtotal, discountTotal, taxTotal, total: subtotal.minus(discountTotal).plus(taxTotal) };
}

export interface MoneyState { total: Decimal.Value; paidTotal: Decimal.Value; refundedTotal: Decimal.Value; creditedTotal: Decimal.Value }

/** What the invoice is worth after credit notes. */
export const effectiveTotal = (s: MoneyState): Decimal => D(s.total).minus(D(s.creditedTotal));
/** Money actually retained (received minus refunded). */
export const netReceived = (s: MoneyState): Decimal => D(s.paidTotal).minus(D(s.refundedTotal));
/** Amount still owed; never negative. */
export const balanceDue = (s: MoneyState): Decimal => Decimal.max(0, effectiveTotal(s).minus(netReceived(s)));
/** Overpayment that may be refunded (credit notes can make an invoice worth less than what was paid). */
export const refundable = (s: MoneyState): Decimal => Decimal.max(0, netReceived(s).minus(effectiveTotal(s)));

export type LiveStatus = "ISSUED" | "PARTIALLY_PAID" | "PAID";

export function deriveStatus(s: MoneyState): LiveStatus {
  const net = netReceived(s);
  // Fully credited (e.g. every item returned): nothing is owed, so the invoice is settled.
  if (effectiveTotal(s).lte(0)) return "PAID";
  if (net.lte(0)) return "ISSUED";
  return net.lt(effectiveTotal(s)) ? "PARTIALLY_PAID" : "PAID";
}

export const fmt = (v: Decimal.Value): string => D(v).toFixed(2);
