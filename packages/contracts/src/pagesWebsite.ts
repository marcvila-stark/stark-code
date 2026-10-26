import * as Schema from "effect/Schema";

export const PagesWebsiteViewId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
);
const Coordinate = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: -50_000, maximum: 50_000 }),
);
export const PagesWebsiteBounds = Schema.Struct({
  viewId: PagesWebsiteViewId,
  environmentId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  x: Coordinate,
  y: Coordinate,
  width: Coordinate,
  height: Coordinate,
  visible: Schema.Boolean,
  captureSnapshot: Schema.optional(Schema.Boolean),
});
export type PagesWebsiteBounds = typeof PagesWebsiteBounds.Type;
// An in-memory backdrop for an app menu above the native website; never saved.
export const PagesWebsiteSnapshot = Schema.Struct({
  viewId: PagesWebsiteViewId,
  dataUrl: Schema.String.check(
    Schema.isMaxLength(16 * 1024 * 1024),
    Schema.isPattern(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
  ),
});
export type PagesWebsiteSnapshot = typeof PagesWebsiteSnapshot.Type;
export const PagesWebsiteNavigation = Schema.Struct({
  viewId: PagesWebsiteViewId,
  action: Schema.Literals(["home", "back", "forward", "reload", "open-external"]),
});
export type PagesWebsiteNavigation = typeof PagesWebsiteNavigation.Type;
export const PagesWebsiteState = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  signInRequired: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type PagesWebsiteState = typeof PagesWebsiteState.Type;
export const PagesWebsiteQuote = Schema.Struct({
  viewId: PagesWebsiteViewId,
  text: Schema.String.check(Schema.isMaxLength(8_000)),
  title: Schema.String,
  url: Schema.String,
});
export type PagesWebsiteQuote = typeof PagesWebsiteQuote.Type;
export interface PagesWebsiteBridge {
  getState(): Promise<PagesWebsiteState>;
  setBounds(input: PagesWebsiteBounds): Promise<PagesWebsiteSnapshot | null>;
  hide(viewId: string): Promise<void>;
  navigate(input: PagesWebsiteNavigation): Promise<void>;
  onState(listener: (state: PagesWebsiteState) => void): () => void;
  onQuote(listener: (quote: PagesWebsiteQuote) => void): () => void;
  onEscape(listener: (viewId: string) => void): () => void;
}
