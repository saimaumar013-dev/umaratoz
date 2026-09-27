import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { CalendarDays, Edit3, FileUp, Loader2, Plus, Save, TrendingDown, TrendingUp, Upload, WalletCards, Zap } from "lucide-react";
import { BillDialog } from "@/components/BillDialog";
import { FormField, LoadingState, NumberInput, PageHeader, PeriodSelector, StatusBadge } from "@/components/AppCommon";
import { DEFAULT_ELECTRICITY_RATE, formatRs, getUnits, MONTHS } from "@shared/billing";
import { daysInMonth, periodDate } from "@shared/wapda";
import { CustomerDailyLedger } from "@/components/CustomerDailyLedger";

function dateFor(month: number, year: number, day: number) { return periodDate(year, month, day); }

export default function Ledger() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [selectedDay, setSelectedDay] = useState(Math.min(now.getDate(), daysInMonth(month, year)));
  const [customStartDate, setCustomStartDate] = useState(dateFor(month, year, 1));
  const [customEndDate, setCustomEndDate] = useState(dateFor(month, year, Math.min(now.getDate(), daysInMonth(month, year))));
  const [form, setForm] = useState({ previousReading: "0", currentReading: "0", ratePerUnit: String(DEFAULT_ELECTRICITY_RATE) });
  const [dailyData, setDailyData] = useState(`{\n  "previousReading": 0,\n  "currentReading": 0,\n  "ratePerUnit": ${DEFAULT_ELECTRICITY_RATE}\n}`);
  const [manualPreviousReading, setManualPreviousReading] = useState("");
  const [manualCurrentReading, setManualCurrentReading] = useState("");
  const [dailyPreview, setDailyPreview] = useState<any>();
  const [editing, setEditing] = useState<any>();
  const [createCustomerId, setCreateCustomerId] = useState<number>();
  const [billOpen, setBillOpen] = useState(false);
  const days = daysInMonth(month, year);
  const selectedDate = dateFor(month, year, selectedDay);
  const defaults = trpc.overview.wapdaDefaults.useQuery({ month, year });
  const bills = trpc.bills.list.useQuery({ month, year });
  const customers = trpc.customers.list.useQuery();
  const daily = trpc.dailyWapda.list.useQuery({ month, year });
  const customerDaily = trpc.customerDailyWapda.list.useQuery({ month, year });
  const profitSummary = trpc.dailyWapda.profitSummary.useQuery({ month, year, selectedDate });
  const customProfit = trpc.dailyWapda.summaryRange.useQuery({ month, year, startDate: customStartDate, endDate: customEndDate });
  const access = trpc.admin.myAccess.useQuery();
  const utils = trpc.useUtils();

  const save = trpc.overview.wapdaSave.useMutation({ onSuccess: () => { toast.success("Monthly WAPDA record saved"); utils.overview.invalidate(); }, onError: e => toast.error(e.message) });
  const previewDaily = trpc.dailyWapda.preview.useMutation({ onSuccess: data => setDailyPreview(data), onError: e => toast.error(e.message) });
  const confirmDaily = trpc.dailyWapda.confirm.useMutation({ onSuccess: data => { toast.success(`Daily WAPDA saved for ${data.readingDate}`); setDailyPreview(undefined); daily.refetch(); }, onError: e => toast.error(e.message) });
  const saveManualDaily = trpc.dailyWapda.confirm.useMutation({ onSuccess: () => { toast.success(`WAPDA reading saved for ${selectedDate}`); void daily.refetch(); }, onError: e => toast.error(e.message) });

  const set = (key: string, value: string) => setForm(current => ({ ...current, [key]: value }));
  const units = getUnits(form.previousReading, form.currentReading);
  const expense = units * (Number(form.ratePerUnit) || 0);
  const received = (bills.data || []).reduce((sum, bill) => sum + bill.receivedAmount, 0);
  const profit = received - expense;
  const billMap = new Map((bills.data || []).map(bill => [bill.customerId, bill]));
  const dailyMap = useMemo(() => new Map((daily.data || []).map(row => [row.readingDate, row])), [daily.data]);
  const selectedRecord = dailyMap.get(selectedDate);
  useEffect(() => { setManualPreviousReading(selectedRecord ? String(selectedRecord.previousReading) : "0"); setManualCurrentReading(selectedRecord ? String(selectedRecord.currentReading) : ""); }, [selectedDate, selectedRecord?.id, selectedRecord?.previousReading, selectedRecord?.currentReading]);
  const summary = useMemo(() => {
    const rows = daily.data || [];
    const sum = (from: string, to: string) => rows.filter(row => row.readingDate >= from && row.readingDate <= to).reduce((acc, row) => ({ days: acc.days + 1, units: acc.units + row.unitsConsumed, expense: acc.expense + row.totalBill }), { days: 0, units: 0, expense: 0 });
    const selected = new Date(`${selectedDate}T00:00:00`);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const weekStart = new Date(selected); weekStart.setDate(selected.getDate() - 6);
    const fifteenStart = new Date(selected); fifteenStart.setDate(selected.getDate() - 14);
    return { day: sum(selectedDate, selectedDate), week: sum(iso(weekStart), selectedDate), fifteen: sum(iso(fifteenStart), selectedDate), month: sum(dateFor(month, year, 1), dateFor(month, year, days)) };
  }, [daily.data, selectedDate, month, year, days]);
  const profitPeriods = profitSummary.data?.periods;

  const selectPeriod = (nextMonth: number, nextYear: number) => { setMonth(nextMonth); setYear(nextYear); setSelectedDay(d => Math.min(d, daysInMonth(nextMonth, nextYear))); setCustomStartDate(dateFor(nextMonth, nextYear, 1)); setCustomEndDate(dateFor(nextYear, nextMonth, Math.min(selectedDay, daysInMonth(nextMonth, nextYear)))); };
  const loadFile = async (file?: File) => { if (!file) return; try { setDailyData(await file.text()); toast.success("Daily WAPDA JSON loaded. Review it, then click Preview."); } catch { toast.error("Could not read that file."); } };
  const preview = () => { try { const parsed = JSON.parse(dailyData); previewDaily.mutate({ month, year, readingDate: selectedDate, data: parsed }); } catch { toast.error("Daily WAPDA data must be valid JSON."); } };
  const confirm = () => { try { const parsed = JSON.parse(dailyData); confirmDaily.mutate({ month, year, readingDate: selectedDate, data: parsed }); } catch { toast.error("Daily WAPDA data must be valid JSON."); } };

  if (defaults.isLoading || bills.isLoading || customers.isLoading || daily.isLoading || customerDaily.isLoading) return <LoadingState label="Loading ledger…" />;

  return <>
    <PageHeader eyebrow="Cost & profit" title="WAPDA Ledger" description="One-month daily board. Only imported dates appear in summaries; no missing days are generated." actions={<PeriodSelector month={month} year={year} onMonth={(nextMonth) => selectPeriod(nextMonth, year)} onYear={(nextYear) => selectPeriod(month, nextYear)} />} />
    <Card className="mb-5 border-blue-200 bg-gradient-to-r from-blue-50 to-white shadow-sm"><CardContent className="p-4"><div className="flex items-start gap-3"><div className="rounded-xl bg-blue-600 p-2 text-white"><CalendarDays className="h-5 w-5" /></div><div><h2 className="font-extrabold text-slate-900">Simple Monthly WAPDA Ledger</h2><p className="mt-1 text-sm text-slate-600">Use the same selected month and date throughout this page. Import or paste actual data only; then review Johnson readings and customer details below.</p></div></div><div className="mt-4 grid gap-2 text-xs font-semibold text-slate-700 sm:grid-cols-3"><div className="rounded-xl bg-white p-3 shadow-sm"><span className="mr-2 rounded-full bg-blue-600 px-2 py-1 text-white">1</span> JSON Import / Manual Paste</div><div className="rounded-xl bg-white p-3 shadow-sm"><span className="mr-2 rounded-full bg-emerald-600 px-2 py-1 text-white">2</span> WAPDA Meter — every day</div><div className="rounded-xl bg-white p-3 shadow-sm"><span className="mr-2 rounded-full bg-violet-600 px-2 py-1 text-white">3</span> Customer Details — every day</div></div></CardContent></Card>

    <Card className="glass-card mb-5"><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle><CalendarDays className="mr-2 inline h-5 w-5" />2. WAPDA Meter Details — {MONTHS[month - 1]} {year}</CardTitle><span className="text-sm text-muted-foreground">{days} calendar days · {daily.data?.length ?? 0} imported</span></div></CardHeader><CardContent>
      <div id="johnson-manual-editor" className="mb-4 rounded-2xl border border-blue-200 bg-blue-50/70 p-3"><div className="flex flex-wrap items-end gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-blue-800">Johnson / Main B · Manual Add / Edit</p><p className="text-sm text-blue-900">Selected date: <b>{selectedDate}</b> · {selectedRecord ? "Edit existing Johnson reading" : "Add a new Johnson reading"}</p></div><label className="text-xs font-semibold text-slate-700">Previous Reading<Input type="number" step="0.001" min="0" value={manualPreviousReading} onChange={e => setManualPreviousReading(e.target.value)} className="mt-1 w-32 bg-white" /></label><label className="text-xs font-semibold text-slate-700">Current Reading<Input type="number" step="0.001" min="0" value={manualCurrentReading} onChange={e => setManualCurrentReading(e.target.value)} className="mt-1 w-32 bg-white" /></label><Button disabled={!manualCurrentReading || Number(manualCurrentReading) < Number(manualPreviousReading) || saveManualDaily.isPending} onClick={() => saveManualDaily.mutate({ month, year, readingDate: selectedDate, data: { previousReading: Number(manualPreviousReading || 0), currentReading: Number(manualCurrentReading), ratePerUnit: DEFAULT_ELECTRICITY_RATE } })}>{saveManualDaily.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save Johnson Date</Button></div></div><div className="mb-5 grid grid-cols-7 gap-2 sm:grid-cols-10 lg:grid-cols-16">{Array.from({ length: days }, (_, index) => { const day = index + 1; const row = dailyMap.get(dateFor(month, year, day)); return <button key={day} type="button" onClick={() => setSelectedDay(day)} className={`min-h-12 rounded-xl border text-sm font-bold transition ${selectedDay === day ? "border-blue-600 bg-blue-600 text-white shadow-md" : row ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-700 hover:border-blue-300"}`}><span>{MONTHS[month - 1].slice(0, 3)} {String(day).padStart(2, "0")}</span>{row && <span className="block text-[9px] font-normal">{Number(row.currentReading).toFixed(3)}</span>}{!row && <span className="block text-[9px] font-normal text-slate-400">0.000</span>}</button>; })}</div>
      <div className="grid gap-5 xl:grid-cols-[1fr_1.1fr]">
        <div className="rounded-2xl border border-slate-200 bg-white p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-sm font-bold text-slate-900">1. JSON Import / Manual Paste — WAPDA</p><p className="text-xs text-muted-foreground">Selected: {selectedDate}. This saves only that date.</p></div><label className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-semibold"><FileUp className="h-4 w-4" />Choose JSON<input type="file" accept=".json,application/json" className="hidden" onChange={e => loadFile(e.target.files?.[0])} /></label></div><Textarea value={dailyData} onChange={e => setDailyData(e.target.value)} className="min-h-36 font-mono text-xs" /><div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" onClick={preview} disabled={previewDaily.isPending}>{previewDaily.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}Preview {selectedDate}</Button>{dailyPreview && <Button onClick={confirm} disabled={confirmDaily.isPending}><Save className="mr-2 h-4 w-4" />{dailyPreview.action === "update" ? "Confirm Update" : "Confirm Import"}</Button>}</div>{dailyPreview && <div className="mt-3 rounded-xl bg-blue-50 p-3 text-sm text-blue-900">{dailyPreview.action === "update" ? "This date already has data; confirmation will update only this date." : "No record exists for this date; confirmation will create only this date."} Units: <b>{dailyPreview.data.unitsConsumed}</b> · Total: <b>{formatRs(dailyPreview.data.totalBill)}</b></div>}</div>

      </div>
    </CardContent></Card>


    <Card className="glass-card mb-5 border-slate-200"><CardHeader><div className="flex flex-wrap items-end justify-between gap-3"><div><CardTitle>Profit & Reporting</CardTitle><p className="text-sm text-muted-foreground">Net Profit = Customer Revenue − WAPDA Cost. Only saved readings are included.</p></div><div className="rounded-xl bg-emerald-50 px-3 py-2 text-right"><p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Monthly Net Profit</p><p className="text-lg font-extrabold text-emerald-800">{formatRs(profitPeriods?.month.netProfit ?? 0)}</p></div></div></CardHeader><CardContent><div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl bg-slate-50 p-3"><label className="text-xs font-bold uppercase text-slate-500">Custom Start<input type="date" value={customStartDate} min={dateFor(month, year, 1)} max={dateFor(month, year, days)} onChange={e => setCustomStartDate(e.target.value)} className="mt-1 h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm" /></label><label className="text-xs font-bold uppercase text-slate-500">Custom End<input type="date" value={customEndDate} min={dateFor(month, year, 1)} max={dateFor(month, year, days)} onChange={e => setCustomEndDate(e.target.value)} className="mt-1 h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm" /></label><span className="text-xs text-slate-500">Custom report updates automatically.</span></div><div className="grid gap-3 md:grid-cols-3">{([['WEEKLY REPORT','week','Last 7 saved days'],['MONTHLY REPORT','month','Full selected month'],['CUSTOM DATE RANGE','custom','Selected start and end dates']] as const).map(([label,key,description]) => { const value = key === 'custom' ? customProfit.data : profitPeriods?.[key]; return <div key={key} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="mb-3 flex items-center justify-between"><p className="text-xs font-extrabold tracking-wide text-slate-700">{label}</p><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-500">{value?.importedDates ?? 0} dates</span></div><p className="mb-3 text-xs text-slate-500">{description}</p><div className="space-y-2 text-sm"><div className="flex justify-between gap-3"><span className="text-slate-500">Customer Revenue</span><b className="text-blue-700">{formatRs(value?.revenue ?? 0)}</b></div><div className="flex justify-between gap-3"><span className="text-slate-500">WAPDA Cost</span><b className="text-amber-700">{formatRs(value?.wapdaCost ?? 0)}</b></div><div className="mt-3 flex items-end justify-between border-t border-slate-100 pt-3"><span className="text-xs font-bold uppercase text-slate-600">Net Profit</span><b className={`text-lg ${(value?.netProfit ?? 0) < 0 ? "text-red-600" : "text-emerald-700"}`}>{formatRs(value?.netProfit ?? 0)}</b></div></div></div>; })}</div></CardContent></Card>

    <p className="mb-5 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">Customer monthly units and payment totals are shown in the calendar cards below. Open a customer profile for the full bill and history.</p>
    <div className="mb-3 mt-7"><p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-700">Step 3</p><h2 className="text-2xl font-extrabold text-slate-900">Customer Details — All Days</h2><p className="text-sm text-slate-500">Every customer profile, every day, with manual edit and customer JSON import.</p></div>
    <CustomerDailyLedger />
    <BillDialog open={billOpen} onOpenChange={setBillOpen} bill={editing} initialCustomerId={createCustomerId} initialMonth={month} initialYear={year} />
  </>;
}

function Metric({ label, value, icon: Icon, danger }: { label: string; value: string; icon: any; danger?: boolean }) { return <Card className="metric-card glass-card"><CardContent className="flex items-center gap-4 p-4"><div className="rounded-xl bg-[#1a2b4a] p-3 text-[#d9ad51]"><Icon className="h-5 w-5" /></div><div><p className="text-xs text-muted-foreground">{label}</p><p className={`text-xl font-extrabold ${danger ? "text-destructive" : ""}`}>{value}</p></div></CardContent></Card>; }
