import { InputHTMLAttributes, KeyboardEvent, ReactNode, forwardRef, useImperativeHandle, useRef } from "react";
import Icon from "./Icon";

/**
 * The one search box. Magnifier on the left, a clear button on the right once there is text, Escape clears,
 * and an optional result note ("3 of 12") that never crowds the text. A plain text input underneath, so labels,
 * tests and autofill behave like any other field.
 */
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Small text inside the box, e.g. "3 of 12". Hidden on narrow screens. */
  note?: ReactNode;
  /** Anything to show at the far right (a spinner while a request runs). */
  trailing?: ReactNode;
  inputClassName?: string;
};

const SearchInput = forwardRef<HTMLInputElement, Props>(function SearchInput({ value, onValueChange, note, trailing, className = "", inputClassName = "", ...rest }, forwarded) {
  const ref = useRef<HTMLInputElement>(null);
  useImperativeHandle(forwarded, () => ref.current as HTMLInputElement);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    rest.onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && value) {
      // Clear first; only a second Escape is allowed to close the dialog around it.
      e.preventDefault();
      e.stopPropagation();
      onValueChange("");
    }
  };
  return (
    <div className={`relative ${className}`}>
      <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
      <input
        {...rest}
        ref={ref}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className={`input pl-10 ${value || trailing ? "pr-10" : ""} ${note && value ? "sm:pr-24" : ""} ${inputClassName}`}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {note && value && <span className="hidden whitespace-nowrap pr-1 text-[11px] tabular-nums text-neutral-500 sm:inline">{note}</span>}
        {trailing}
        {value && (
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 transition-colors hover:bg-white/10 hover:text-white active:bg-white/10"
            aria-label="Clear search"
            onClick={() => {
              onValueChange("");
              ref.current?.focus();
            }}
          >
            <Icon name="close" className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
});

export default SearchInput;
