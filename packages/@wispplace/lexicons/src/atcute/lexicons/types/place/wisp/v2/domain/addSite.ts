import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.procedure("place.wisp.v2.domain.addSite", {
  params: null,
  input: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      /**
       * Fully-qualified domain to map.
       * @minLength 3
       * @maxLength 253
       */
      domain: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
        /*#__PURE__*/ v.stringLength(3, 253),
      ]),
      /**
       * Owned place.wisp.fs record key to map this domain to.
       */
      siteRkey: /*#__PURE__*/ v.recordKeyString(),
    }),
  },
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      domain: /*#__PURE__*/ v.string(),
      kind: /*#__PURE__*/ v.literalEnum(["custom", "wisp"]),
      mapped: /*#__PURE__*/ v.literal(true),
      siteRkey: /*#__PURE__*/ v.recordKeyString(),
      status: /*#__PURE__*/ v.literalEnum(["pendingVerification", "verified"]),
    }),
  },
});

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface $params {}
export interface $input extends v.InferXRPCBodyInput<mainSchema["input"]> {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCProcedures {
    "place.wisp.v2.domain.addSite": mainSchema;
  }
}
