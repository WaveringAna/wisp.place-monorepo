import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.procedure(
  "place.wisp.v2.privateSite.create",
  {
    params: null,
    input: {
      type: "blob",
      encoding: ["multipart/form-data"],
    },
    output: {
      type: "lex",
      schema: /*#__PURE__*/ v.object({
        createdAt: /*#__PURE__*/ v.datetimeString(),
        /**
         * Absent when the site never expires.
         */
        expiresAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
        fileCount: /*#__PURE__*/ v.integer(),
        /**
         * Display name. Not an identifier.
         */
        name: /*#__PURE__*/ v.string(),
        /**
         * Stable identifier for this private site. Record-key syntax so it can become a permissioned-space key in v2.
         */
        siteId: /*#__PURE__*/ v.recordKeyString(),
        totalBytes: /*#__PURE__*/ v.integer(),
        /**
         * Owner-facing URL. Requires an authenticated session.
         */
        url: /*#__PURE__*/ v.string(),
      }),
    },
  },
);

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface $params {}
export type $input = v.InferXRPCBodyInput<mainSchema["input"]>;
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCProcedures {
    "place.wisp.v2.privateSite.create": mainSchema;
  }
}
