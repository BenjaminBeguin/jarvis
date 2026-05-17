import { useEffect, useState } from 'react';

/**
 * Vertical nav rail. Replaces the top-bar tabs + "Pages" subnav. Two
 * states:
 *
 *   - **Expanded** (default ~180px) — icon + label per item, section
 *     headers between groups.
 *   - **Collapsed** (~52px) — icon-only, full label on hover. The
 *     toggle lives at the bottom of the rail.
 *
 * Collapse state is persisted to localStorage so it survives reload.
 * Sections render visual separators only when expanded; collapsed
 * mode is a single column of icons with section grouping implied by
 * the order alone (labels would just be ellipsed).
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

const STORAGE_KEY = 'jarvis.sidebar.collapsed';

export function Sidebar({ sections }: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      // ignore — localStorage write failure isn't worth surfacing
    }
  }, [collapsed]);

  return (
    <aside
      className={`shell__sidebar${collapsed ? ' shell__sidebar--collapsed' : ''}`}
    >
      <div className="shell__sidebar-body">
        {sections.map((section, i) => (
          <div key={section.id} className="shell__sidebar-section">
            {!collapsed && section.label && i > 0 && (
              <div className="shell__sidebar-section-label">{section.label}</div>
            )}
            {section.items.map((item) => (
              <button
                key={item.id}
                className={`shell__sidebar-item${item.isActive ? ' shell__sidebar-item--active' : ''}`}
                onClick={item.onClick}
                title={collapsed ? item.label : item.title}
                type="button"
              >
                <span className="shell__sidebar-icon" aria-hidden="true">
                  {item.icon}
                </span>
                {!collapsed && (
                  <span className="shell__sidebar-label">{item.label}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="shell__sidebar-toggle"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? '»' : '«'}
      </button>
    </aside>
  );
}
