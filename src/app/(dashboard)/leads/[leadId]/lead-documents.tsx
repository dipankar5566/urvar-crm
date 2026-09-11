"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileTextIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { attachLeadDocument, applyExtractedFields, type FieldSuggestion } from "./document-actions";

const FIELD_LABELS: Record<string, string> = {
  companyName: "Company",
  contactPerson: "Contact person",
  email: "Email",
  district: "District",
  pincode: "Pincode",
  address: "Address",
  interestedProducts: "Interested products",
  expectedQuantity: "Expected quantity",
  cropInterest: "Crop interest",
  remarks: "Remarks",
};

export type LeadDocument = {
  id: string;
  fileName: string;
  sizeBytes: number;
  url: string;
};

/**
 * Attach a scan or photo to a lead and let it fill in gaps.
 *
 * Everything the document says is shown as a proposal next to what the lead
 * currently holds, and nothing is written until the rep ticks it. Fields
 * that would overwrite an existing value start unticked — filling a blank is
 * a much safer default than replacing something a human typed.
 */
export function LeadDocuments({ leadId, documents }: { leadId: string; documents: LeadDocument[] }) {
  const router = useRouter();
  const [isUploading, setIsUploading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [suggestions, setSuggestions] = useState<FieldSuggestion[] | null>(null);
  const [accepted, setAccepted] = useState<Record<string, string>>({});

  async function upload(file: File) {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await attachLeadDocument(leadId, formData);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }

      router.refresh();
      if (result.suggestions.length === 0) {
        toast.success("Document attached. Nothing new to add from it.");
        return;
      }
      setAccepted(
        Object.fromEntries(
          result.suggestions.filter((s) => s.current === null).map((s) => [s.field, s.suggested]),
        ),
      );
      setSuggestions(result.suggestions);
    } catch {
      toast.error("Could not read that document. Please try again.");
    } finally {
      setIsUploading(false);
    }
  }

  function apply() {
    startTransition(async () => {
      const result = await applyExtractedFields(leadId, accepted);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(
        result.updatedCount === 0
          ? "Document attached. No fields changed."
          : `Updated ${result.updatedCount} field${result.updatedCount === 1 ? "" : "s"}.`,
      );
      setSuggestions(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="lead-document">Attach a document</Label>
        <Input
          id="lead-document"
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          disabled={isUploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
            e.target.value = "";
          }}
        />
        <p className="text-xs text-muted-foreground">
          {isUploading
            ? "Reading the document…"
            : "PDF, JPG or PNG. We'll suggest details found in it — nothing changes until you confirm."}
        </p>
      </div>

      {documents.length > 0 && (
        <ul className="space-y-1">
          {documents.map((doc) => (
            <li key={doc.id}>
              <a
                href={doc.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 text-sm text-primary hover:underline"
              >
                <FileTextIcon className="size-4 shrink-0" />
                <span className="truncate">{doc.fileName}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {Math.max(1, Math.round(doc.sizeBytes / 1024))} KB
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={suggestions !== null} onOpenChange={(open) => !open && setSuggestions(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Found in this document</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Tick what you want to save to this lead. Anything that would replace an existing
            value is left unticked.
          </p>
          <div className="space-y-3 max-h-80 overflow-y-auto">
            {(suggestions ?? []).map((s) => (
              <div key={s.field} className="flex gap-3 items-start">
                <Checkbox
                  id={`sug-${s.field}`}
                  checked={s.field in accepted}
                  onCheckedChange={(checked) =>
                    setAccepted((prev) => {
                      const next = { ...prev };
                      if (checked) next[s.field] = s.suggested;
                      else delete next[s.field];
                      return next;
                    })
                  }
                />
                <div className="space-y-0.5 min-w-0">
                  <Label htmlFor={`sug-${s.field}`} className="text-sm">
                    {FIELD_LABELS[s.field] ?? s.field}
                  </Label>
                  <p className="text-sm break-words">{s.suggested}</p>
                  {s.current !== null && (
                    <p className="text-xs text-muted-foreground break-words">
                      Replaces: {s.current}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSuggestions(null)}>
              Skip
            </Button>
            <Button size="sm" disabled={isPending} onClick={apply}>
              <UploadIcon /> Save selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
