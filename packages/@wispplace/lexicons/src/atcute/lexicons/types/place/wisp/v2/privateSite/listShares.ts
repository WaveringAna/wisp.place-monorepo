import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.query(
  "place.wisp.v2.privateSite.listShares",
  {
    params: /*#__PURE__*/ v.object({
      siteId: /*#__PURE__*/ v.recordKeyString(),
    }),
    output: {
      type: "lex",
      schema: /*#__PURE__*/ v.object({
        get shares() {
          return /*#__PURE__*/ v.array(shareSchema);
        },
      }),
    },
  },
);
const _shareSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.privateSite.listShares#share"),
  ),
  /**
   * Set when this link is restricted to a single account.
   */
  audienceDid: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.didString()),
  createdAt: /*#__PURE__*/ v.datetimeString(),
  expiresAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
  label: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
  lastUsedAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
  revokedAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
  shareId: /*#__PURE__*/ v.string(),
  status: /*#__PURE__*/ v.literalEnum(["active", "expired", "revoked"]),
  /**
   * Non-secret leading fragment, for identification only.
   */
  tokenPrefix: /*#__PURE__*/ v.string(),
});

type main$schematype = typeof _mainSchema;
type share$schematype = typeof _shareSchema;

export interface mainSchema extends main$schematype {}
export interface shareSchema extends share$schematype {}

export const mainSchema = _mainSchema as mainSchema;
export const shareSchema = _shareSchema as shareSchema;

export interface Share extends v.InferInput<typeof shareSchema> {}

export interface $params extends v.InferInput<mainSchema["params"]> {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCQueries {
    "place.wisp.v2.privateSite.listShares": mainSchema;
  }
}
