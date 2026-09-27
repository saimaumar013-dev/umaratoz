import { describe, expect, it } from "vitest";
import { DEFAULT_ELECTRICITY_RATE } from "../shared/billing";
import { normalizeEntries, normalizeName, similarity } from "./routers/meterReadingRouter";

describe("meter reading import normalization", () => {
  it("normalizes capitalization, repeated spaces, punctuation, and apostrophes", () => {
    expect(normalizeName("  Raft__  ULLAH ")).toBe("raft ullah");
    expect(normalizeName("O'NEIL-SALEEM")).toBe("o neil saleem");
    expect(normalizeName("Fawad.Khan")).toBe("fawad khan");
  });

  it("ranks abbreviated and spelling-variant names as close matches", () => {
    expect(similarity(normalizeName("ARYAN"), normalizeName("Riyaan Khan"))).toBeGreaterThanOrEqual(0.5);
    expect(similarity(normalizeName("AMINULLAH"), normalizeName("AMINULLAH KHAN"))).toBeGreaterThanOrEqual(0.5);
    expect(similarity(normalizeName("HAFEEZ"), normalizeName("HAFEZ ULLAH"))).toBeGreaterThanOrEqual(0.5);
    expect(similarity(normalizeName("MOBEN KI"), normalizeName("Mobeen Ki"))).toBe(1);
    expect(similarity(normalizeName("NAIMAT"), normalizeName("Naimat Khan"))).toBeGreaterThanOrEqual(0.5);
    expect(similarity(normalizeName("NASIR"), normalizeName("Nasar Khan"))).toBeGreaterThanOrEqual(0.5);
    expect(similarity(normalizeName("ARBAZ KHAN"), normalizeName("Arbaz Khan"))).toBe(1);
    expect(similarity(normalizeName("KHUSHDIL"), normalizeName("Khushdil Khan"))).toBeGreaterThanOrEqual(0.5);
  });

  it("accepts a bulk array with numeric strings, defaults previousReading to zero, and calculates 65 PKR totals", () => {
    const result = normalizeEntries([
      { sNo: 1, currentReading: "21.393" },
      JSON.stringify({ sNo: "2", previousReading: "10", currentReading: 20.326, unitsConsumed: "10.326", totalAmount: "999" }),
    ]);
    expect(result.invalid).toHaveLength(0);
    expect(result.valid).toEqual([
      { index: 0, sNo: 1, nameTag: undefined, previousReading: 0, currentReading: 21.393, unitsConsumed: 21.393, totalAmount: Math.round(21.393 * DEFAULT_ELECTRICITY_RATE) },
      { index: 1, sNo: 2, nameTag: undefined, previousReading: 10, currentReading: 20.326, unitsConsumed: 10.326, totalAmount: Math.round(10.326 * DEFAULT_ELECTRICITY_RATE) },
    ]);
  });

  it("accepts name-based rows with previousReading omitted", () => {
    const result = normalizeEntries([{ nameTag: "FAWAD KHAN", currentReading: 10 }]);
    expect(result.invalid).toHaveLength(0);
    expect(result.valid[0]).toMatchObject({ nameTag: "FAWAD KHAN", previousReading: 0, currentReading: 10, unitsConsumed: 10, totalAmount: 650 });
  });

  it("flags duplicates, missing readings, and invalid values without throwing", () => {
    const result = normalizeEntries([
      { nameTag: "FAWAD KHAN", currentReading: 10 },
      { nameTag: " fAwAd KhAn ", currentReading: 11 },
      { nameTag: "MISSING" },
      { nameTag: "BAD", currentReading: "not-a-number" },
    ]);
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(3);
    expect(result.invalid.map(row => row.reason)).toEqual([
      "Duplicate nameTag in this import.",
      "Each row needs a positive sNo or nameTag, and reading fields must be finite non-negative numbers.",
      "Readings must be finite non-negative numbers and currentReading cannot be lower than previousReading.",
    ]);
  });
});
