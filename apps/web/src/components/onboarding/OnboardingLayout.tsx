import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { BRAND } from "@starkfuture/shared/branding";
import { cn } from "../../lib/utils";

/** This setup shell owns its presentation; ordinary app dialogs keep theirs. */
export function OnboardingPopup({
  children,
  initialFocus,
}: {
  readonly children: ReactNode;
  readonly initialFocus?: DialogPrimitive.Popup.Props["initialFocus"];
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        forceRender
        className="stark-review-surface fixed inset-0 z-50 bg-background"
        style={{
          backgroundColor: "#101112",
          backgroundImage:
            "radial-gradient(ellipse at 50% 20%, var(--sr-card, #1a1c1d), var(--sr-bg, #101112) 65%)",
        }}
      />
      <DialogPrimitive.Popup
        initialFocus={initialFocus}
        className="stark-review-surface fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-32px)] w-[min(710px,calc(100%-30px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-2xl border border-border bg-popover text-foreground outline-none [-webkit-app-region:no-drag]"
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export function OnboardingHeader({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <header className="border-b border-border">
      <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
      <div
        className="flex items-center gap-3 px-8 py-6 text-base font-semibold max-sm:px-6"
        aria-label={BRAND.productName}
      >
        <span className="size-4.5 shrink-0 rounded-full border-2 border-primary" aria-hidden />
        {BRAND.productName}
      </div>
      {children}
    </header>
  );
}

export function OnboardingSteps({
  steps,
  currentStep,
  isStepDisabled,
  onStepChange,
}: {
  readonly steps: readonly string[];
  readonly currentStep: number;
  readonly isStepDisabled: (index: number) => boolean;
  readonly onStepChange: (index: number) => void;
}) {
  return (
    <ol
      aria-label="Setup progress"
      className="flex flex-wrap items-center gap-x-7 gap-y-2 px-8 pb-5.5 text-xs max-sm:gap-x-5 max-sm:px-6"
    >
      {steps.map((step, index) => (
        <li key={step}>
          <button
            type="button"
            aria-label={`${step}, step ${index + 1}`}
            aria-current={index === currentStep ? "step" : undefined}
            disabled={isStepDisabled(index)}
            onClick={() => onStepChange(index)}
            className={cn(
              "cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default",
              index === currentStep ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {index + 1} {step}
          </button>
        </li>
      ))}
    </ol>
  );
}

export function OnboardingPanel({ children }: { readonly children: ReactNode }) {
  return <div className="min-w-0 p-8 max-sm:p-6">{children}</div>;
}
