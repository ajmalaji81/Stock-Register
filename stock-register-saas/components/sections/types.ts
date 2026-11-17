import type { Permission } from "@/lib/permissions";
import type { Scope, Workspace } from "@/lib/types";

/** Props every workspace section receives. Sections fetch their own data from /api/*. */
export interface SectionProps {
  ws: Workspace;
  /** "ALL" or the selected godown id (top-bar location switcher). */
  scope: Scope;
  scopeName: string;
  /** Bumps after every successful change anywhere in the app; refetch when it changes. */
  version: number;
  /** Reload items / godowns / stock after a change that affects them (e.g. a bill moved stock). */
  refresh: () => Promise<void>;
  /** Show a toast. bad = error style. */
  notify: (text: string, bad?: boolean) => void;
  can: (p: Permission) => boolean;
}
