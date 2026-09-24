const inputClass = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const buttonClass = "h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground";

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The GET date-range filter duplicated verbatim across every Phase 5 report page (profit-and-loss, ledger, gst) — factored out once Phase 8 adds a dozen more pages needing the same two inputs. `hidden` carries any extra GET params (e.g. a selected party) that must round-trip in the same form — never a second nested <form>. */
export function DateRangeFilterForm({ from, to, hidden }: { from: string; to: string; hidden?: Record<string, string> }) {
  return (
    <form method="GET" className="flex items-end gap-3">
      {hidden && Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <div className="space-y-1">
        <label htmlFor="from" className="text-xs text-muted-foreground">From</label>
        <input id="from" name="from" type="date" defaultValue={from} className={inputClass} />
      </div>
      <div className="space-y-1">
        <label htmlFor="to" className="text-xs text-muted-foreground">To</label>
        <input id="to" name="to" type="date" defaultValue={to} className={inputClass} />
      </div>
      <button type="submit" className={buttonClass}>Update</button>
    </form>
  );
}

/** The single as-of-date filter used by trial-balance/balance-sheet/ar-ageing. */
export function AsOfFilterForm({ asOf }: { asOf: string }) {
  return (
    <form method="GET" className="flex items-end gap-3">
      <div className="space-y-1">
        <label htmlFor="asOf" className="text-xs text-muted-foreground">As of</label>
        <input id="asOf" name="asOf" type="date" defaultValue={asOf} className={inputClass} />
      </div>
      <button type="submit" className={buttonClass}>Update</button>
    </form>
  );
}
