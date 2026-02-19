import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.query("place.wisp.v2.domain.getStatus", {
  params: /*#__PURE__*/ v.object({
    /**
     * Domain to inspect (FQDN, lowercase preferred).
     * @minLength 3
     * @maxLength 253
     */
    domain: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
      /*#__PURE__*/ v.stringLength(3, 253),
    ]),
  }),
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      domain: /*#__PURE__*/ v.string(),
      kind: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.literalEnum(["custom", "wisp"]),
      ),
      lastCheckedAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
      /**
       * @maxLength 1000
       */
      lastError: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
          /*#__PURE__*/ v.stringLength(0, 1000),
        ]),
      ),
      siteRkey: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.recordKeyString()),
      status: /*#__PURE__*/ v.literalEnum([
        "alreadyClaimed",
        "pendingVerification",
        "unclaimed",
        "verified",
      ]),
      verified: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
    }),
  },
});

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface $params extends v.InferInput<mainSchema["params"]> {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCQueries {
    "place.wisp.v2.domain.getStatus": mainSchema;
  }
}
