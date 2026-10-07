import { Check, ChevronDown, Search } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type ToggleEvent,
  useId,
  useMemo,
  useState,
} from "react";
import { cn } from "~/lib/cn.ts";
import { Eyebrow } from "./ui.tsx";

/**
 * Dropdowns in the design system: a square card panel with a hairline border
 * and a deep shadow (the landing site's nav menus), mono eyebrows for groups.
 * Built on the Popover API, so outside clicks and Escape close it natively.
 */

export type DropdownOption = {
  value: string;
  label: string;
  /** A muted second line. */
  description?: string | null;
  /** The second line is an id or path: set it in mono. */
  code?: boolean;
  /** A short mono tag on the right, e.g. "Default". */
  hint?: string | null;
  /** Options with the same group are listed under it, in first-seen order. */
  group?: string;
  disabled?: boolean;
};

/** Trigger looks: a form field, or a header chip. */
export const fieldTrigger =
  "flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-left font-mono text-[13px] text-foreground outline-none hover:border-foreground/25 focus-visible:border-brand-readable/60 disabled:cursor-not-allowed disabled:opacity-60";
export const chipTrigger =
  "inline-flex h-5 max-w-56 items-center gap-1 rounded-xs border bg-card pr-1 pl-1.5 text-mono-xs text-foreground/75 outline-none hover:border-foreground/25 focus-visible:border-brand-readable/60 disabled:cursor-not-allowed disabled:opacity-60";

const panelClass =
  "m-0 flex-col overflow-hidden border bg-card p-0 text-foreground shadow-xl open:flex";

const itemClass =
  "flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-40";

/** Lists longer than this get a search box. */
const SEARCH_AFTER = 10;

/** Put the panel under the trigger (or above it when there's no room), inside the viewport. */
function place(panel: HTMLElement, trigger: HTMLElement | null, align: "start" | "end"): void {
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const below = innerHeight - rect.bottom - 12;
  const above = rect.top - 12;
  const up = below < 260 && above > below;
  Object.assign(panel.style, {
    position: "fixed",
    inset: "auto",
    top: up ? "auto" : `${rect.bottom + 4}px`,
    bottom: up ? `${innerHeight - rect.top + 4}px` : "auto",
    left: align === "start" ? `${Math.max(8, rect.left)}px` : "auto",
    right: align === "end" ? `${Math.max(8, innerWidth - rect.right)}px` : "auto",
    minWidth: `${Math.max(rect.width, 192)}px`,
    maxWidth: `${Math.min(440, innerWidth - 16)}px`,
    maxHeight: `${Math.min(400, up ? above : below)}px`,
  });
}

/** Keep a panel that opened wider than the room on its side inside the viewport. */
function nudge(panel: HTMLElement): void {
  const rect = panel.getBoundingClientRect();
  if (rect.right > innerWidth - 8) {
    panel.style.left = `${Math.max(8, innerWidth - 8 - rect.width)}px`;
    panel.style.right = "auto";
  }
}

/** Arrow keys, Home and End move between items; typing in the search box stays put. */
function navigate(event: KeyboardEvent<HTMLElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-item]:not(:disabled)"),
  ];
  if (items.length === 0) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? Math.min(items.length - 1, index + 1)
          : index <= 0
            ? -1
            : index - 1;
  if (next === -1) {
    event.currentTarget.querySelector<HTMLInputElement>("[data-search]")?.focus();
    return;
  }
  items[next]?.focus();
}

function useDropdown(align: "start" | "end") {
  const id = `dropdown-${useId().replace(/[^\w-]/g, "")}`;
  const trigger = () => document.querySelector<HTMLElement>(`[popovertarget="${id}"]`);
  const close = () => {
    document.getElementById(id)?.hidePopover();
    trigger()?.focus();
  };
  const onBeforeToggle = (event: ToggleEvent<HTMLDivElement>) => {
    if (event.newState === "open") place(event.currentTarget, trigger(), align);
  };
  return { id, trigger, close, onBeforeToggle };
}

