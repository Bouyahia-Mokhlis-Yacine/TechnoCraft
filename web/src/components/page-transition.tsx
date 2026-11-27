import { ViewTransition } from 'react';

// Page enter / exit. Used by route templates: a template remounts whenever its child segment
// changes (a layout does not), so the outgoing page plays its exit and the incoming page its enter.
// Back navigations (Back button, breadcrumbs) carry "nav-back" and slide the other way; filter
// changes and refreshes keep the same segment and don't animate.
const MAP = { 'nav-back': 'nav-back', default: 'page' };

export function PageTransition({ children }: { children: React.ReactNode }) {
  return <ViewTransition enter={MAP} exit={MAP} default="none">{children}</ViewTransition>;
}
