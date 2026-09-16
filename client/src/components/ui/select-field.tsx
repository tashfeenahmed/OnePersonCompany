import type { ComponentProps, ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { cn } from "@/lib/utils";

// Radix reserves the empty string for a placeholder. Encode every item so an
// actual empty choice ("All", "No venture", etc.) remains selectable.
const encode = (value: string | number) => `option:${value}`;

type SelectFieldProps = Omit<ComponentProps<typeof SelectTrigger>, "value" | "defaultValue" | "onChange" | "children"> & {
  value: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
  placeholder?: string;
};

/** A compact, themed single-value field. IDs, labels and interaction handlers
 * belong to the trigger; the options render in the shared accessible popup. */
export function SelectField({ value, onValueChange, children, placeholder = "Choose…", disabled, className, ...props }: SelectFieldProps) {
  return (
    <Select value={encode(value)} onValueChange={(next) => onValueChange(next.slice("option:".length))} disabled={disabled}>
      <SelectTrigger {...props} className={cn("min-w-0 max-w-full", className)}>
        <SelectValue placeholder={placeholder} className="block! truncate" />
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="max-w-[min(32rem,var(--radix-select-content-available-width))]">
        {children}
      </SelectContent>
    </Select>
  );
}

export function SelectOption({ value, ...props }: Omit<ComponentProps<typeof SelectItem>, "value"> & { value: string | number }) {
  return <SelectItem {...props} value={encode(value)} />;
}