/** A list of actions, e.g. "New terminal with ▸ bash". */
export function Menu({
  label,
  title,
  heading,
  items,
  align = "start",
  triggerClassName,
  children,
}: {
  /** The trigger's accessible name. */
  label: string;
  title?: string;
  /** An eyebrow over the items. */
  heading?: string;
  items: Array<{ id: string; label: string; hint?: string | null; onSelect: () => void }>;
  align?: "start" | "end";
  triggerClassName?: string;
  /** The trigger's content. */
  children: ReactNode;
}) {
  const { id, close, onBeforeToggle } = useDropdown(align);
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={label}
        title={title ?? label}
        className={triggerClassName}
      >
        {children}
      </button>
      <div
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        onBeforeToggle={onBeforeToggle}
        onToggle={(event) => {
          if (event.newState !== "open") return;
          nudge(event.currentTarget);
          event.currentTarget.querySelector<HTMLElement>("[data-item]")?.focus();
        }}
        onKeyDown={navigate}
        className={panelClass}
      >
        {heading ? <Eyebrow className="px-4 pt-3 pb-1.5">{heading}</Eyebrow> : null}
        <ul className="min-h-0 overflow-y-auto">
          {items.map((item, index) => (
            <li key={item.id}>
              {index > 0 ? <div aria-hidden className="mx-4 border-t" /> : null}
              <button
                type="button"
                role="menuitem"
                data-item
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                className={cn(itemClass, "group justify-between gap-6 px-4 py-2.5")}
              >
                <span className="font-mono text-[12px] text-foreground/70 uppercase tracking-wider group-hover:text-foreground group-focus-visible:text-foreground">
                  {item.label}
                </span>
                {item.hint ? (
                  <span className="text-mono-xs text-foreground/35 uppercase tracking-wider">
                    {item.hint}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/**
 * Pick one value. Shows the chosen option's label (or `display`) in the
 * trigger; long lists get a search box.
 */
export function Select({
  value,
  options,
  onChange,
  label,
  title,
  placeholder = "Choose…",
  display,
  disabled,
  invalid,
  align = "start",
  triggerClassName = fieldTrigger,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** The trigger's accessible name. */
  label: string;
  title?: string;
  placeholder?: string;
  /** What the trigger shows instead of the chosen option's label. */
  display?: ReactNode;
  disabled?: boolean;
  invalid?: boolean;
  align?: "start" | "end";
  triggerClassName?: string;
}) {
  const { id, close, onBeforeToggle } = useDropdown(align);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);
  const searchable = options.length > SEARCH_AFTER;

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle
      ? options.filter((option) => `${option.label} ${option.value}`.toLowerCase().includes(needle))
      : options;
    const byGroup = new Map<string, DropdownOption[]>();
    for (const option of matching) {
      const group = option.group ?? "";
      byGroup.set(group, [...(byGroup.get(group) ?? []), option]);
    }
    return [...byGroup];
  }, [options, query]);

  const choose = (option: DropdownOption) => {
    close();
    if (option.value !== value) onChange(option.value);
  };

  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={label}
        title={title}
        disabled={disabled}
        className={cn(triggerClassName, invalid && "border-destructive/60")}
      >
        <span className={cn("min-w-0 truncate", !selected && !display && "text-foreground/40")}>
          {display ?? selected?.label ?? placeholder}
        </span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </button>
      <div
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        onBeforeToggle={(event) => {
          if (event.newState === "open") setQuery("");
          onBeforeToggle(event);
        }}
        onToggle={(event) => {
          if (event.newState !== "open") return;
          const panel = event.currentTarget;
          nudge(panel);
          (
            panel.querySelector<HTMLElement>("[data-search]") ??
            panel.querySelector<HTMLElement>('[aria-checked="true"]') ??
            panel.querySelector<HTMLElement>("[data-item]")
          )?.focus();
        }}
        onKeyDown={navigate}
        className={panelClass}
      >
        {searchable ? (
          <div className="flex shrink-0 items-center gap-2 border-b px-3">
            <Search className="size-3.5 shrink-0 text-foreground/35" />
            <input
              data-search
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                const first = groups[0]?.[1].find((option) => !option.disabled);
                if (event.key === "Enter" && first) {
                  event.preventDefault();
                  choose(first);
                }
              }}
              placeholder="Search"
              spellCheck={false}
              className="h-9 min-w-0 flex-1 bg-transparent text-body-sm outline-none placeholder:text-foreground/35"
            />
          </div>
        ) : null}
        <div className="min-h-0 overflow-y-auto py-1">
          {groups.length === 0 ? (
            <p className="px-3 py-2 text-caption text-foreground/45">Nothing matches.</p>
          ) : null}
          {groups.map(([group, members]) => (
            // biome-ignore lint/a11y/useSemanticElements: a labelled group of menu items.
            <div key={group} role="group" aria-label={group || undefined}>
              {group ? <Eyebrow className="px-3 pt-2.5 pb-1">{group}</Eyebrow> : null}
              {members.map((option) => {
                const checked = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    data-item
                    disabled={option.disabled}
                    onClick={() => choose(option)}
                    className={itemClass}
                  >
                    <Check
                      className={cn(
                        "size-3.5 shrink-0 text-brand-readable",
                        !checked && "invisible",
                      )}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-body-sm">{option.label}</span>
                      {option.description ? (
                        <span
                          className={cn(
                            "truncate text-foreground/45",
                            option.code ? "text-mono-xs" : "text-caption",
                          )}
                        >
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {option.hint ? (
                      <span className="shrink-0 text-mono-xs text-foreground/40 uppercase tracking-wider">
                        {option.hint}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
