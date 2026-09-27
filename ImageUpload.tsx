import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { ImageIcon, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";

export function ImageUpload({ value, onChange, category, label }: { value?: string | null; onChange: (url: string | null) => void; category: "customer" | "meter" | "logo" | "jazzcash" | "easypaisa" | "bank"; label: string }) {
  const upload = trpc.files.uploadImage.useMutation({ onError: e => toast.error(e.message) });
  const handleFile = async (file?: File) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return toast.error("Use a JPG, PNG, or WebP image.");
    if (file.size > 5 * 1024 * 1024) return toast.error("Image must be 5 MB or smaller.");
    const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] || ""); reader.onerror = reject; reader.readAsDataURL(file); });
    const result = await upload.mutateAsync({ category, fileName: file.name, mimeType: file.type as "image/jpeg" | "image/png" | "image/webp", base64 });
    onChange(result.url); toast.success(`${label} uploaded`);
  };
  return <div className="rounded-xl border bg-muted/30 p-3"><div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold">{label}</span>{value && <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={() => onChange(null)}><X className="h-4 w-4"/></Button>}</div>{value ? <img src={value} alt={label} className="mb-3 h-28 w-full rounded-lg bg-white object-contain"/> : <div className="mb-3 flex h-24 items-center justify-center rounded-lg border border-dashed text-muted-foreground"><ImageIcon className="h-7 w-7"/></div>}<label className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border bg-card px-3 text-sm font-semibold hover:bg-accent"><input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" disabled={upload.isPending} onChange={e => handleFile(e.target.files?.[0])}/>{upload.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <Upload className="mr-2 h-4 w-4"/>}{upload.isPending ? "Uploading…" : "Choose image"}</label></div>;
}
