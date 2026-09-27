import { describe, expect, it } from "vitest";
import { calculateManualCustomerReading, calculateMonthlyDailyBill, normalizeCustomerDailyPayload, summarizeCustomerRange } from "./routers/customerDailyWapdaRouter";

describe("customer-wise daily WAPDA JSON", () => {
  it("accepts one JSON object containing all customers and string numbers", () => {
    const result = normalizeCustomerDailyPayload({
      date: "2026-09-20",
      billingPeriod: "September 2026",
      defaultRatePerUnit: 65,
      customers: [
        { customerId: "CUST-01", name: "FAWAD KHAN", previousReading: "0", currentReading: "23.25" },
        { sNo: 21, name: "SARBAZ KHAN", currentReading: 83.38 },
      ],
    });
    expect(result.invalid).toHaveLength(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ sNo: 1, nameTag: "FAWAD KHAN", previousReading: 0, currentReading: 23.25, unitsConsumed: 23.25, ratePerUnit: 65 });
    expect(result.entries[1]).toMatchObject({ sNo: 21, nameTag: "SARBAZ KHAN", currentReading: 83.38, unitsConsumed: 83.38, ratePerUnit: 65 });
  });

  it("accepts a root array for the selected date", () => {
    const result = normalizeCustomerDailyPayload([
      { sNo: 1, currentReading: 10 },
      { sNo: 2, previousReading: 4, currentReading: 11 },
    ]);
    expect(result.invalid).toHaveLength(0);
    expect(result.entries.map(row => row.sNo)).toEqual([1, 2]);
    expect(result.entries[0]?.previousReading).toBeUndefined();
    expect(result.entries[1]?.unitsConsumed).toBe(7);
  });

  it("reports invalid rows without creating customers", () => {
    const result = normalizeCustomerDailyPayload({ customers: [{ name: "", currentReading: "not-a-number" }] });
    expect(result.entries).toHaveLength(0);
    expect(result.invalid).toHaveLength(1);
  });

  it("aggregates only imported days into the customer monthly bill", () => {
    const bill = calculateMonthlyDailyBill([
      { previousReading: 0, currentReading: 10, unitsConsumed: 10, readingDate: "2026-09-01" },
      { previousReading: 10, currentReading: 18, unitsConsumed: 8, readingDate: "2026-09-15" },
    ], 65, 100, 0, 0, 0, "2026-09-30");
    expect(bill.unitsConsumed).toBe(18);
    expect(bill.amount).toBe(1170);
    expect(bill.totalPayable).toBe(1270);
    expect(bill.outstandingAmount).toBe(1270);
  });

  it("calculates a manual customer day and rejects a lower current reading", () => {
    expect(calculateManualCustomerReading(10, 18, 65)).toEqual({ unitsConsumed: 8, totalAmount: 520 });
    expect(calculateManualCustomerReading(0, 29.8, 65)).toEqual({ unitsConsumed: 29.8, totalAmount: 1937 });
    expect(() => calculateManualCustomerReading(18, 10, 65)).toThrow("Current reading cannot be lower");
  });

  it("summarizes all customers together for a selected date range", () => {
    const result = summarizeCustomerRange([
      { customerId: 1, customerName: "A", sNo: 1, readingDate: "2026-09-01", unitsConsumed: 5, totalAmount: 325 },
      { customerId: 2, customerName: "B", sNo: 2, readingDate: "2026-09-02", unitsConsumed: 7, totalAmount: 455 },
      { customerId: 1, customerName: "A", sNo: 1, readingDate: "2026-09-03", unitsConsumed: 3, totalAmount: 195 },
    ]);
    expect(result).toMatchObject({ totalRecords: 3, importedDays: 3, totalUnits: 15, totalAmount: 975 });
    expect(result.customers[0]).toMatchObject({ sNo: 1, days: 2, units: 8, totalAmount: 520 });
  });
});
