"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type DeleteResult = { error: string } | { success: true };

/**
 * Per-row delete affordance, shared by every list page.
 *
 * Deletes are soft (the record keeps its row, gains a `deletedAt`) and are
 * Super Admin only — but this component doesn't enforce either. The page
 * decides whether to render it at all, and the Server Action behind
 * `onDelete` re-checks the role, because a hidden button is not a permission.
 */
export function DeleteRowButton({
  label,
  name,
  reference,
  onDelete,
}: {
  /** Singular noun for the confirmation copy, e.g. "lead". */
  label: string;
  /** The record's own name, shown in the prompt so a mis-aimed click is
   * obvious before it's confirmed rather than after. */
  name: string;
  /** Its human-readable id (LD-2026-0146 etc.), for rows whose names repeat. */
  reference?: string;
  onDelete: () => Promise<DeleteResult>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function confirmDelete() {
    startTransition(async () => {
      const result = await onDelete();
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`Deleted ${name}.`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`Delete ${name}`} />}
      >
        <Trash2Icon className="text-destructive" />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {reference
              ? `${reference} — this ${label} will no longer appear anywhere in the CRM, and it can't be undone from the app.`
              : `This ${label} will no longer appear anywhere in the CRM, and it can't be undone from the app.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" onClick={confirmDelete} disabled={pending}>
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
