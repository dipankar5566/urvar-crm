import {
  LayoutDashboard,
  UserPlus,
  KanbanSquare,
  Phone,
  CalendarClock,
  ListChecks,
  Building2,
  Network,
  Package,
  FileText,
  BarChart3,
  Users,
  ScrollText,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  UserPlus,
  KanbanSquare,
  Phone,
  CalendarClock,
  ListChecks,
  Building2,
  Network,
  Package,
  FileText,
  BarChart3,
  Users,
  ScrollText,
};

export function Icon({ name, className }: { name: string; className?: string }) {
  const Cmp = ICONS[name] ?? LayoutDashboard;
  return <Cmp className={className} />;
}
