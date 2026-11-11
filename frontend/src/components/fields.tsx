import {
  ChangeEvent,
  CSSProperties,
  Children,
  Fragment,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactElement,
  ReactNode,
  RefObject,
  SelectHTMLAttributes,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/utils";
import { orgDate } from "../utils/orgTime";
import { smartFilter } from "../utils/search";
import Highlight from "./Highlight";
import Icon from "./Icon";
import SearchInput from "./SearchInput";

/*
 * Custom dropdown, date, time and date-time controls, in place of the browser's own. Each one keeps a real, visually hidden
 * native control in the DOM (same value, same onChange, same label association), so forms, labels, validation and
 * assistive tech behave as before; the visible part is the styled trigger and its popover.
 */

const POP_Z = 600;
const LAYOUT_CLASS = /^(?:[a-z0-9]+:)*(?:w-|min-w-|max-w-|flex-|grow|shrink|basis-|col-|row-|self-|justify-self|m[trblxy]?-|-m)/;

/** Width, flex and margin utilities belong on the wrapper; everything else styles the trigger. */
function splitClasses(className = "") {
  const wrapper: string[] = [];
  const trigger: string[] = [];
  for (const c of className.split(/\s+/).filter(Boolean)) (LAYOUT_CLASS.test(c) ? wrapper : trigger).push(c);
  return { wrapper: wrapper.join(" "), trigger: trigger.join(" ") };
}

const fakeChange = <T extends HTMLElement>(value: string, name?: string) =>
  ({ target: { value, name }, currentTarget: { value, name }, type: "change" }) as unknown as ChangeEvent<T>;

/** Places a popover under (or over) its trigger, and closes it on outside press, scroll elsewhere and Escape. */
function usePopover(open: boolean, onClose: () => void, anchor: RefObject<HTMLElement>, pop: RefObject<HTMLElement>) {
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: 0, left: 0, visibility: "hidden", zIndex: POP_Z });

  useLayoutEffect(() => {
    if (!open) {
      setStyle((s) => ({ ...s, visibility: "hidden" }));
      return;
    }
    const place = () => {
      const a = anchor.current;
      const p = pop.current;
      if (!a || !p) return;
      const r = a.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const flip = below < p.offsetHeight + 12 && r.top > below;
      const top = flip ? Math.max(8, r.top - p.offsetHeight - 6) : r.bottom + 6;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8));
      setStyle({ position: "fixed", top, left, minWidth: r.width, zIndex: POP_Z, visibility: "visible" });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchor, pop]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const scroll = (e: Event) => {
      if (!pop.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, onClose, anchor, pop]);

  return style;
}

/* ------------------------------------------------------------------ Select */

interface Opt {
  value: string;
  label: ReactNode;
  text: string;
  disabled?: boolean;
}

const textOf = (node: ReactNode): string =>
  Children.toArray(node)
    .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isValidElement(c) ? textOf((c as ReactElement<{ children?: ReactNode }>).props.children) : ""))
    .join("");

function parseOptions(children: ReactNode): Opt[] {
  const out: Opt[] = [];
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
    if (el.type === "option") {
      const text = textOf(el.props.children);
      out.push({ value: String(el.props.value ?? text), label: el.props.children, text, disabled: el.props.disabled });
    } else if (el.type === Fragment || el.type === "optgroup") out.push(...parseOptions(el.props.children));
  });
  return out;
}

/** From this many options a dropdown gets a search box. */
const SEARCHABLE_FROM = 8;

const triggerBase = "input flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50";

