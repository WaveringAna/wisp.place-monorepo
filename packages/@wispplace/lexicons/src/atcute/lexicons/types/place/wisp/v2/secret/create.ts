import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.procedure("place.wisp.v2.secret.create", {
  params: null,
  input: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      /**
       * Unique 1–64 character secret ID scoped to the caller DID. Use ASCII letters, digits, dots, underscores, and hyphens only.
       * @maxLength 64
       */
      name: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.recordKeyString(), [
        /*#__PURE__*/ v.stringLength(0, 64),
      ]),
      /**
       * Optional caller-supplied signing token: 32–256 printable ASCII characters, no whitespace. Omit it to have the server generate one. Use this to register a secret the receiving system already generated.
       * @minLength 32
       * @maxLength 256
       */
      token: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
          /*#__PURE__*/ v.stringLength(32, 256),
        ]),
      ),
    }),
  },
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      createdAt: /*#__PURE__*/ v.datetimeString(),
      name: /*#__PURE__*/ v.string(),
      /**
       * The signing token. Only returned at creation time — store it now.
       */
      token: /*#__PURE__*/ v.string(),
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
    "place.wisp.v2.secret.create": mainSchema;
  }
}
