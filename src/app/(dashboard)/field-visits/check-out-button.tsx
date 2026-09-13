"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getCurrentPosition } from "@/lib/geolocation";
import { checkOut } from "./actions";

export function CheckOutButton({ visitId }: { visitId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();

  function handleCheckOut() {
    startTransition(async () => {
      // Taken at the moment of check-out rather than reusing the check-in
      // fix: leaving from somewhere else is exactly what this records.
      let fix;
      try {
        fix = await getCurrentPosition();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't get your location.");
        return;
      }

      const result = await checkOut(visitId, {
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracy: fix.accuracy,
        notes,
      });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Checked out");
      setOpen(false);
      setNotes("");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        <LogOut /> Check Out
      </DialogTrigger>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>End this visit</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="checkout-notes">What came out of it? (optional)</Label>
          <Textarea
            id="checkout-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Outcome, next steps…"
            rows={3}
          />
          <p className="text-xs text-muted-foreground">
            Your location is captured again when you check out.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleCheckOut} disabled={pending}>
            {pending ? "Checking out…" : "Check Out"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
