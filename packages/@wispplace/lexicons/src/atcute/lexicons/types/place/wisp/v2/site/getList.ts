import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.query("place.wisp.v2.site.getList", {
  params: null,
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      get sites() {
        return /*#__PURE__*/ v.array(siteSummarySchema);
      },
    }),
  },
});
const _siteDomainSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.site.getList#siteDomain"),
  ),
  /**
   * @minLength 3
   * @maxLength 253
   */
  domain: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
    /*#__PURE__*/ v.stringLength(3, 253),
  ]),
  kind: /*#__PURE__*/ v.literalEnum(["custom", "wisp"]),
  status: /*#__PURE__*/ v.literalEnum(["pendingVerification", "verified"]),
  verified: /*#__PURE__*/ v.boolean(),
});
const _siteSummarySchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.site.getList#siteSummary"),
  ),
  createdAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
  /**
   * @maxLength 200
   */
  displayName: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
      /*#__PURE__*/ v.stringLength(0, 200),
    ]),
  ),
  get domains() {
    return /*#__PURE__*/ v.array(siteDomainSchema);
  },
  siteRkey: /*#__PURE__*/ v.recordKeyString(),
  updatedAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
});

type main$schematype = typeof _mainSchema;
type siteDomain$schematype = typeof _siteDomainSchema;
type siteSummary$schematype = typeof _siteSummarySchema;

export interface mainSchema extends main$schematype {}
export interface siteDomainSchema extends siteDomain$schematype {}
export interface siteSummarySchema extends siteSummary$schematype {}

export const mainSchema = _mainSchema as mainSchema;
export const siteDomainSchema = _siteDomainSchema as siteDomainSchema;
export const siteSummarySchema = _siteSummarySchema as siteSummarySchema;

export interface SiteDomain extends v.InferInput<typeof siteDomainSchema> {}
export interface SiteSummary extends v.InferInput<typeof siteSummarySchema> {}

export interface $params {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCQueries {
    "place.wisp.v2.site.getList": mainSchema;
  }
}
