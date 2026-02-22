import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _domainSummarySchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.domain.getList#domainSummary"),
  ),
  /**
   * @minLength 3
   * @maxLength 253
   */
  domain: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
    /*#__PURE__*/ v.stringLength(3, 253),
  ]),
  kind: /*#__PURE__*/ v.literalEnum(["custom", "wisp"]),
  lastCheckedAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
  siteRkey: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.recordKeyString()),
  status: /*#__PURE__*/ v.literalEnum(["pendingVerification", "verified"]),
  verified: /*#__PURE__*/ v.boolean(),
});
const _mainSchema = /*#__PURE__*/ v.query("place.wisp.v2.domain.getList", {
  params: null,
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      /**
       * Domains owned by the caller DID.
       */
      get domains() {
        return /*#__PURE__*/ v.array(domainSummarySchema);
      },
    }),
  },
});

type domainSummary$schematype = typeof _domainSummarySchema;
type main$schematype = typeof _mainSchema;

export interface domainSummarySchema extends domainSummary$schematype {}
export interface mainSchema extends main$schematype {}

export const domainSummarySchema = _domainSummarySchema as domainSummarySchema;
export const mainSchema = _mainSchema as mainSchema;

export interface DomainSummary extends v.InferInput<
  typeof domainSummarySchema
> {}

export interface $params {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCQueries {
    "place.wisp.v2.domain.getList": mainSchema;
  }
}
