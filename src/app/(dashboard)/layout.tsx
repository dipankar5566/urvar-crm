import { requireUser } from "@/lib/session";
import { canAccess } from "@/lib/permissions";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { getRecentNotifications } from "@/components/layout/notification-actions";
import { CallProvider } from "@/components/calling/call-provider";
import { ActiveCallBar } from "@/components/calling/active-call-bar";
import { GlobalSearchProvider } from "@/components/search/global-search";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const { notifications, unreadCount } = await getRecentNotifications();
  const canCall = canAccess(user.role, "calls", "write");

  const body = (
    <div className="flex h-screen overflow-hidden">
      <Sidebar role={user.role} name={user.name} email={user.email} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar
          name={user.name}
          email={user.email}
          role={user.role}
          initialNotifications={notifications}
          initialUnreadCount={unreadCount}
        />
        <main className="flex-1 overflow-y-auto bg-muted/30 p-4 md:p-6">
          {children}
        </main>
      </div>
      {canCall && <ActiveCallBar />}
    </div>
  );

  const withCall = canCall ? <CallProvider>{body}</CallProvider> : body;

  return <GlobalSearchProvider>{withCall}</GlobalSearchProvider>;
}
