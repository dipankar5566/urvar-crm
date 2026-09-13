"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LocateFixed, MapPin, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getCurrentPosition, type Fix } from "@/lib/geolocation";
import { checkIn } from "./actions";

export type VisitTarget = {
  id: string;
  name: string;
  kind: "lead" | "customer";
  /** Lead/customer number, shown to disambiguate two same-named records. */
  reference: string;
  location: string;
};

export function CheckInDialog({ targets }: { targets: VisitTarget[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<VisitTarget | null>(null);
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);

  const [fix, setFix] = useState<Fix | null>(null);
  const [locating, setLocating] = useState(false);

  async function locate() {
    setLocating(true);
    try {
      setFix(await getCurrentPosition());
    } catch (err) {
      setFix(null);
      toast.error(err instanceof Error ? err.message : "Couldn't get your location.");
    } finally {
      setLocating(false);
    }
  }

  /**
   * Reset in the open handler rather than an effect (the same shape the
   * customer location dialog uses), so a previous cancelled attempt never
   * leaks a stale target or an old GPS fix into the next check-in.
   *
   * The fix is requested immediately on open because acquiring GPS is the
   * slowest part of checking in — it runs while the rep is still picking who
   * they are visiting.
   */
  function handleOpenChange(next: boolean) {
    if (next) {
      setQuery("");
      setSelected(null);
      setNotes("");
      setPhoto(null);
      setFix(null);
      void locate();
    }
    setOpen(next);
  }

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? targets.filter(
        (t) =>
          t.name.toLowerCase().includes(needle) ||
          t.reference.toLowerCase().includes(needle) ||
          t.location.toLowerCase().includes(needle),
      )
    : targets;

  function handleSubmit() {
    if (!selected || !fix) return;
    startTransition(async () => {
      const result = await checkIn(
        selected.kind === "lead" ? { leadId: selected.id } : { customerId: selected.id },
        {
          latitude: fix.latitude,
          longitude: fix.longitude,
          accuracy: fix.accuracy,
          notes,
        },
        photo,
      );
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`Checked in at ${selected.name}`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button size="lg" />}>
        <MapPin /> Check In
      </DialogTrigger>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start a field visit</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Who are you visiting?</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search leads and customers…"
                className="pl-8"
                autoComplete="off"
              />
            </div>

            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-1">
              {matches.length === 0 && (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  Nothing matches that.
                </p>
              )}
              {matches.slice(0, 50).map((t) => (
                <button
                  key={`${t.kind}-${t.id}`}
                  type="button"
                  onClick={() => setSelected(t)}
                  className={cn(
                    "flex w-full flex-col items-start rounded-md px-2 py-2 text-left text-sm transition-colors",
                    selected?.id === t.id && selected.kind === t.kind
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted",
                  )}
                >
                  <span className="font-medium">{t.name}</span>
                  <span
                    className={cn(
                      "text-xs",
                      selected?.id === t.id && selected.kind === t.kind
                        ? "text-primary-foreground/80"
                        : "text-muted-foreground",
                    )}
                  >
                    {t.kind === "lead" ? "Lead" : "Customer"} · {t.reference} · {t.location}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Your location</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={locate}
                disabled={locating || pending}
              >
                <LocateFixed /> {locating ? "Locating…" : fix ? "Retry" : "Get location"}
              </Button>
              <span className="text-sm text-muted-foreground">
                {locating
                  ? "Getting a GPS fix…"
                  : fix
                    ? `${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}${
                        fix.accuracy ? ` (±${Math.round(fix.accuracy)} m)` : ""
                      }`
                    : "No location yet."}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="visit-notes">Notes (optional)</Label>
            <Textarea
              id="visit-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What is this visit about?"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="visit-photo">Photo (optional)</Label>
            <Input
              id="visit-photo"
              type="file"
              accept="image/jpeg,image/png"
              // On a phone this offers the camera directly rather than only
              // the gallery.
              capture="environment"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending || !selected || !fix}>
            {pending ? "Checking in…" : "Check In"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
