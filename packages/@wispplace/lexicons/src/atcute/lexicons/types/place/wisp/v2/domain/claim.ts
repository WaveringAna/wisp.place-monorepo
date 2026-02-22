import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.procedure("place.wisp.v2.domain.claim", {
  params: null,
  input: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      /**
       * Custom domain FQDN to claim (for example, example.com).
       * @minLength 3
       * @maxLength 253
       */
      domain: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
        /*#__PURE__*/ v.stringLength(3, 253),
      ]),
      /**
       * Optional place.wisp.fs rkey to map immediately after claim.
       */
      siteRkey: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.recordKeyString()),
    }),
  },
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      /**
       * Identifier used to construct DNS challenge targets for custom domains.
       * @minLength 8
       * @maxLength 64
       */
      challengeId: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
          /*#__PURE__*/ v.stringLength(8, 64),
        ]),
      ),
      /**
       * Advisory CNAME target (custom domains).
       * @minLength 3
       * @maxLength 253
       */
      cnameTarget: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
          /*#__PURE__*/ v.stringLength(3, 253),
        ]),
      ),
      domain: /*#__PURE__*/ v.string(),
      kind: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.literalEnum(["custom"])),
      siteRkey: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.recordKeyString()),
      status: /*#__PURE__*/ v.literalEnum([
        "alreadyClaimed",
        "pendingVerification",
        "verified",
      ]),
      /**
       * TXT hostname to set for ownership proof (custom domains).
       * @minLength 3
       * @maxLength 253
       */
      txtName: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
          /*#__PURE__*/ v.stringLength(3, 253),
        ]),
      ),
      /**
       * TXT value to set for ownership proof (custom domains).
       */
      txtValue: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.didString()),
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
    "place.wisp.v2.domain.claim": mainSchema;
  }
}
