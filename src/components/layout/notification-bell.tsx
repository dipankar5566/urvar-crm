"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getRecentNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./notification-actions";

type NotificationItem = {
  id: string;
  title: string;
  body: string | null;
  isRead: boolean;
  createdAt: Date;
  relatedLeadId: string | null;
};

export function NotificationBell({
  initialNotifications,
  initialUnreadCount,
}: {
  initialNotifications: NotificationItem[];
  initialUnreadCount: number;
}) {
  const router = useRouter();
  const [notifications, setNotifications] = useState(initialNotifications);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);

  useEffect(() => {
    const interval = setInterval(async () => {
      const data = await getRecentNotifications();
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  async function onSelect(n: NotificationItem) {
    if (!n.isRead) {
      await markNotificationRead(n.id);
      setNotifications((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)),
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    if (n.relatedLeadId) router.push(`/leads/${n.relatedLeadId}`);
  }

  async function onMarkAllRead() {
    await markAllNotificationsRead();
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Notifications" className="relative" />
        }
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <Badge className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px]">
            {unreadCount > 9 ? "9+" : unreadCount}
          </Badge>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-1.5 py-1">
          <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
          {unreadCount > 0 && (
            <button
              onClick={onMarkAllRead}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Mark all read
            </button>
          )}
        </div>
        <DropdownMenuSeparator />
        {notifications.length === 0 && (
          <p className="px-1.5 py-4 text-center text-sm text-muted-foreground">
            No notifications yet.
          </p>
        )}
        {notifications.map((n) => (
          <DropdownMenuItem
            key={n.id}
            onClick={() => onSelect(n)}
            className="flex-col items-start gap-0.5 whitespace-normal"
          >
            <div className="flex w-full items-center gap-1.5">
              {!n.isRead && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
              <span className="text-sm font-medium">{n.title}</span>
            </div>
            {n.body && <p className="text-xs text-muted-foreground">{n.body}</p>}
            <p className="text-[10px] text-muted-foreground">
              {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
            </p>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
