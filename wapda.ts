export function daysInMonth(month: number, year: number) {
  return new Date(year, month, 0).getDate();
}

export function periodDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
