import { describe, expect, it } from "vitest";
import { daysInMonth, periodDate } from "../shared/wapda";
import { getUnits } from "../shared/billing";
import { calculateProfitPeriods } from "./routers/dailyWapdaRouter";

describe("daily WAPDA period helpers", () => {
  it("uses the actual number of days for every month type", () => {
    expect(daysInMonth(2, 2026)).toBe(28);
    expect(daysInMonth(2, 2028)).toBe(29);
    expect(daysInMonth(4, 2026)).toBe(30);
    expect(daysInMonth(9, 2026)).toBe(30);
    expect(daysInMonth(1, 2026)).toBe(31);
  });

  it("formats exact imported reading dates without timezone drift", () => {
    expect(periodDate(2026, 9, 1)).toBe("2026-09-01");
    expect(periodDate(2026, 9, 30)).toBe("2026-09-30");
  });
});

describe("unified customer and WAPDA profit summary", () => {
  it("calculates WAPDA cumulative-meter units and cost at Rs 65", () => {
    const units = getUnits(9630, 10118);
    expect(units).toBe(488);
    expect(Math.round(units * 65)).toBe(31720);
  });

  it("calculates revenue minus actual WAPDA cost for today and rolling periods", () => {
    const result = calculateProfitPeriods([
      { readingDate: "2026-09-14", customerRevenue: 650, customerUnits: 10, wapdaCost: 260, wapdaUnits: 4 },
      { readingDate: "2026-09-18", customerRevenue: 1300, customerUnits: 20, wapdaCost: 520, wapdaUnits: 8 },
      { readingDate: "2026-09-20", customerRevenue: 1950, customerUnits: 30, wapdaCost: 650, wapdaUnits: 10 },
    ], "2026-09-20", 9, 2026);
    expect(result.today).toMatchObject({ revenue: 1950, wapdaCost: 650, netProfit: 1300, customerUnits: 30, wapdaUnits: 10, solarDifferenceUnits: 20, importedDates: 1 });
    expect(result.week).toMatchObject({ revenue: 3900, wapdaCost: 1430, netProfit: 2470, importedDates: 3 });
    expect(result.month).toMatchObject({ revenue: 3900, wapdaCost: 1430, netProfit: 2470, customerUnits: 60, wapdaUnits: 22 });
  });

  it("does not invent missing dates and returns zero for empty periods", () => {
    const result = calculateProfitPeriods([], "2026-09-20", 9, 2026);
    expect(result.today).toEqual({ revenue: 0, wapdaCost: 0, netProfit: 0, customerUnits: 0, wapdaUnits: 0, solarDifferenceUnits: 0, importedDates: 0 });
    expect(result.month.importedDates).toBe(0);
  });
});
