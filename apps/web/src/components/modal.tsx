import { X } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Button, Eyebrow } from "./ui.tsx";

/**
 * A native modal <dialog>. It opens itself from a ref callback when mounted,
 * so callers just render it conditionally.
 */
export function Modal({
  eyebrow,
  title,
  onClose,
  children,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; the native dialog closes on Esc.
    <dialog
      ref={(element) => {
        if (element && !element.open) element.showModal();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto max-h-[calc(100vh-32px)] w-[min(560px,calc(100vw-32px))] overflow-y-auto rounded-xl border bg-card p-0 text-foreground shadow-elevated backdrop:bg-black/50 backdrop:backdrop-blur-[2px]"
    >
      <div className="flex flex-col gap-5 p-5">
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <Eyebrow tone="brand">{eyebrow}</Eyebrow>
            <h2 className="text-h3">{title}</h2>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

/**
 * A labelled form row. Text inputs are wrapped in a <label>; button-based
 * pickers use a labelled group instead, since a <label> would forward clicks
 * on its text to the first button inside.
 */
export function Field({
  label,
  hint,
  group = false,
  children,
}: {
  label: string;
  hint?: string;
  group?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const content = (
    <>
      <Eyebrow id={id}>{label}</Eyebrow>
      {children}
      {hint ? <span className="text-caption text-foreground/45">{hint}</span> : null}
    </>
  );
  return group ? (
    <fieldset aria-labelledby={id} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
      {content}
    </fieldset>
  ) : (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children.
    <label className="flex flex-col gap-1.5">{content}</label>
  );
}

export const inputClass =
  "h-9 w-full rounded-md border bg-background px-3 font-mono text-[13px] text-foreground outline-none placeholder:text-foreground/30 focus:border-brand-readable/60";