export function Select({ className, children, value, onChange, disabled, required, name, id, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  const options = useMemo(() => parseOptions(children), [children]);
  const current = String(value ?? "");
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();
  const { wrapper, trigger: triggerCls } = splitClasses(className);
  const close = useCallback(() => setOpen(false), []);
  // Long lists get a search box (smart search: words, accents, typos, best match first).
  const searchable = options.length >= SEARCHABLE_FROM;
  const [query, setQuery] = useState("");
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => (searchable && query.trim() ? smartFilter(options, query, (o) => [o.text], { rank: true }) : options), [options, query, searchable]);
  const style = usePopover(open, close, wrap, searchable ? popRef : list);

  const show = () => {
    if (disabled) return;
    setQuery("");
    const i = options.findIndex((o) => o.value === current && !o.disabled);
    setActive(i >= 0 ? i : Math.max(0, options.findIndex((o) => !o.disabled)));
    setOpen(true);
  };
  useEffect(() => {
    if (open) requestAnimationFrame(() => (searchable ? searchRef : list).current?.focus({ preventScroll: true }));
  }, [open, searchable]);
  useEffect(() => {
    // A new search starts on its best match.
    if (open && searchable) setActive(Math.max(0, visible.findIndex((o) => !o.disabled)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const pick = (i: number) => {
    const o = visible[i];
    if (!o || o.disabled) return;
    onChange?.(fakeChange<HTMLSelectElement>(o.value, name));
    setOpen(false);
    trigger.current?.focus();
  };
  const step = (dir: 1 | -1, from = active) => {
    let i = from;
    for (let n = 0; n < visible.length; n++) {
      i = (i + dir + visible.length) % visible.length;
      if (!visible[i].disabled) return i;
    }
    return from;
  };

  const onTriggerKey = (e: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      show();
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Escape") {
      stop();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "ArrowDown") (stop(), setActive((a) => step(1, a)));
    else if (e.key === "ArrowUp") (stop(), setActive((a) => step(-1, a)));
    // In the search box Home, End and Space belong to the text, so only the list-only keys are claimed there.
    else if (e.key === "Home" && !searchable) (stop(), setActive(visible.findIndex((o) => !o.disabled)));
    else if (e.key === "End" && !searchable) (stop(), setActive(visible.length - 1 - [...visible].reverse().findIndex((o) => !o.disabled)));
    else if (e.key === "Enter" || (e.key === " " && !searchable)) (stop(), pick(active));
    else if (e.key === "Tab") setOpen(false);
    else if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const hit = visible.findIndex((o) => !o.disabled && o.text.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    }
  };

  const renderOptions = () =>
    visible.map((o, i) => (
      <li
        key={`${o.value}-${i}`}
        id={`${listId}-${i}`}
        role="option"
        aria-selected={o.value === current}
        aria-disabled={o.disabled || undefined}
        data-active={i === active}
        onPointerEnter={() => !o.disabled && setActive(i)}
        onClick={() => pick(i)}
        className={cn("pop-item", o.value === current && "is-selected", i === active && "is-active", o.disabled && "is-disabled")}
      >
        <span className="truncate">{searchable && query.trim() ? <Highlight text={o.text} query={query} /> : o.label}</span>
        {o.value === current && <Icon name="check" className="h-4 w-4 shrink-0" />}
      </li>
    ));

  return (
    <div ref={wrap} className={cn("relative", wrapper || "w-full")}>
      <select
        {...rest}
        id={id}
        name={name}
        className="sr-only"
        tabIndex={-1}
        value={value}
        onChange={onChange}
        disabled={disabled}
        required={required}
        onFocus={() => trigger.current?.focus()}
        onInvalid={() => trigger.current?.focus()}
      >
        {children}
      </select>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={rest["aria-label"]}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onTriggerKey}
        className={cn(triggerBase, "w-full", triggerCls)}
      >
        <span className={cn("truncate", !selected || selected.value === "" ? "text-neutral-400" : "")}>{selected ? selected.label : ""}</span>
        <Icon name="chevron_down" className={cn("h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open &&
        createPortal(
          searchable ? (
            <div ref={popRef} style={{ ...style, overflow: "hidden" }} onKeyDown={onListKey} className="pop flex w-72 max-w-[calc(100vw-16px)] flex-col">
              <div className="border-b border-ink-700 p-2">
                <SearchInput
                  ref={searchRef}
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search…"
                  aria-label="Search options"
                  role="combobox"
                  aria-expanded
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={visible[active] ? `${listId}-${active}` : undefined}
                  inputClassName="py-1.5"
                />
              </div>
              <ul ref={list} id={listId} role="listbox" className="max-h-56 overflow-y-auto overscroll-contain py-1 outline-none">
                {renderOptions()}
                {visible.length === 0 && (
                  <li className="px-3 py-3 text-center text-sm text-neutral-400" role="presentation">
                    No matches
                  </li>
                )}
              </ul>
            </div>
          ) : (
            <ul
              ref={list}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-activedescendant={`${listId}-${active}`}
              onKeyDown={onListKey}
              style={style}
              className="pop max-h-64 overflow-y-auto py-1 outline-none"
            >
              {renderOptions()}
            </ul>
          ),
          document.body
        )}
    </div>
  );
}

/* ------------------------------------------------------------- Date helpers */

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parseIso = (v: string | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? "");
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const prettyDate = (v: string) => {
  const p = parseIso(v);
  return p ? `${MONTHS[p.m].slice(0, 3)} ${p.d}, ${p.y}` : "";
};

function Calendar({ value, min, max, onPick }: { value: string; min?: string; max?: string; onPick: (iso: string) => void }) {
  const today = orgDate();
  const start = parseIso(value) ?? parseIso(today)!;
  const [view, setView] = useState({ y: start.y, m: start.m });
  const [focus, setFocus] = useState(parseIso(value)?.d ?? 0);
  const grid = useRef<HTMLDivElement>(null);
  const first = new Date(Date.UTC(view.y, view.m, 1)).getUTCDay();
  const days = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const shift = (delta: number) =>
    setView((v) => {
      const t = v.y * 12 + v.m + delta;
      return { y: Math.floor(t / 12), m: ((t % 12) + 12) % 12 };
    });
  const disabled = (d: number) => {
    const k = iso(view.y, view.m, d);
    return (!!min && k < min.slice(0, 10)) || (!!max && k > max.slice(0, 10));
  };

  useEffect(() => {
    const target = focus || (parseIso(today)?.y === view.y && parseIso(today)?.m === view.m ? parseIso(today)!.d : 1);
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${target}"]`)?.focus({ preventScroll: true });
    // Focus the selected day (or today) once when the calendar opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = Number((e.target as HTMLElement).dataset.day);
    if (!d) return;
    const move = (n: number) => {
      e.preventDefault();
      const next = d + n;
      if (next < 1) {
        shift(-1);
        const prevDays = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
        setFocus(prevDays + next);
      } else if (next > days) {
        shift(1);
        setFocus(next - days);
      } else grid.current?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus();
    };
    if (e.key === "ArrowLeft") move(-1);
    else if (e.key === "ArrowRight") move(1);
    else if (e.key === "ArrowUp") move(-7);
    else if (e.key === "ArrowDown") move(7);
    else if (e.key === "PageUp") (e.preventDefault(), shift(-1), setFocus(d));
    else if (e.key === "PageDown") (e.preventDefault(), shift(1), setFocus(d));
  };
  useEffect(() => {
    if (focus) grid.current?.querySelector<HTMLButtonElement>(`[data-day="${Math.min(focus, days)}"]`)?.focus({ preventScroll: true });
  }, [view, focus, days]);

  return (
    <div className="w-[17.5rem]">
      <div className="mb-3 flex items-center justify-between">
        <button type="button" className="cal-nav" onClick={() => (shift(-1), setFocus(0))} aria-label="Previous month">
          <Icon name="chevron_left" className="h-4 w-4" />
        </button>
        <p className="font-display text-base font-bold text-white" aria-live="polite">
          {MONTHS[view.m]} {view.y}
        </p>
        <button type="button" className="cal-nav" onClick={() => (shift(1), setFocus(0))} aria-label="Next month">
          <Icon name="chevron_right" className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-xs text-neutral-400">
        {WEEKDAYS.map((w) => (
          <span key={w} className="py-1">
            {w}
          </span>
        ))}
      </div>
      <div ref={grid} role="grid" onKeyDown={onKey} className="grid grid-cols-7 gap-y-1">
        {cells.map((d, i) =>
          d === null ? (
            <span key={`e${i}`} />
          ) : (
            <button
              key={d}
              type="button"
              data-day={d}
              disabled={disabled(d)}
              aria-label={`${MONTHS[view.m]} ${d}, ${view.y}`}
              aria-pressed={iso(view.y, view.m, d) === value.slice(0, 10)}
              onClick={() => onPick(iso(view.y, view.m, d))}
              className={cn("cal-day", iso(view.y, view.m, d) === today && "is-today", iso(view.y, view.m, d) === value.slice(0, 10) && "is-selected")}
            >
              {d}
            </button>
          )
        )}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-ink-700 pt-3 text-sm">
        <button
          type="button"
          className="text-brand-400 hover:underline disabled:opacity-40"
          disabled={(!!min && today < min.slice(0, 10)) || (!!max && today > max.slice(0, 10))}
          onClick={() => onPick(today)}
        >
          Today
        </button>
      </div>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));

function Column({ label, items, value, onPick }: { label: string; items: string[]; value: string; onPick: (v: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <div ref={ref} role="listbox" aria-label={label} className="time-col">
      {items.map((v) => (
        <button key={v} type="button" role="option" aria-selected={v === value} onClick={() => onPick(v)} className={cn("time-item", v === value && "is-selected")}>
          {v}
        </button>
      ))}
    </div>
  );
}

function TimePanel({ value, onChange }: { value: string; onChange: (hhmm: string) => void }) {
  const [h, m] = /^\d{2}:\d{2}/.test(value) ? value.split(":") : ["", ""];
  return (
    <div className="flex gap-2">
      <Column label="Hour" items={HOURS} value={h} onPick={(v) => onChange(`${v}:${m || "00"}`)} />
      <Column label="Minute" items={MINUTES} value={m} onPick={(v) => onChange(`${h || "00"}:${v}`)} />
    </div>
  );
}

/* ------------------------------------------------------------ Date and time */

type NativeProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "value"> & {
  value: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
};

function PickerShell({
  kind,
  className,
  value,
  onChange,
  min,
  max,
  disabled,
  required,
  name,
  id,
  placeholder,
  display,
  icon,
  children,
  closeOn,
  ...rest
}: Omit<NativeProps, "children"> & {
  kind: "date" | "time" | "datetime-local";
  display: string;
  icon: "calendar" | "clock";
  children: (api: { close: () => void; set: (v: string) => void }) => ReactNode;
  closeOn: "pick" | "never";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const { wrapper, trigger: triggerCls } = splitClasses(className);
  const close = useCallback(() => setOpen(false), []);
  const style = usePopover(open, close, wrap, pop);
  const set = (v: string) => {
    onChange?.(fakeChange<HTMLInputElement>(v, name));
    if (closeOn === "pick") {
      setOpen(false);
      trigger.current?.focus();
    }
  };
  useEffect(() => {
    if (!open) return;
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    // Capture phase on window so the dialog this sits in does not also close.
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [open]);

  return (
    <div ref={wrap} className={cn("relative", wrapper || "w-full")}>
      <input
        {...rest}
        id={id}
        name={name}
        type={kind}
        className="sr-only"
        tabIndex={-1}
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        disabled={disabled}
        required={required}
        onFocus={() => trigger.current?.focus()}
        onInvalid={() => trigger.current?.focus()}
      />
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={rest["aria-label"]}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(triggerBase, "w-full", triggerCls)}
      >
        <span className={cn("truncate tabular-nums", !display && "text-neutral-400")}>{display || placeholder || (kind === "time" ? "Select time" : "Select date")}</span>
        <Icon name={icon} className="h-4 w-4 shrink-0 text-neutral-400" />
      </button>
      {open &&
        createPortal(
          <div ref={pop} role="dialog" aria-label={kind === "time" ? "Choose a time" : "Choose a date"} style={style} className="pop p-4">
            {children({ close, set })}
          </div>,
          document.body
        )}
    </div>
  );
}

export function DateField(props: NativeProps) {
  return (
    <PickerShell {...props} kind="date" icon="calendar" display={prettyDate(props.value)} closeOn="pick">
      {({ set }) => <Calendar value={props.value} min={props.min as string | undefined} max={props.max as string | undefined} onPick={set} />}
    </PickerShell>
  );
}

export function TimeField(props: NativeProps) {
  return (
    <PickerShell {...props} kind="time" icon="clock" display={/^\d{2}:\d{2}/.test(props.value) ? props.value.slice(0, 5) : ""} closeOn="never">
      {({ set, close }) => (
        <div>
          <TimePanel value={props.value} onChange={set} />
          <div className="mt-3 flex justify-end border-t border-ink-700 pt-3">
            <button type="button" className="text-sm text-brand-400 hover:underline" onClick={close}>
              Done
            </button>
          </div>
        </div>
      )}
    </PickerShell>
  );
}

/** value: "YYYY-MM-DDTHH:mm", the same shape as <input type="datetime-local">. */
export function DateTimeField(props: NativeProps) {
  const v = props.value ?? "";
  const date = v.slice(0, 10);
  const time = v.length >= 16 ? v.slice(11, 16) : "";
  const display = date ? `${prettyDate(date)}, ${time || "00:00"}` : "";
  return (
    <PickerShell {...props} kind="datetime-local" icon="calendar" display={display} closeOn="never" placeholder="Select date and time">
      {({ set, close }) => (
        <div>
          <div className="flex flex-wrap gap-4">
            <Calendar value={date} min={props.min as string | undefined} max={props.max as string | undefined} onPick={(d) => set(`${d}T${time || "00:00"}`)} />
            <TimePanel value={time} onChange={(t) => set(`${date || orgDate()}T${t}`)} />
          </div>
          <div className="mt-3 flex justify-end border-t border-ink-700 pt-3">
            <button type="button" className="text-sm text-brand-400 hover:underline" onClick={close}>
              Done
            </button>
          </div>
        </div>
      )}
    </PickerShell>
  );
}
