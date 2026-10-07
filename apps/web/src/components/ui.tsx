import type { ThreadStatus } from "@agentplane/contracts";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "~/lib/cn.ts";

/** Primary CTAs are square; secondary and ghost buttons get the md radius. */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap font-medium text-body-sm transition-colors disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4",
  {
    variants: {
      variant: {
        primary: "rounded-none bg-brand text-white hover:bg-brand-hover active:bg-brand-active",
        secondary:
          "rounded-md border bg-card text-foreground hover:bg-popover active:bg-popover/70",
        ghost: "rounded-md text-foreground/70 hover:bg-foreground/5 hover:text-foreground",
        danger: "rounded-md border border-destructive/40 text-destructive hover:bg-destructive/10",
      },
      size: {
        sm: "h-7 px-2.5",
        md: "h-8 px-3",
        icon: "size-7 rounded-md",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

/** The mono uppercase label that carries the brand chrome. */
export function Eyebrow({
  className,
  tone = "muted",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: "muted" | "brand" }) {
  return (
    <span
      className={cn(
        "text-mono-sm uppercase tracking-wider",
        tone === "brand" ? "text-brand-readable" : "text-foreground/45",
        className,
      )}
      {...props}
    />
  );
}

export function Chip({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-xs border bg-card px-1.5 text-mono-xs text-foreground/65 uppercase tracking-wider",
        className,
      )}
      {...props}
    />
  );
}

const STATUS_DOT: Record<ThreadStatus, string> = {
  idle: "bg-foreground/20",
  running: "bg-brand-readable animate-pulse-dot",
  "needs-input": "bg-warning",
  error: "bg-destructive",
};

export const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: "Idle",
  running: "Working",
  "needs-input": "Needs input",
  error: "Error",
};

export function StatusDot({ status, className }: { status: ThreadStatus; className?: string }) {
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[status]}
      className={cn("inline-block size-2 shrink-0 rounded-full", STATUS_DOT[status], className)}
    />
  );
}

/** A segmented control for small enumerations (provider, runtime mode). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  disabled,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      className={cn("inline-flex rounded-md border bg-background p-0.5", className)}
    >
      {options.map((option) => (
        // biome-ignore lint/a11y/useSemanticElements: ARIA radio buttons, styled as a segmented control.
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-6 cursor-pointer rounded-xs px-2 text-mono-xs uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            value === option.value
              ? "bg-card text-foreground shadow-xs"
              : "text-foreground/50 hover:text-foreground/80",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-xs border bg-card px-1 text-mono-xs text-foreground/55">{children}</kbd>
  );
}
