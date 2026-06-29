"use client";

import { useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MapPin, Pencil, LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { updateCustomerLocation, clearCustomerLocation } from "../actions";
import type { Pin } from "./location-map";

const LocationMap = dynamic(() => import("./location-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
});

export function LocationDialog({
  customerId,
  latitude,
  longitude,
}: {
  customerId: string;
  latitude: number | null;
  longitude: number | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [locating, setLocating] = useState(false);
  const hasLocation = latitude != null && longitude != null;

  // Re-derived fresh from props every time the dialog opens (see handleOpenChange) so a
  // previous open/cancel cycle never leaks a stale draft or stale map center into the next.
  const [draft, setDraft] = useState<Pin | null>(
    hasLocation ? { lat: latitude, lng: longitude } : null,
  );

  function handleOpenChange(next: boolean) {
    if (next) {
      setDraft(hasLocation ? { lat: latitude, lng: longitude } : null);
    }
    setOpen(next);
  }

  function handleUseMyLocation() {
    if (!navigator.geolocation) {
      toast.error("Geolocation isn't supported on this device — tap the map to drop a pin manually.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        setDraft({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => {
        setLocating(false);
        toast.error("Couldn't get your location — tap the map to drop a pin manually.");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  function handleSave() {
    if (!draft) return;
    startTransition(async () => {
      const result = await updateCustomerLocation(customerId, {
        latitude: draft.lat,
        longitude: draft.lng,
      });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Location saved");
      setOpen(false);
      router.refresh();
    });
  }

  function handleClear() {
    startTransition(async () => {
      const result = await clearCustomerLocation(customerId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Location cleared");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button variant="outline" size="sm" />}
      >
        {hasLocation ? (
          <>
            <Pencil /> Edit Location
          </>
        ) : (
          <>
            <MapPin /> Set Location on Map
          </>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{hasLocation ? "Edit Location" : "Set Location"}</DialogTitle>
        </DialogHeader>
        <Button
          variant="outline"
          size="sm"
          onClick={handleUseMyLocation}
          disabled={locating || pending}
          className="w-fit"
        >
          <LocateFixed /> {locating ? "Getting your location…" : "Use My Location"}
        </Button>
        <div className="h-[420px] w-full overflow-hidden rounded-md">
          {open && (
            <LocationMap key={customerId} value={draft} onChange={setDraft} />
          )}
        </div>
        <DialogFooter>
          {hasLocation && (
            <Button
              variant="outline"
              onClick={handleClear}
              disabled={pending}
              className="sm:mr-auto"
            >
              Clear
            </Button>
          )}
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={pending || !draft}>
            {pending ? "Saving…" : "Save Location"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
