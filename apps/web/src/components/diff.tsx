import { cn } from "~/lib/cn.ts";

/** A unified diff, colored by line. */
export function Diff({ text }: { text: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-xs bg-background py-1.5 text-mono-sm">
      {text.split("\n").map((line, index) => (
        <div
          // Lines have no identity beyond their position.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={index}
          className={cn(
            "px-2",
            line.startsWith("+") && !line.startsWith("+++") && "bg-success/10 text-success",
            line.startsWith("-") && !line.startsWith("---") && "bg-destructive/10 text-destructive",
            (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) &&
              "text-foreground/40",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}
