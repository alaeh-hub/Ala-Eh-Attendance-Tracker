import { KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import api from "../../services/api";
import type { User } from "../../types";
import Icon from "../Icon";
import { Spinner } from "../ui";
import { isCancelled, totalCount, useLatestRequest } from "./request";

export type PickedEmployee = Pick<User, "id" | "full_name"> & Partial<Pick<User, "employee_code" | "department">>;

/**
 * Server-side employee search (`GET /users?q=&limit=&status=`), debounced and
 * guarded against stale responses. Used instead of downloading every user.
 */
export function useUserSearch(query: string, { status = "active", limit = 20, enabled = true }: { status?: "active" | "inactive" | "all"; limit?: number; enabled?: boolean } = {}) {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const begin = useLatestRequest();

  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(async () => {
      const req = begin();
      setLoading(true);
      setError(false);
      try {
        const params: Record<string, string | number> = { limit };
        if (query.trim()) params.q = query.trim();
        if (status !== "all") params.status = status;
        const res = await api.get<User[]>("/users", { params, signal: req.signal });
        if (!req.isCurrent()) return;
        setUsers(res.data);
        setTotal(totalCount(res.headers, res.data.length));
      } catch (err) {
        if (!req.isCurrent() || isCancelled(err)) return;
        setError(true);
        setUsers([]);
      } finally {
        if (req.isCurrent()) setLoading(false);
      }
    }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, status, limit, enabled, begin]);

  return { users, total, loading, error };
}

/** Searchable single-employee combobox. */
export default function EmployeePicker({
  value,
  onChange,
  label = "Employee",
  status = "active",
  placeholder = "Search by name, ID or email…",
  autoFocus = false,
  excludeRoles = [],
}: {
  value: PickedEmployee | null;
  onChange: (u: PickedEmployee | null) => void;
  label?: string;
  status?: "active" | "inactive" | "all";
  placeholder?: string;
  autoFocus?: boolean;
  /** Accounts with these roles are never offered (e.g. KIOSK device accounts have no face). */
  excludeRoles?: readonly string[];
}) {
  const id = useId();
  const listId = `${id}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const search = useUserSearch(query, { status, enabled: open && !value });
  const { total, loading, error } = search;
  const users = excludeRoles.length ? search.users.filter((u) => !excludeRoles.includes(u.role)) : search.users;

  useEffect(() => setActive(0), [search.users]);

  function pick(u: User) {
    onChange({ id: u.id, full_name: u.full_name, employee_code: u.employee_code, department: u.department });
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(users.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (open && users[active]) {
        e.preventDefault();
        pick(users[active]);
      }
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
    }
  }

  if (value) {
    return (
      <div>
        <span className="label" id={`${id}-label`}>
          {label}
        </span>
        <div className="input flex items-center justify-between gap-2" aria-labelledby={`${id}-label`}>
          <span className="min-w-0 truncate text-white">
            {value.full_name}
            {value.employee_code && <span className="ml-1 font-mono text-xs text-neutral-500">({value.employee_code})</span>}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-lg px-2 py-0.5 text-xs font-semibold text-neutral-400 hover:bg-white/10 hover:text-white"
            onClick={() => {
              onChange(null);
              setOpen(true);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
            aria-label={`Change employee (selected: ${value.full_name})`}
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
        <input
          ref={inputRef}
          id={id}
          className="input pl-10"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && users[active] ? `${listId}-${users[active].id}` : undefined}
          autoComplete="off"
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
        {loading && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-400">
            <Spinner />
          </span>
        )}
      </div>
      {open && (
        <ul id={listId} role="listbox" aria-label={label} className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-white/10 bg-ink-850 p-1 shadow-xl">
          {users.map((u, i) => (
            <li
              key={u.id}
              id={`${listId}-${u.id}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(u)}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer rounded-lg px-3 py-2 text-sm ${i === active ? "bg-brand-500/15 text-white" : "text-neutral-300"}`}
            >
              <span className="font-semibold">{u.full_name}</span>
              <span className="ml-2 text-xs text-neutral-500">{[u.employee_code, u.department].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
          {!loading && users.length === 0 && (
            <li className="px-3 py-2 text-sm text-neutral-500" role="presentation">
              {error ? "Couldn't load employees." : "No matching employees."}
            </li>
          )}
          {total > search.users.length && (
            <li className="px-3 py-1.5 text-xs text-neutral-500" role="presentation">
              {total - search.users.length} more — keep typing to narrow down.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
