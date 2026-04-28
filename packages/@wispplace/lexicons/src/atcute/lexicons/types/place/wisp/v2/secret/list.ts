import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.query("place.wisp.v2.secret.list", {
  params: null,
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      get secrets() {
        return /*#__PURE__*/ v.array(secretMetaSchema);
      },
    }),
  },
});
const _secretMetaSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.secret.list#secretMeta"),
  ),
  createdAt: /*#__PURE__*/ v.datetimeString(),
  lastRotatedAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
  name: /*#__PURE__*/ v.string(),
});

type main$schematype = typeof _mainSchema;
type secretMeta$schematype = typeof _secretMetaSchema;

export interface mainSchema extends main$schematype {}
export interface secretMetaSchema extends secretMeta$schematype {}

export const mainSchema = _mainSchema as mainSchema;
export const secretMetaSchema = _secretMetaSchema as secretMetaSchema;

export interface SecretMeta extends v.InferInput<typeof secretMetaSchema> {}

export interface $params {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCQueries {
    "place.wisp.v2.secret.list": mainSchema;
  }
}
