## 2025-02-12 - Missing Keyboard Focus Indicators
**Learning:** Found that core interactive elements like `Button` and `SegmentedTabs` were missing explicit `focus-visible` styles, relying only on global/browser defaults which can be inconsistent or overridden.
**Action:** Always verify keyboard navigation by adding `focus-visible:outline-2 focus-visible:outline-offset-2` (or similar focus ring classes) to interactive components to ensure a clear visual cue for keyboard users.
