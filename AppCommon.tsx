import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Plus, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { MONTHS } from "@shared/billing";

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
    <div><div className="gold-line mb-3" />{eyebrow && <p className="mb-1 text-xs font-extrabold uppercase tracking-[.2em] text-[#a7761f]">{eyebrow}</p>}<h1 className="text-3xl leading-tight text-[#1a2b4a] dark:text-foreground sm:text-4xl">{title}</h1>{description && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>}</div>
    {actions && <div className="flex flex-wrap items-center gap-2 no-print">{actions}</div>}
  </div>;
}

export function PeriodSelector({ month, year, onMonth, onYear }: { month: number; year: number; onMonth: (n: number) => void; onYear: (n: number) => void }) {
  const years = Array.from({ length: 11 }, (_, i) => new Date().getFullYear() - 5 + i);
  return <div className="flex min-w-0 gap-2">
    <Select value={String(month)} onValueChange={v => onMonth(Number(v))}><SelectTrigger className="h-11 min-w-36 bg-card"><SelectValue /></SelectTrigger><SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent></Select>
    <Select value={String(year)} onValueChange={v => onYear(Number(v))}><SelectTrigger className="h-11 w-28 bg-card"><SelectValue /></SelectTrigger><SelectContent>{years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent></Select>
  </div>;
}

export function StatusBadge({ status }: { status: string }) {
  const style = status === "Paid" ? "bg-emerald-100 text-emerald-800 border-emerald-200" : status === "Overdue" ? "bg-red-100 text-red-800 border-red-200" : "bg-amber-100 text-amber-800 border-amber-200";
  return <Badge variant="outline" className={style}>{status}</Badge>;
}

export function LoadingState({ label = "Loading records…" }: { label?: string }) {
  return <Card className="glass-card"><CardContent className="flex min-h-52 items-center justify-center gap-3 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin text-[#c8932e]" /><span>{label}</span></CardContent></Card>;
}

export function EmptyState({ title, description, actionLabel, onAction }: { title: string; description: string; actionLabel?: string; onAction?: () => void }) {
  return <Card className="glass-card border-dashed"><CardContent className="flex min-h-56 flex-col items-center justify-center px-6 text-center"><div className="mb-4 rounded-2xl bg-accent p-3 text-accent-foreground"><SearchX className="h-6 w-6" /></div><h3 className="text-xl">{title}</h3><p className="mt-2 max-w-md text-sm text-muted-foreground">{description}</p>{actionLabel && onAction && <Button className="mt-5 min-h-11" onClick={onAction}><Plus className="mr-2 h-4 w-4" />{actionLabel}</Button>}</CardContent></Card>;
}

export function FormField({ label, required, children, className = "" }: { label: string; required?: boolean; children: ReactNode; className?: string }) {
  return <div className={`grid gap-2 ${className}`}><Label>{label}{required && <span className="ml-1 text-destructive">*</span>}</Label>{children}</div>;
}

export function NumberInput(props: React.ComponentProps<typeof Input>) {
  return <Input {...props} type="number" min={props.min ?? 0} step={props.step ?? "0.01"} />;
}
