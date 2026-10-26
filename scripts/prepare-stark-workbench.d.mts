export interface PrepareStarkWorkbenchOptions {
  readonly vendorRoot?: string;
  readonly destination?: string;
  readonly force?: boolean;
}

/** Verify and extract the pinned offline Workbench payload for development or packaging. */
export function prepareStarkWorkbench(options?: PrepareStarkWorkbenchOptions): string;
