import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.procedure("place.wisp.v2.site.delete", {
  params: null,
  input: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      /**
       * Owned place.wisp.fs record key to delete from wisp metadata.
       */
      siteRkey: /*#__PURE__*/ v.recordKeyString(),
    }),
  },
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      deleted: /*#__PURE__*/ v.literal(true),
      siteRkey: /*#__PURE__*/ v.recordKeyString(),
      /**
       * Domains that were detached from this site before deletion.
       */
      get unmappedDomains() {
        return /*#__PURE__*/ v.array(unmappedDomainSchema);
      },
    }),
  },
});
const _unmappedDomainSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.site.delete#unmappedDomain"),
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
});

type main$schematype = typeof _mainSchema;
type unmappedDomain$schematype = typeof _unmappedDomainSchema;

export interface mainSchema extends main$schematype {}
export interface unmappedDomainSchema extends unmappedDomain$schematype {}

export const mainSchema = _mainSchema as mainSchema;
export const unmappedDomainSchema =
  _unmappedDomainSchema as unmappedDomainSchema;

export interface UnmappedDomain extends v.InferInput<
  typeof unmappedDomainSchema
> {}

export interface $params {}
export interface $input extends v.InferXRPCBodyInput<mainSchema["input"]> {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCProcedures {
    "place.wisp.v2.site.delete": mainSchema;
  }
}
