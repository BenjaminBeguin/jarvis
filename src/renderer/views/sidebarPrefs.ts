import type { SidebarSection } from './Sidebar';

/**
 * User-customizable sidebar layout. Two knobs: hide individual items,
 * reorder items within their section. Cross-section moves are
 * intentionally NOT supported in v1 — the section structure (NAVIGATE
 * / CAPTURE / BUILD) carries meaning and unrestricted dragging would
 * blur it without much real benefit.
 *
 * Persisted to localStorage. Versioned so we can migrate the shape if
 * the customization model grows later without losing the user's prefs.
 */

const STORAGE_KEY = 'jarvis.sidebar.prefs.v1';

export interface SidebarPrefs {
  version: 1;
  /** Item IDs the user hid. We never delete from the source list —
   *  this filter is applied at render time so re-enabling is a
   *  one-click round trip. */
  hidden: string[];
  /** Per-section item ordering. New items not in the saved order get
   *  appended at the end of their section, so adding a built-in or
   *  module page later won't disappear behind a stale layout. */
  orderBySection: Record<string, string[]>;
}

export const DEFAULT_PREFS: SidebarPrefs = {
  version: 1,
  hidden: [],
  orderBySection: {},
};

export function loadSidebarPrefs(): SidebarPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<SidebarPrefs>;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PREFS;
    if (parsed.version !== 1) return DEFAULT_PREFS;
    return {
      version: 1,
      hidden: Array.isArray(parsed.hidden)
        ? parsed.hidden.filter((s): s is string => typeof s === 'string')
        : [],
      orderBySection:
        parsed.orderBySection && typeof parsed.orderBySection === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.orderBySection).flatMap(([k, v]) =>
                Array.isArray(v)
                  ? [[k, v.filter((s) => typeof s === 'string')]]
                  : [],
              ),
            )
          : {},
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveSidebarPrefs(prefs: SidebarPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage write failure isn't worth surfacing — the prefs
    // just won't persist past this session.
  }
}

/**
 * Apply user prefs to the default sections produced by Shell. Returns
 * a new list with:
 *   - items in user-chosen order (within each section)
 *   - hidden items removed
 *   - new items (not yet in user's order) appended to their section
 */
export function applySidebarPrefs(
  sections: SidebarSection[],
  prefs: SidebarPrefs,
): SidebarSection[] {
  const hiddenSet = new Set(prefs.hidden);
  return sections.map((section) => {
    const savedOrder = prefs.orderBySection[section.id] ?? [];
    const byId = new Map(section.items.map((i) => [i.id, i]));
    const ordered: typeof section.items = [];
    for (const id of savedOrder) {
      const item = byId.get(id);
      if (item) {
        ordered.push(item);
        byId.delete(id);
      }
    }
    // Append any items the user hasn't ordered yet (new module pages,
    // new built-ins). They land at the end of their section.
    for (const item of byId.values()) ordered.push(item);
    return {
      ...section,
      items: ordered.filter((i) => !hiddenSet.has(i.id)),
    };
  });
}

/**
 * Swap an item's position with its previous/next sibling within its
 * section. Returns a new prefs object; caller persists.
 */
export function moveItem(
  prefs: SidebarPrefs,
  sectionId: string,
  itemId: string,
  direction: 'up' | 'down',
  /** The current resolved order of items for that section — used to
   *  seed the saved order when we don't have one yet. */
  currentOrder: string[],
): SidebarPrefs {
  const baseOrder =
    prefs.orderBySection[sectionId]?.length === currentOrder.length
      ? [...prefs.orderBySection[sectionId]!]
      : [...currentOrder];
  const idx = baseOrder.indexOf(itemId);
  if (idx === -1) return prefs;
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= baseOrder.length) return prefs;
  [baseOrder[idx], baseOrder[target]] = [baseOrder[target]!, baseOrder[idx]!];
  return {
    ...prefs,
    orderBySection: {
      ...prefs.orderBySection,
      [sectionId]: baseOrder,
    },
  };
}

/** Toggle an item's hidden state. */
export function toggleHidden(prefs: SidebarPrefs, itemId: string): SidebarPrefs {
  const hidden = prefs.hidden.includes(itemId)
    ? prefs.hidden.filter((id) => id !== itemId)
    : [...prefs.hidden, itemId];
  return { ...prefs, hidden };
}

/** Restore the default layout — wipes order overrides + hidden list. */
export function resetSidebarPrefs(): SidebarPrefs {
  return { ...DEFAULT_PREFS };
}
