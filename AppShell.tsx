import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Building2, ChevronDown, FileBarChart, History, LayoutDashboard, LogOut, ReceiptText, Settings, ShieldCheck, SunMedium, Users, WalletCards } from "lucide-react";
import { useEffect } from "react";
import { useLocation } from "wouter";
import { LoadingState } from "./AppCommon";

const allItems = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/", permission: "canViewReports" },
  { icon: Users, label: "Customers", path: "/customers", permission: "canViewCustomers" },
  { icon: ReceiptText, label: "Bills", path: "/bills", permission: "canViewBills" },
  { icon: WalletCards, label: "WAPDA Ledger", path: "/ledger", permission: "canViewReports" },
  { icon: History, label: "Monthly History", path: "/history", permission: "canViewBills" },
  { icon: FileBarChart, label: "Reports", path: "/report", permission: "canViewReports" },
  { icon: Building2, label: "Company Settings", path: "/company-settings", permission: "canManageCompany" },
  { icon: Settings, label: "User Settings", path: "/settings", permission: "isActive" },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const access = trpc.admin.myAccess.useQuery(undefined, { enabled: Boolean(user) });
  const company = trpc.admin.companyGet.useQuery(undefined, { enabled: Boolean(user) });
  useEffect(() => {
    if (!access.data) return;
    const required = location === "/" ? "canViewReports"
      : location.startsWith("/customer/") || location === "/customers" ? "canViewCustomers"
      : location.startsWith("/print/") || location === "/bills" || location === "/history" ? "canViewBills"
      : location === "/ledger" || location === "/report" ? "canViewReports"
      : location === "/company-settings" ? "canManageCompany"
      : null;
    if (required && !(access.data as any)[required]) {
      if (location === "/" && access.data.canViewCustomers) setLocation("/customers");
      else if (location === "/" && access.data.canViewBills) setLocation("/bills");
      else setLocation("/settings");
    }
  }, [access.data, location, setLocation]);
  if (loading) return <div className="min-h-screen p-6"><LoadingState label="Securing your workspace…" /></div>;
  if (!user) return <div className="min-h-screen bg-[#13233f] p-5 text-white sm:p-10"><div className="mx-auto grid min-h-[calc(100vh-2.5rem)] max-w-6xl overflow-hidden rounded-[2rem] bg-[#fffdf8] text-[#1a2b4a] shadow-2xl lg:grid-cols-[1.15fr_.85fr]"><div className="relative hidden overflow-hidden bg-[#1a2b4a] p-12 text-white lg:block"><div className="absolute -right-20 -top-20 h-72 w-72 rounded-full border border-[#c8932e]/30"/><div className="absolute -bottom-28 -left-20 h-80 w-80 rounded-full bg-[#c8932e]/10"/><div className="relative"><div className="mb-16 flex items-center gap-3"><div className="rounded-xl bg-[#c8932e] p-2 text-[#13233f]"><SunMedium /></div><span className="font-extrabold">ATOZ SOLAR SYSTEM</span></div><p className="text-xs font-bold uppercase tracking-[.26em] text-[#dcb75f]">Secure business control</p><h1 className="mt-4 text-6xl leading-[1.02]">Money management, from meter to profit.</h1><p className="mt-6 max-w-lg text-base leading-7 text-slate-300">Manage customers, readings, monthly bills, collections, WAPDA expense, outstanding balances, and professional reports in one reliable system.</p></div></div><div className="flex items-center p-7 sm:p-12"><div className="w-full"><div className="mb-8 inline-flex rounded-2xl bg-[#1a2b4a] p-3 text-[#d9ad51]"><ShieldCheck className="h-7 w-7" /></div><p className="text-xs font-bold uppercase tracking-[.24em] text-[#a7761f]">AtoZ Money Manager</p><h2 className="mt-3 text-4xl">Welcome back</h2><p className="mt-3 text-sm leading-6 text-slate-600">Continue with your secure account. The business owner is automatically given administrator access.</p><Button onClick={() => startLogin()} className="mt-8 h-12 w-full bg-[#1a2b4a] text-white hover:bg-[#243b61]">Sign in securely</Button><p className="mt-4 text-center text-xs text-slate-500">Protected authentication · Encrypted session · Server-side permissions</p></div></div></div></div>;
  if (access.isLoading) return <div className="min-h-screen p-6"><LoadingState label="Loading permissions…" /></div>;
  if (!access.data?.isActive) return <div className="flex min-h-screen items-center justify-center p-5"><div className="max-w-md rounded-2xl border bg-card p-8 text-center"><ShieldCheck className="mx-auto mb-4 h-9 w-9 text-destructive"/><h1 className="text-2xl">Account disabled</h1><p className="mt-2 text-sm text-muted-foreground">Contact your administrator to restore access.</p><Button variant="outline" className="mt-6" onClick={logout}>Sign out</Button></div></div>;
  const items = allItems.filter(item => (access.data as any)?.[item.permission]);
  const active = (path: string) => path === "/" ? location === "/" : location.startsWith(path);
  const mobileItems = items.filter(i => ["/", "/ledger", "/history", "/settings"].includes(i.path));
  return <SidebarProvider defaultOpen>
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="border-b border-sidebar-border p-3"><button onClick={() => setLocation("/")} className="flex min-h-12 items-center gap-3 rounded-xl px-1 text-left"><div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-sidebar-primary text-sidebar-primary-foreground shadow-lg">{company.data?.logoUrl?<img src={company.data.logoUrl} alt="Business logo" className="h-full w-full object-contain bg-white p-1"/>:<SunMedium className="h-5 w-5"/>}</div><div className="group-data-[collapsible=icon]:hidden"><p className="text-sm font-extrabold leading-none">AtoZ Money</p><p className="mt-1 text-[10px] uppercase tracking-[.18em] text-[#60a5fa]">Manager</p></div></button></SidebarHeader>
      <SidebarContent><SidebarMenu className="gap-1 p-2">{items.map(item => <SidebarMenuItem key={item.path}><SidebarMenuButton isActive={active(item.path)} tooltip={item.label} onClick={() => setLocation(item.path)} className="h-11 rounded-xl"><item.icon className={active(item.path) ? "text-[#d9ad51]" : ""}/><span>{item.label}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-3"><DropdownMenu><DropdownMenuTrigger asChild><button className="flex min-h-12 w-full items-center gap-3 rounded-xl p-1 text-left hover:bg-sidebar-accent"><Avatar className="h-9 w-9 border border-[#c8932e]/30"><AvatarFallback className="bg-[#c8932e] text-xs font-bold text-[#13233f]">{user.name?.slice(0,1).toUpperCase() || "A"}</AvatarFallback></Avatar><div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden"><p className="truncate text-sm font-semibold">{user.name || "User"}</p><p className="truncate text-xs text-sidebar-foreground/60">{access.data?.role === "admin" ? "Administrator" : "Team member"}</p></div><ChevronDown className="h-4 w-4 group-data-[collapsible=icon]:hidden"/></button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-56"><DropdownMenuItem onClick={() => setLocation("/settings")}><Settings className="mr-2 h-4 w-4"/>Settings</DropdownMenuItem><DropdownMenuSeparator/><DropdownMenuItem onClick={logout} className="text-destructive"><LogOut className="mr-2 h-4 w-4"/>Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu></SidebarFooter>
    </Sidebar>
    <SidebarInset className="min-w-0 bg-[radial-gradient(circle_at_top_right,rgba(200,147,46,.08),transparent_25%)]"><header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b bg-background/90 px-4 backdrop-blur no-print sm:px-6"><div className="flex items-center gap-3"><SidebarTrigger className="h-10 w-10"/><div><p className="text-sm font-bold">{items.find(i => active(i.path))?.label || "AtoZ Money Manager"}</p><p className="hidden text-xs text-muted-foreground sm:block">ATOZ Solar System</p></div></div><div className="rounded-full border bg-card px-3 py-1 text-xs font-semibold text-muted-foreground">{access.data?.role === "admin" ? "Admin" : "User"}</div></header><main className="min-w-0 flex-1 p-4 pb-24 sm:p-6 sm:pb-8 xl:p-8">{children}</main></SidebarInset>
    <nav data-mobile-nav className="fixed inset-x-0 bottom-0 z-50 grid border-t bg-[#13233f] px-2 py-1 text-white sm:hidden" style={{gridTemplateColumns:`repeat(${mobileItems.length},minmax(0,1fr))`}}>{mobileItems.map(item => <button key={item.path} onClick={() => setLocation(item.path)} className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[10px] ${active(item.path) ? "text-[#e1b75d]" : "text-slate-300"}`}><item.icon className="h-5 w-5"/><span>{item.label.replace("Monthly ","")}</span></button>)}</nav>
  </SidebarProvider>;
}
