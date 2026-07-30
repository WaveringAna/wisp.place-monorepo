import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.query("place.wisp.v2.privateSite.list", {
  params: null,
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      get sites() {
        return /*#__PURE__*/ v.array(privateSiteSummarySchema);
      },
    }),
  },
});
const _privateSiteSummarySchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal(
      "place.wisp.v2.privateSite.list#privateSiteSummary",
    ),
  ),
  createdAt: /*#__PURE__*/ v.datetimeString(),
  expired: /*#__PURE__*/ v.boolean(),
  expiresAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
  fileCount: /*#__PURE__*/ v.integer(),
  name: /*#__PURE__*/ v.string(),
  /**
   * Number of share links that currently grant access.
   */
  shareCount: /*#__PURE__*/ v.integer(),
  siteId: /*#__PURE__*/ v.recordKeyString(),
  totalBytes: /*#__PURE__*/ v.integer(),
});

type main$schematype = typeof _mainSchema;
type privateSiteSummary$schematype = typeof _privateSiteSummarySchema;

export interface mainSchema extends main$schematype {}
export interface privateSiteSummarySchema extends privateSiteSummary$schematype {}

export const mainSchema = _mainSchema as mainSchema;
export const privateSiteSummarySchema =
  _privateSiteSummarySchema as privateSiteSummarySchema;

export interface PrivateSiteSummary extends v.InferInput<
  typeof privateSiteSummarySchema
> {}

export interface $params {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCQueries {
    "place.wisp.v2.privateSite.list": mainSchema;
  }
}
