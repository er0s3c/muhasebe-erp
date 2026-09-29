import {
  BookOpen,
  Building2,
  CalendarDays,
  Circle,
  Contact,
  Coins,
  FileText,
  Hourglass,
  LayoutDashboard,
  ListTree,
  Percent,
  Scale,
  Tags,
  Users,
  type LucideIcon,
} from 'lucide-react';

/** Modül kaydındaki (shared) ikon adı -> bileşen */
const NAV_ICONS: Record<string, LucideIcon> = {
  'layout-dashboard': LayoutDashboard,
  'book-open': BookOpen,
  'list-tree': ListTree,
  scale: Scale,
  'file-text': FileText,
  coins: Coins,
  percent: Percent,
  'calendar-days': CalendarDays,
  tags: Tags,
  users: Users,
  'building-2': Building2,
  contact: Contact,
  hourglass: Hourglass,
};

export const navIcon = (name: string): LucideIcon => NAV_ICONS[name] ?? Circle;
