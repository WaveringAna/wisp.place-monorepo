import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.procedure(
  "place.wisp.v2.privateSite.createShare",
  {
    params: null,
    input: {
      type: "lex",
      schema: /*#__PURE__*/ v.object({
        /**
         * Restrict this link to a single account. The recipient must be signed in as this DID; the link alone grants nothing. Omit for a bearer link that anyone holding the URL can open, including people without an atproto account.
         */
        audienceDid: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.didString()),
        /**
         * Minutes until this link expires. Omit for the configured default; 0 for no expiry of its own.
         * @minimum 0
         */
        expiryMinutes: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.integer()),
        /**
         * Optional human label for this link.
         * @maxLength 128
         */
        label: /*#__PURE__*/ v.optional(
          /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
            /*#__PURE__*/ v.stringLength(0, 128),
          ]),
        ),
        siteId: /*#__PURE__*/ v.recordKeyString(),
      }),
    },
    output: {
      type: "lex",
      schema: /*#__PURE__*/ v.object({
        /**
         * Set when this link is restricted to a single account.
         */
        audienceDid: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.didString()),
        createdAt: /*#__PURE__*/ v.datetimeString(),
        /**
         * The same credential on the site's own origin. Equivalent to `url`; useful when a link should not route through wisp.place.
         */
        directUrl: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.genericUriString()),
        expiresAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
        shareId: /*#__PURE__*/ v.string(),
        siteId: /*#__PURE__*/ v.recordKeyString(),
        /**
         * Short, human-friendly share link (wisp.place/p/<token>). Contains the credential and is returned exactly once.
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
export interface $input extends v.InferXRPCBodyInput<mainSchema["input"]> {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCProcedures {
    "place.wisp.v2.privateSite.createShare": mainSchema;
  }
}
