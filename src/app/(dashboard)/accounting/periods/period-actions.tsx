"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { closePeriod, reopenPeriod, lockPeriod, openFinancialYear } from "../actions";

type Status = "OPEN" | "CLOSED" | "LOCKED";
type Result = { error: string } | { success: true };

export function PeriodRowActions({
  periodId,
  label,
  status,
  isSuperAdmin,
}: {
  periodId: string;
  label: string;
  status: Status;
  isSuperAdmin: boolean;
}) {
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<Result>, ok: string) =>
    start(async () => {
      const result = await fn();
      if ("error" in result) toast.error(result.error);
      else toast.success(ok);
    });

  if (status === "LOCKED") {
    return <span className="text-xs text-muted-foreground">Sealed</span>;
  }

  return (
    <div className="flex justify-end gap-2">
      {status === "OPEN" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => closePeriod(periodId), `${label} closed.`)}
        >
          Close
        </Button>
      ) : (
        isSuperAdmin && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => reopenPeriod(periodId), `${label} reopened.`)}
          >
            Reopen
          </Button>
        )
      )}
      {isSuperAdmin && status === "CLOSED" && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            const warning =
              `Lock ${label} permanently?\n\n` +
              `Nothing will ever be able to post into it or reopen it. ` +
              `Only do this once the GST returns for this period have been filed.`;
            if (!window.confirm(warning)) return;
            run(() => lockPeriod(periodId), `${label} locked.`);
          }}
        >
          Lock
        </Button>
      )}
    </div>
  );
}

export function OpenYearButton({ financialYear, label }: { financialYear: number; label: string }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  if (done) return null;

  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await openFinancialYear(financialYear);
          if ("error" in result) {
            toast.error(result.error);
          } else {
            toast.success(`FY ${label} opened.`);
            setDone(true);
          }
        })
      }
    >
      Open FY {label}
    </Button>
  );
}
