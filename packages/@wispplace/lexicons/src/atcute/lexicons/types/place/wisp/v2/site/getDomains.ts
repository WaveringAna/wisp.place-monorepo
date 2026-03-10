import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.query("place.wisp.v2.site.getDomains", {
  params: /*#__PURE__*/ v.object({
    did: /*#__PURE__*/ v.didString(),
    rkey: /*#__PURE__*/ v.recordKeyString(),
  }),
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      get domains() {
        return /*#__PURE__*/ v.array(siteDomainSchema);
      },
    }),
  },
});
const _siteDomainSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.site.getDomains#siteDomain"),
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

type main$schematype = typeof _mainSchema;
type siteDomain$schematype = typeof _siteDomainSchema;

export interface mainSchema extends main$schematype {}
export interface siteDomainSchema extends siteDomain$schematype {}

export const mainSchema = _mainSchema as mainSchema;
export const siteDomainSchema = _siteDomainSchema as siteDomainSchema;

export interface SiteDomain extends v.InferInput<typeof siteDomainSchema> {}

export interface $params extends v.InferInput<mainSchema["params"]> {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCQueries {
    "place.wisp.v2.site.getDomains": mainSchema;
  }
}
