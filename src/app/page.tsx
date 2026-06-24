import { redirect } from "next/navigation";

// Middleware normally redirects "/" already; this is a server-side fallback.
export default function RootPage() {
  redirect("/dashboard");
}
