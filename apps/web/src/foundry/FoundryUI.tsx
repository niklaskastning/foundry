import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

function Panel({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "min-w-0 space-y-5 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-6",
        className,
      )}
      {...props}
    />
  );
}

function Heading({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn("text-base font-semibold leading-6 tracking-tight text-foreground", className)}
      {...props}
    />
  );
}

function Summary({ className, ...props }: ComponentProps<"summary">) {
  return (
    <summary
      className={cn(
        "cursor-pointer rounded-md text-sm font-medium leading-6 outline-none marker:text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

function Notice({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm leading-6 text-foreground wrap-break-word",
        className,
      )}
      role="alert"
      {...props}
    />
  );
}

function Empty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-xl border border-dashed bg-muted/20 p-6 text-sm leading-6 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export const FoundryUI = { Panel, Heading, Summary, Notice, Empty };
