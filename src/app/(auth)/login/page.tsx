import Link from "next/link";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <div className="w-full max-w-md">
      <div className="mb-6 text-center">
        <div className="mb-2 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-green-600 text-lg font-bold text-white">
          U
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Urvar CRM</h1>
        <p className="text-sm text-muted-foreground">
          Urvar Natural Pvt Ltd — Sales &amp; Distribution
        </p>
      </div>
      <LoginForm />
      <p className="mt-6 text-center text-xs text-muted-foreground">
        Trouble signing in? Contact your administrator.{" "}
        <Link href="/login" className="underline">
          Retry
        </Link>
      </p>
    </div>
  );
}
