"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type SearchResults = {
  leads: { id: string; name: string; leadNumber: string; phone: string }[];
  customers: { id: string; name: string; customerNumber: string; phone: string }[];
  quotations: { id: string; quotationNumber: string }[];
  products: { id: string; name: string; sku: string }[];
};

const EMPTY_RESULTS: SearchResults = { leads: [], customers: [], quotations: [], products: [] };

const GlobalSearchContext = createContext<(() => void) | null>(null);

export function useGlobalSearch(): () => void {
  const ctx = useContext(GlobalSearchContext);
  if (!ctx) throw new Error("useGlobalSearch must be used within <GlobalSearchProvider>");
  return ctx;
}

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!isOpen || query.trim().length < 2) return;
    const trimmed = query.trim();
    const timeout = setTimeout(() => {
      setLoading(true);
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}`)
        .then((res) => (res.ok ? res.json() : EMPTY_RESULTS))
        .then(setResults)
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timeout);
  }, [query, isOpen]);

  const handleOpenChange = useCallback((next: boolean) => {
    setIsOpen(next);
    if (!next) {
      setQuery("");
      setResults(EMPTY_RESULTS);
    }
  }, []);

  const trimmedQuery = query.trim();
  const searchActive = trimmedQuery.length >= 2;
  const displayedResults = searchActive ? results : EMPTY_RESULTS;
  const hasResults =
    displayedResults.leads.length > 0 ||
    displayedResults.customers.length > 0 ||
    displayedResults.quotations.length > 0 ||
    displayedResults.products.length > 0;

  return (
    <GlobalSearchContext.Provider value={open}>
      {children}
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent
          className="top-[20%] max-w-[calc(100%-2rem)] -translate-y-0 sm:max-w-lg"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">Search</DialogTitle>
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search leads, customers, quotations, products..."
          />
          <div className="max-h-80 overflow-y-auto">
            {!searchActive && (
              <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                Type at least 2 characters to search.
              </p>
            )}
            {searchActive && !loading && !hasResults && (
              <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                No results for &quot;{trimmedQuery}&quot;.
              </p>
            )}
            <ResultGroup
              icon="UserPlus"
              label="Leads"
              items={displayedResults.leads.map((l) => ({
                id: l.id,
                href: `/leads/${l.id}`,
                primary: l.name,
                secondary: `${l.leadNumber} · ${l.phone}`,
              }))}
              onNavigate={() => handleOpenChange(false)}
            />
            <ResultGroup
              icon="Building2"
              label="Customers"
              items={displayedResults.customers.map((c) => ({
                id: c.id,
                href: `/customers/${c.id}`,
                primary: c.name,
                secondary: `${c.customerNumber} · ${c.phone}`,
              }))}
              onNavigate={() => handleOpenChange(false)}
            />
            <ResultGroup
              icon="FileText"
              label="Quotations"
              items={displayedResults.quotations.map((q) => ({
                id: q.id,
                href: `/quotations/${q.id}`,
                primary: q.quotationNumber,
              }))}
              onNavigate={() => handleOpenChange(false)}
            />
            <ResultGroup
              icon="Package"
              label="Products"
              items={displayedResults.products.map((p) => ({
                id: p.id,
                href: "/products",
                primary: p.name,
                secondary: p.sku,
              }))}
              onNavigate={() => handleOpenChange(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </GlobalSearchContext.Provider>
  );
}

function ResultGroup({
  icon,
  label,
  items,
  onNavigate,
}: {
  icon: string;
  label: string;
  items: { id: string; href: string; primary: string; secondary?: string }[];
  onNavigate: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="py-1.5">
      <div className="flex items-center gap-1.5 px-1 pb-1 text-xs font-medium text-muted-foreground">
        <Icon name={icon} className="h-3.5 w-3.5" />
        {label}
      </div>
      {items.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          onClick={onNavigate}
          className="flex flex-col rounded-md px-2 py-1.5 text-sm hover:bg-accent"
        >
          <span>{item.primary}</span>
          {item.secondary && (
            <span className="text-xs text-muted-foreground">{item.secondary}</span>
          )}
        </Link>
      ))}
    </div>
  );
}
