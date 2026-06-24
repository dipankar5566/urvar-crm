"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const DEMO_ACCOUNTS = [
  { label: "Super Admin", email: "admin@urvar.in" },
  { label: "Sales Manager", email: "rajesh.manager@urvar.in" },
  { label: "Sales Executive", email: "priya.sales@urvar.in" },
  { label: "Distributor Mgr", email: "amit.distributor@urvar.in" },
  { label: "Accounts", email: "sunita.accounts@urvar.in" },
];

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("admin@urvar.in");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await signIn.email({ email, password });
    setLoading(false);
    if (error) {
      toast.error(error.message ?? "Invalid email or password");
      return;
    }
    toast.success("Welcome back");
    const from = params.get("from");
    router.push(from && from.startsWith("/") ? from : "/dashboard");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Enter your credentials to continue</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <div className="mt-6 rounded-lg border bg-muted/40 p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Demo accounts (password: <code>Urvar@123</code>)
          </p>
          <div className="flex flex-wrap gap-1.5">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.email}
                type="button"
                onClick={() => {
                  setEmail(a.email);
                  setPassword("Urvar@123");
                }}
                className="rounded-md border bg-background px-2 py-1 text-xs hover:bg-accent"
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
