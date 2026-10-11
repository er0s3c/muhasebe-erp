## 2024-10-11 - React.memo Optimization in SidebarLink
**Learning:** `SidebarLink` component in `AppShell.tsx` renders repeatedly when scrolling through or clicking navigation items because it receives fresh callbacks or layout changes but doesn't actually need to re-render if the item and active state remain the same. This can add up since the sidebar often contains dozens of links across groups.
**Action:** Use `React.memo` for `SidebarLink` with a custom comparison function (or ensuring props don't break memoization) to avoid unnecessary re-renders of navigation items.
