import { useEffect, useMemo, useState } from 'react';

import {
  applySidebarPrefs,
  loadSidebarPrefs,
  moveItem,
  resetSidebarPrefs,
  saveSidebarPrefs,
  toggleHidden,
  type SidebarPrefs,
} from './sidebarPrefs';

/**
 * Vertical nav rail. Replaces the top-bar tabs + "Pages" subnav.
 *
 * Display modes:
 *   - **Expanded** (default ~184px) — icon + label per item, section
 *     headers between groups.
 *   - **Collapsed** (~52px) — icon-only, full label on hover.
 *   - **Edit** — toggled from the bottom: each item shows up/down +
 *     hide controls so the user can reorder within a section or hide
 *     items they don't use. Hidden items reappear as dimmed rows so
 *     un-hiding is one click. Persisted to localStorage via
 *     sidebarPrefs; reset restores the default layout.
 *
 * Icons are single-letter pills in a mono box — keeps the look
 * consistent with the rest of the terminal-aesthetic UI without
 * forcing us to design SVG glyphs for every entry.
 */

export interface SidebarItem {
  id: string;
  label: string;
  /** Short token shown in the icon pill (collapsed mode). Usually
   *  one letter, occasionally two. */
  icon: string;
  isActive: boolean;
  onClick: () => void;
  title?: string;
  /** Optional pending-count badge. Hidden when 0 or unset. */
  count?: number;
}

export interface SidebarSection {
  id: string;
  /** Section heading shown in expanded mode. Omit for a section that
   *  shouldn't render a label (e.g. the top "main nav" group). */
  label?: string;
  items: SidebarItem[];
}

interface Props {
  sections: SidebarSection[];
}

const COLLAPSED_KEY = 'jarvis.sidebar.collapsed';

export function Sidebar({ sections }: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // ignore — localStorage write failure isn't worth surfacing
    }
  }, [collapsed]);

  const [prefs, setPrefs] = useState<SidebarPrefs>(() => loadSidebarPrefs());
  const [editMode, setEditMode] = useState(false);
  const updatePrefs = (next: SidebarPrefs): void => {
    setPrefs(next);
    saveSidebarPrefs(next);
  };

  // Resolved view of the sections: ordered + filtered per user prefs.
  // We render hidden items in edit mode as dimmed rows so un-hiding
  // is reachable; outside edit mode hidden items disappear entirely.
  const resolved = useMemo(
    () => applySidebarPrefs(sections, prefs),
    [sections, prefs],
  );

  // In edit mode we also need to see the hidden items (with a "show"
  // affordance) — render them appended at the bottom of their section.
  const sectionsForRender = useMemo(() => {
    if (!editMode) return resolved;
    const hiddenSet = new Set(prefs.hidden);
    return sections.map((section) => {
      const resolvedSection = resolved.find((s) => s.id === section.id);
      const visible = resolvedSection?.items ?? [];
      const visibleIds = new Set(visible.map((i) => i.id));
      const hiddenItems = section.items.filter(
        (i) => hiddenSet.has(i.id) && !visibleIds.has(i.id),
      );
      return { ...section, items: [...visible, ...hiddenItems] };
    });
  }, [editMode, sections, resolved, prefs.hidden]);

  return (
    <aside
      className={`shell__sidebar${collapsed ? ' shell__sidebar--collapsed' : ''}${editMode ? ' shell__sidebar--edit' : ''}`}
    >
      <div className="shell__sidebar-body">
        {sectionsForRender.map((section, i) => (
          <div key={section.id} className="shell__sidebar-section">
            {!collapsed && section.label && i > 0 && (
              <div className="shell__sidebar-section-label">{section.label}</div>
            )}
            {section.items.map((item, idx) => {
              const isHidden = prefs.hidden.includes(item.id);
              const canMoveUp = editMode && idx > 0 && !isHidden;
              const canMoveDown =
                editMode &&
                idx < section.items.filter((i) => !prefs.hidden.includes(i.id)).length - 1 &&
                !isHidden;
              return (
                <div
                  key={item.id}
                  className={`shell__sidebar-row${isHidden ? ' shell__sidebar-row--hidden' : ''}`}
                >
                  <button
                    className={`shell__sidebar-item${item.isActive ? ' shell__sidebar-item--active' : ''}`}
                    onClick={editMode ? undefined : item.onClick}
                    disabled={editMode}
                    title={collapsed ? item.label : item.title}
                    type="button"
                  >
                    <span className="shell__sidebar-icon" aria-hidden="true">
                      {item.icon}
                      {item.count && item.count > 0 && collapsed ? (
                        <span className="shell__sidebar-dot" />
                      ) : null}
                    </span>
                    {!collapsed && (
                      <span className="shell__sidebar-label">{item.label}</span>
                    )}
                    {item.count && item.count > 0 && !collapsed ? (
                      <span className="shell__sidebar-badge">
                        {item.count > 99 ? '99+' : item.count}
                      </span>
                    ) : null}
                  </button>
                  {editMode && !collapsed && (
                    <div className="shell__sidebar-edit-controls">
                      <button
                        type="button"
                        className="shell__sidebar-edit-btn"
                        disabled={!canMoveUp}
                        onClick={() =>
                          updatePrefs(
                            moveItem(
                              prefs,
                              section.id,
                              item.id,
                              'up',
                              section.items
                                .filter((i) => !prefs.hidden.includes(i.id))
                                .map((i) => i.id),
                            ),
                          )
                        }
                        title="Move up"
                        aria-label="Move up"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className="shell__sidebar-edit-btn"
                        disabled={!canMoveDown}
                        onClick={() =>
                          updatePrefs(
                            moveItem(
                              prefs,
                              section.id,
                              item.id,
                              'down',
                              section.items
                                .filter((i) => !prefs.hidden.includes(i.id))
                                .map((i) => i.id),
                            ),
                          )
                        }
                        title="Move down"
                        aria-label="Move down"
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        className="shell__sidebar-edit-btn"
                        onClick={() => updatePrefs(toggleHidden(prefs, item.id))}
                        title={isHidden ? 'Show' : 'Hide'}
                        aria-label={isHidden ? 'Show' : 'Hide'}
                      >
                        {isHidden ? '◐' : '◯'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="shell__sidebar-footer">
        {editMode && !collapsed && (
          <button
            type="button"
            className="shell__sidebar-footer-btn"
            onClick={() => updatePrefs(resetSidebarPrefs())}
            title="Restore the default sidebar layout"
          >
            Reset
          </button>
        )}
        {!collapsed && (
          <button
            type="button"
            className={`shell__sidebar-footer-btn${editMode ? ' shell__sidebar-footer-btn--active' : ''}`}
            onClick={() => setEditMode((v) => !v)}
            title={editMode ? 'Done customizing' : 'Customize the sidebar'}
          >
            {editMode ? 'Done' : 'Customize'}
          </button>
        )}
        <button
          type="button"
          className="shell__sidebar-toggle"
          onClick={() => {
            if (editMode) setEditMode(false);
            setCollapsed((v) => !v);
          }}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>
    </aside>
  );
}
