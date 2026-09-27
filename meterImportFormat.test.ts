import { describe, expect, it } from "vitest";
import { normalizeCustomerReadingExport } from "../client/src/lib/meterImport";


describe("customer reading export format", () => {
  it("maps customers array, CUST ids, billing period, and date", () => {
    const result = normalizeCustomerReadingExport({
      date: "2026-09-20",
      billingPeriod: "September 2026",
      defaultRatePerUnit: 65,
      customers: [
        { customerId: "CUST-01", name: "FAWAD KHAN", previousReading: 0, currentReading: 23.25 },
        { customerId: "CUST-21", name: "SARBAZ KHAN", previousReading: 0, currentReading: 83.38 },
      ],
    }, 1, 2025);
    expect(result?.period).toEqual({ month: 9, year: 2026 });
    expect(result?.readingDate).toBe("2026-09-20");
    expect(result?.entries[0]).toMatchObject({ sNo: 1, nameTag: "FAWAD KHAN", currentReading: 23.25, ratePerUnit: 65 });
    expect(result?.entries[1]).toMatchObject({ sNo: 21, nameTag: "SARBAZ KHAN", currentReading: 83.38, ratePerUnit: 65 });
  });
});
