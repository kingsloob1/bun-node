import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useId, useRef } from "react";
import { useUrlTab } from "../hooks/useUrlTab";
import { useRouter } from "../routing";
import { cx } from "./classNames";

/** One tab of {@link Tabs}. */
export interface TabItem<V extends string> {
  /** The tab's value, e.g. a job state. */
  value: V;
  /** The text on the tab. */
  label: ReactNode;
  /** A count shown as a badge beside the label; omitted when `undefined`. */
  count?: number;
  /** Not selectable. */
  disabled?: boolean;
}

/** Props of {@link Tabs}. */
export interface TabsProps<V extends string> {
  /** The tabs, in order. */
  tabs: readonly TabItem<V>[];
  /** The selected tab's value. */
  value: V;
  /** Called with the tab the user picked. */
  onChange: (value: V) => void;
  /** Accessible name of the tab list, e.g. "Job states". */
  label: string;
  /** The selected tab's content, rendered in the single tab panel. Omit to render only the tab list. */
  children?: ReactNode;
  /** `"auto"` selects on arrow-key focus; `"manual"` waits for Enter/Space. Defaults to `"auto"`. */
  activation?: "auto" | "manual";
  /** Extra class names on the wrapper. */
  className?: string;
}

/** Formats a tab count compactly: `1234` → `1.2K`. */
const countFormat = new Intl.NumberFormat(undefined, { notation: "compact" });

/**
 * Controlled tabs following the WAI-ARIA tabs pattern: `tablist`/`tab`/
 * `tabpanel`, one tab in the tab order (roving `tabIndex`), Left/Right to
 * move (wrapping), Home/End to jump. Disabled tabs are skipped.
 */
export function Tabs<V extends string>({
  tabs,
  value,
  onChange,
  label,
  children,
  activation = "auto",
  className,
}: TabsProps<V>) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const tabId = (index: number) => `${baseId}-tab-${index}`;
  const panelId = `${baseId}-panel`;
  const selectedIndex = tabs.findIndex((tab) => tab.value === value);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const enabled = tabs
      .map((tab, index) => ({ tab, index }))
      .filter(({ tab }) => !tab.disabled);
    if (enabled.length === 0) {
      return;
    }
    const current = enabled.findIndex(
      ({ index }) => tabId(index) === event.currentTarget.id,
    );
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        next = (current + 1) % enabled.length;
        break;
      case "ArrowLeft":
        next = (current - 1 + enabled.length) % enabled.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = enabled.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = enabled[next]!;
    listRef.current?.ownerDocument.getElementById(tabId(target.index))?.focus();
    if (activation === "auto") {
      onChange(target.tab.value);
    }
  };

  return (
    <div className={cx("tabs", className)}>
      <div
        ref={listRef}
        className="tabs-list"
        role="tablist"
        aria-label={label}
      >
        {tabs.map((tab, index) => {
          const selected = index === selectedIndex;
          // With nothing selected, the first enabled tab takes the tab stop.
          const tabStop =
            selected ||
            (selectedIndex === -1 &&
              index === tabs.findIndex((item) => !item.disabled));
          return (
            <button
              key={tab.value}
              id={tabId(index)}
              type="button"
              role="tab"
              className="tab"
              aria-selected={selected}
              aria-controls={children !== undefined ? panelId : undefined}
              tabIndex={tabStop ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => onChange(tab.value)}
              onKeyDown={onKeyDown}
            >
              <span className="tab-label">{tab.label}</span>
              {tab.count !== undefined && (
                <span
                  className="tab-count"
                  title={String(tab.count)}
                >
                  {countFormat.format(tab.count)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {children !== undefined && (
        <div
          id={panelId}
          className="tabs-panel"
          role="tabpanel"
          aria-labelledby={
            selectedIndex >= 0 ? tabId(selectedIndex) : undefined
          }
          tabIndex={0}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** Props of {@link UrlTabs}. */
export interface UrlTabsProps<V extends string> extends Omit<
  TabsProps<V>,
  "value" | "onChange"
> {
  /** The query parameter holding the tab, e.g. `"state"`. */
  param: string;
  /** The tab when the parameter is absent or not one of `tabs`; selecting it removes the parameter. */
  defaultValue: V;
  /** Query parameters to remove when the tab changes, e.g. `["offset"]` so paging restarts. */
  resetParams?: readonly string[];
  /** Called after the URL changed. */
  onChange?: (value: V) => void;
}

/**
 * {@link Tabs} whose selection lives in the query string (`?state=failed`),
 * so it survives reload and can be linked. Changes replace the history entry
 * (the router's `navigate(…, { replace: true })`), keep every other
 * parameter, and drop the `resetParams`.
 */
export function UrlTabs<V extends string>({
  param,
  defaultValue,
  resetParams = [],
  onChange,
  tabs,
  ...rest
}: UrlTabsProps<V>) {
  const { location, navigate } = useRouter();
  const value = useUrlTab(param, tabs, defaultValue);
  const select = useCallback(
    (next: V) => {
      const params = new URLSearchParams(location.search);
      if (next === defaultValue) {
        params.delete(param);
      } else {
        params.set(param, next);
      }
      if (next !== value) {
        for (const key of resetParams) {
          params.delete(key);
        }
      }
      const query = params.toString();
      navigate(`${location.path ?? "/"}${query ? `?${query}` : ""}`, {
        replace: true,
      });
      onChange?.(next);
    },
    [
      location.search,
      location.path,
      defaultValue,
      param,
      value,
      resetParams,
      navigate,
      onChange,
    ],
  );
  return (
    <Tabs
      {...rest}
      tabs={tabs}
      value={value}
      onChange={select}
    />
  );
}
