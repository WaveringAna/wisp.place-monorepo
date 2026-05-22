import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.procedure("place.wisp.v2.domain.verify", {
  params: null,
  input: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      /**
       * Custom domain FQDN to verify (for example, example.com).
       * @minLength 3
       * @maxLength 253
       */
      domain: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
        /*#__PURE__*/ v.stringLength(3, 253),
      ]),
    }),
  },
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      /**
       * The CNAME target observed during verification, if any.
       */
      cnameFound: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
      domain: /*#__PURE__*/ v.string(),
      /**
       * Human-readable reason verification did not pass (when not verified).
       */
      error: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
      kind: /*#__PURE__*/ v.literalEnum(["custom"]),
      status: /*#__PURE__*/ v.literalEnum(["pendingVerification", "verified"]),
      /**
       * The TXT value observed during verification, if any.
       */
      txtFound: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
      verified: /*#__PURE__*/ v.boolean(),
      /**
       * Non-fatal advisory (for example, CNAME could not be confirmed due to flattening).
       */
      warning: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
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
    "place.wisp.v2.domain.verify": mainSchema;
  }
}
