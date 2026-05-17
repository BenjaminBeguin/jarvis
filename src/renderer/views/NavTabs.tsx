import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Top-nav tab row with overflow collapse + dropdown support.
 *
 * - Flat tabs (`kind: 'tab'`) render as buttons; an active flag drives
 *   the accent style and visited-from-this-tab routing decisions live
 *   in the caller's `onClick`.
 * - Dropdown tabs (`kind: 'dropdown'`) open a small menu on click. Used
 *   for the Build entry that groups Skills + Routines so they don't
 *   each take a top-level slot.
 * - When the row can't fit every item, the tail gets pushed into a
 *   `More ▾` dropdown at the end. We measure with a hidden mirror
 *   (same buttons, position: absolute, visibility: hidden) so we know
 *   the natural widths without showing them. ResizeObserver re-runs
 *   the calc when the window changes.
 *
 * The reserved width for the `More` button is approximate — overshoot
 * is fine, undershoot can cause oscillation (we count items, drop one,
 * which frees enough space to add it back, repeat). A 96px reserve has
 * been steady across Electron at 1024–1920px wide.
 */

export type NavTabItem =
  | {
      kind: 'tab';
      id: string;
      label: string;
      isActive: boolean;
      onClick: () => void;
      title?: string;
    }
  | {
      kind: 'dropdown';
      id: string;
      label: string;
      isActive: boolean;
      title?: string;
      options: Array<{
        id: string;
        label: string;
        isActive: boolean;
        onClick: () => void;
        hint?: string;
      }>;
    };

const MORE_RESERVE_PX = 96;

interface Props {
  items: NavTabItem[];
}

export function NavTabs({ items }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);

  useLayoutEffect(() => {
    const recalc = (): void => {
      const measureEl = measureRef.current;
      const containerEl = containerRef.current;
      if (!measureEl || !containerEl) return;

      const available = containerEl.offsetWidth;
      const children = Array.from(measureEl.children) as HTMLElement[];
      const widths = children.map((c) => c.offsetWidth);
      const totalNeeded = widths.reduce((a, b) => a + b, 0);

      if (totalNeeded <= available) {
        setVisibleCount(items.length);
        return;
      }

      const budget = available - MORE_RESERVE_PX;
      let used = 0;
      let count = 0;
      for (const w of widths) {
        if (used + w > budget) break;
        used += w;
        count += 1;
      }
      setVisibleCount(Math.max(1, count));
    };

    recalc();
    if (!containerRef.current) return;
    const observer = new ResizeObserver(recalc);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [items]);

  const visible = items.slice(0, visibleCount);
  const overflow = items.slice(visibleCount);

  return (
    <div ref={containerRef} className="shell__tabs">
      {/* Hidden mirror: same buttons at natural width so we can read
          offsetWidth without flashing the user. */}
      <div ref={measureRef} className="shell__tabs-measure" aria-hidden="true">
        {items.map((item) => (
          <button key={`m-${item.id}`} className="shell__tab" type="button">
            {item.kind === 'dropdown' ? `${item.label} ▾` : item.label}
          </button>
        ))}
      </div>

      {visible.map((item) =>
        item.kind === 'dropdown' ? (
          <DropdownTab key={item.id} item={item} />
        ) : (
          <FlatTab key={item.id} item={item} />
        ),
      )}
      {overflow.length > 0 && <OverflowDropdown items={overflow} />}
    </div>
  );
}

function FlatTab({ item }: { item: Extract<NavTabItem, { kind: 'tab' }> }) {
  return (
    <button
      className={`shell__tab${item.isActive ? ' shell__tab--active' : ''}`}
      onClick={item.onClick}
      title={item.title}
      type="button"
    >
      {item.label}
    </button>
  );
}

function DropdownTab({
  item,
}: {
  item: Extract<NavTabItem, { kind: 'dropdown' }>;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="shell__tab-wrap">
      <button
        className={`shell__tab shell__tab--has-menu${item.isActive ? ' shell__tab--active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={item.title}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
      >
        {item.label}
        <span className="shell__tab-caret">▾</span>
      </button>
      {open && (
        <div className="shell__tab-menu" role="menu">
          {item.options.map((opt) => (
            <button
              key={opt.id}
              role="menuitem"
              className={`shell__tab-menu-item${opt.isActive ? ' shell__tab-menu-item--active' : ''}`}
              onClick={() => {
                opt.onClick();
                setOpen(false);
              }}
              title={opt.hint}
              type="button"
            >
              <span>{opt.label}</span>
              {opt.hint && (
                <span className="shell__tab-menu-hint">{opt.hint}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Generic "More ▾" dropdown for the tail of items that couldn't fit
 * inline. Mirrors DropdownTab's open/close + outside-click behavior;
 * separate component so the items list can mix tab + dropdown shapes.
 */
function OverflowDropdown({ items }: { items: NavTabItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const anyActive = items.some((i) => i.isActive);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="shell__tab-wrap shell__nav-more">
      <button
        className={`shell__tab shell__tab--has-menu${anyActive ? ' shell__tab--active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={`${items.length} more`}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
      >
        More
        <span className="shell__tab-caret">▾</span>
      </button>
      {open && (
        <div className="shell__tab-menu" role="menu">
          {items.map((item) =>
            item.kind === 'tab' ? (
              <button
                key={item.id}
                role="menuitem"
                className={`shell__tab-menu-item${item.isActive ? ' shell__tab-menu-item--active' : ''}`}
                onClick={() => {
                  item.onClick();
                  setOpen(false);
                }}
                title={item.title}
                type="button"
              >
                {item.label}
              </button>
            ) : (
              <div key={item.id} className="shell__tab-menu-group">
                <div className="shell__tab-menu-group-label">{item.label}</div>
                {item.options.map((opt) => (
                  <button
                    key={opt.id}
                    role="menuitem"
                    className={`shell__tab-menu-item${opt.isActive ? ' shell__tab-menu-item--active' : ''}`}
                    onClick={() => {
                      opt.onClick();
                      setOpen(false);
                    }}
                    title={opt.hint}
                    type="button"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
