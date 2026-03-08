import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _atUriSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.wh#atUri"),
  ),
  aturi: /*#__PURE__*/ v.resourceUriString(),
});
const _mainSchema = /*#__PURE__*/ v.record(
  /*#__PURE__*/ v.string(),
  /*#__PURE__*/ v.object({
    $type: /*#__PURE__*/ v.literal("place.wisp.v2.wh"),
    /**
     * Timestamp of when the webhook was created.
     */
    createdAt: /*#__PURE__*/ v.datetimeString(),
    /**
     * Whether the webhook is active. Default to true if omitted.
     */
    enabled: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
    /**
     * Which record events to trigger on. 'create' fires when a new record is created. 'update' fires when an existing record is updated. 'delete' fires when a record is deleted.
     * @maxLength 3
     */
    events: /*#__PURE__*/ v.constrain(
      /*#__PURE__*/ v.array(
        /*#__PURE__*/ v.literalEnum(["create", "delete", "update"]),
      ),
      [/*#__PURE__*/ v.arrayLength(0, 3)],
    ),
    /**
     * Whether the webhook should fire before ('pre') or after ('post') the record event is processed.
     */
    phase: /*#__PURE__*/ v.literalEnum(["post", "pre"]),
    /**
     * What to watch. An AT-URI scopes to a specific DID, collection, or record. An NSID watches that collection globally across all DIDs.
     */
    get scope() {
      return /*#__PURE__*/ v.variant([atUriSchema, nsidSchema]);
    },
    /**
     * Optional secret used to sign the webhook payload with HMAC-SHA256. The signature is included in the 'X-Webhook-Signature' header of the webhook request.
     */
    secret: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
    /**
     * HTTPS endpoint to POST the webhook payload to.
     * @maxLength 2048
     */
    url: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
      /*#__PURE__*/ v.stringLength(0, 2048),
    ]),
  }),
);
const _nsidSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.wh#nsid"),
  ),
  nsid: /*#__PURE__*/ v.nsidString(),
});

type atUri$schematype = typeof _atUriSchema;
type main$schematype = typeof _mainSchema;
type nsid$schematype = typeof _nsidSchema;

export interface atUriSchema extends atUri$schematype {}
export interface mainSchema extends main$schematype {}
export interface nsidSchema extends nsid$schematype {}

export const atUriSchema = _atUriSchema as atUriSchema;
export const mainSchema = _mainSchema as mainSchema;
export const nsidSchema = _nsidSchema as nsidSchema;

export interface AtUri extends v.InferInput<typeof atUriSchema> {}
export interface Main extends v.InferInput<typeof mainSchema> {}
export interface Nsid extends v.InferInput<typeof nsidSchema> {}

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "place.wisp.v2.wh": mainSchema;
  }
}
