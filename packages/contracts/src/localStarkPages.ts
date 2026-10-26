import * as Schema from "effect/Schema";

export const LocalStarkPage = Schema.Struct({
  slug: Schema.String.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z0-9-]{3,64}$/),
  ),
  title: Schema.String.check(Schema.isMaxLength(200)),
  type: Schema.String.check(Schema.isMaxLength(40)),
  status: Schema.String.check(Schema.isMaxLength(40)),
  mtime: Schema.String.check(Schema.isMaxLength(64)),
});

export type LocalStarkPage = typeof LocalStarkPage.Type;
