import { describe, expect, it } from "vitest";
import { amountInWords, calculateNetProfit, getBillStatus, getCurrentCharges, getOutstanding, getTotalPayable, getUnits, invoiceNumber } from "../shared/billing";

describe("billing calculations", () => {
  it("never returns negative units", () => {
    expect(getUnits(200, 150)).toBe(0);
    expect(getUnits(100, 175)).toBe(75);
  });

  it("calculates charges, payable, and outstanding without adding WAPDA cost", () => {
    const charges = getCurrentCharges(100, 45);
    expect(charges).toBe(4500);
    const payable = getTotalPayable(500, charges, 100, 250);
    expect(payable).toBe(4850);
    expect(getOutstanding(payable, 1000)).toBe(3850);
  });

  it("calculates selected-period net profit from billed totals and WAPDA expense", () => {
    const bills = [{ totalPayable: 10_000, unitsConsumed: 100, unitPrice: 65 }];
    expect(calculateNetProfit(bills, 2_500, 45)).toBe(7_500);
    expect(calculateNetProfit(bills, null, 45)).toBe(2_000);
  });

  it("calculates paid, overdue, and unpaid status from synchronized values", () => {
    expect(getBillStatus(1000, 1000, "2026-09-20", new Date("2026-09-14"))).toBe("Paid");
    expect(getBillStatus(1000, 0, "2026-09-01", new Date("2026-09-14"))).toBe("Overdue");
    expect(getBillStatus(1000, 0, "2026-09-20", new Date("2026-09-14"))).toBe("Unpaid");
  });

  it("uses stable invoice formatting", () => {
    expect(invoiceNumber(2026, 9, 5)).toBe("AZ-202609-005");
  });

  it("uses Pakistani thousand, lakh, and crore wording", () => {
    expect(amountInWords(12_500)).toBe("Twelve Thousand Five Hundred Rupees Only");
    expect(amountInWords(125_000)).toContain("One Lakh");
    expect(amountInWords(10_000_000)).toBe("One Crore Rupees Only");
  });
});
