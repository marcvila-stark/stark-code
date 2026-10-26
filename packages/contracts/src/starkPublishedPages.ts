import * as Schema from "effect/Schema";

export const StarkPublishedPagesToolName = Schema.Literals([
  "pages_list_projects",
  "pages_search",
  "pages_read_content",
  "pages_read_file",
  "pages_get_public_url",
]);
export type StarkPublishedPagesToolName = typeof StarkPublishedPagesToolName.Type;
export const StarkPublishedPagesStatus = Schema.Struct({
  state: Schema.Literals(["signed-out", "connecting", "connected", "error"]),
  message: Schema.NullOr(Schema.String),
});
export type StarkPublishedPagesStatus = typeof StarkPublishedPagesStatus.Type;
export const StarkPublishedPagesTool = Schema.Struct({
  name: StarkPublishedPagesToolName,
  title: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Json),
});
export type StarkPublishedPagesTool = typeof StarkPublishedPagesTool.Type;
export const StarkPublishedPagesReadInput = Schema.Struct({
  tool: StarkPublishedPagesToolName,
  arguments: Schema.Record(Schema.String, Schema.Json),
});
export type StarkPublishedPagesReadInput = typeof StarkPublishedPagesReadInput.Type;
export const StarkPublishedPagesReadResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  structuredContent: Schema.optional(Schema.Json),
  isError: Schema.Boolean,
});
export type StarkPublishedPagesReadResult = typeof StarkPublishedPagesReadResult.Type;
export const StarkPublishedPagesOpenInput = Schema.Struct({
  root: Schema.String,
  path: Schema.String,
  refresh: Schema.optional(Schema.Boolean),
});
export type StarkPublishedPagesOpenInput = typeof StarkPublishedPagesOpenInput.Type;
export const StarkPublishedPagesAsset = Schema.Struct({
  path: Schema.String,
  mimeType: Schema.String,
  content: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
});
export type StarkPublishedPagesAsset = typeof StarkPublishedPagesAsset.Type;
/** Self-contained, bounded source bundle. Authentication and download links stay in the main process. */
export const StarkPublishedPageDocument = Schema.Struct({
  root: Schema.String,
  path: Schema.String,
  source: Schema.String,
  mimeType: Schema.String,
  assets: Schema.Array(StarkPublishedPagesAsset),
  warnings: Schema.Array(Schema.String),
  publicUrl: Schema.NullOr(Schema.String),
});
export type StarkPublishedPageDocument = typeof StarkPublishedPageDocument.Type;
export interface StarkPublishedPagesBridge {
  status(): Promise<StarkPublishedPagesStatus>;
  connect(): Promise<StarkPublishedPagesStatus>;
  disconnect(): Promise<StarkPublishedPagesStatus>;
  listTools(): Promise<readonly StarkPublishedPagesTool[]>;
  read(input: StarkPublishedPagesReadInput): Promise<StarkPublishedPagesReadResult>;
  openPage(input: StarkPublishedPagesOpenInput): Promise<StarkPublishedPageDocument>;
}
