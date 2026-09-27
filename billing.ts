export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export type BillStatus = "Paid" | "Unpaid" | "Overdue";
export const DEFAULT_ELECTRICITY_RATE = 65;

export function cleanNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function getUnits(previousReading: unknown, currentReading: unknown): number {
  return Math.max(0, cleanNumber(currentReading) - cleanNumber(previousReading));
}

export function getCurrentCharges(units: unknown, unitPrice: unknown): number {
  return cleanNumber(units) * cleanNumber(unitPrice);
}

export function getTotalPayable(previousOutstanding: unknown, currentCharges: unknown, lateFee: unknown, discount: unknown): number {
  return Math.max(0, cleanNumber(previousOutstanding) + cleanNumber(currentCharges) + cleanNumber(lateFee) - cleanNumber(discount));
}

export function getOutstanding(totalPayable: unknown, receivedAmount: unknown): number {
  return Math.max(0, cleanNumber(totalPayable) - cleanNumber(receivedAmount));
}

export function calculateNetProfit(bills: Array<{ totalPayable: unknown; unitsConsumed: unknown; unitPrice: unknown }>, wapdaTotalBill: unknown | null | undefined, costRatePerUnit = DEFAULT_ELECTRICITY_RATE): number {
  const billed = bills.reduce((sum, bill) => sum + cleanNumber(bill.totalPayable), 0);
  const units = bills.reduce((sum, bill) => sum + cleanNumber(bill.unitsConsumed), 0);
  if (wapdaTotalBill !== null && wapdaTotalBill !== undefined) return billed - cleanNumber(wapdaTotalBill);
  const averageSellingRate = units > 0 ? bills.reduce((sum, bill) => sum + cleanNumber(bill.unitsConsumed) * cleanNumber(bill.unitPrice), 0) / units : 0;
  return units * (averageSellingRate - cleanNumber(costRatePerUnit));
}

export function getBillStatus(totalPayable: unknown, receivedAmount: unknown, dueDate: string | null | undefined, today = new Date()): BillStatus {
  const received = cleanNumber(receivedAmount);
  const outstanding = getOutstanding(totalPayable, received);
  if (outstanding <= 0 && received > 0) return "Paid";
  if (dueDate) {
    const endOfDueDate = new Date(`${dueDate}T23:59:59`);
    if (!Number.isNaN(endOfDueDate.getTime()) && endOfDueDate.getTime() < today.getTime() && outstanding > 0) return "Overdue";
  }
  return "Unpaid";
}

export function invoiceNumber(year: number, month: number, serial: number): string { return `AZ-${year}${String(month).padStart(2, "0")}-${String(serial).padStart(3, "0")}`; }
export function formatRs(value: unknown): string { return `Rs ${cleanNumber(value).toLocaleString("en-PK", { maximumFractionDigits: 2 })}`; }
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function underThousand(n: number): string { const parts: string[] = []; if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; } if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]); n %= 10; } if (n > 0) parts.push(ONES[n]); return parts.join(" "); }
export function amountInWords(value: unknown): string { let n = Math.floor(cleanNumber(value)); if (n === 0) return "Zero Rupees Only"; const parts: string[] = []; const crore = Math.floor(n / 10_000_000); if (crore) { parts.push(`${underThousand(crore)} Crore`); n %= 10_000_000; } const lakh = Math.floor(n / 100_000); if (lakh) { parts.push(`${underThousand(lakh)} Lakh`); n %= 100_000; } const thousand = Math.floor(n / 1_000); if (thousand) { parts.push(`${underThousand(thousand)} Thousand`); n %= 1_000; } if (n) parts.push(underThousand(n)); return `${parts.join(" ")} Rupees Only`; }
