import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <div className="w-full max-w-md">
      <div className="mb-6 text-center">
        <Image
          src="/urvar-icon.png"
          alt="Urvar"
          width={48}
          height={48}
          className="mx-auto mb-2 rounded-xl"
        />
        <h1 className="text-2xl font-semibold tracking-tight">Urvar CRM</h1>
        <p className="text-sm text-muted-foreground">
          Urvar Natural Pvt Ltd — Sales &amp; Distribution
        </p>
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
      <p className="mt-6 text-center text-xs text-muted-foreground">
        Trouble signing in? Contact your administrator.{" "}
        <Link href="/login" className="underline">
          Retry
        </Link>
      </p>
    </div>
  );
}
