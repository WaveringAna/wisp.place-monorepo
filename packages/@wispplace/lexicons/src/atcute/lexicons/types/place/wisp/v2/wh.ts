import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _atUriSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.wh#atUri"),
  ),
  aturi: /*#__PURE__*/ v.string(),
  /**
   * If true, also watch for records in any repo that reference this DID and collection.
   */
  backlinks: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
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
     * Whether the webhook is active. Defaults to true if omitted.
     */
    enabled: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
    /**
     * Which record events to trigger on. Defaults to all events if omitted.
     * @maxLength 3
     */
    events: /*#__PURE__*/ v.optional(
      /*#__PURE__*/ v.constrain(
        /*#__PURE__*/ v.array(
          /*#__PURE__*/ v.literalEnum(["create", "delete", "update"]),
        ),
        [/*#__PURE__*/ v.arrayLength(0, 3)],
      ),
    ),
    /**
     * What to watch. An AT-URI scopes to a specific DID, collection, or record.
     */
    get scope() {
      return atUriSchema;
    },
    /**
     * Optional raw secret used to sign the webhook payload with HMAC-SHA256. Prefer secretId to avoid embedding plaintext values in PDS records.
     * @maxLength 256
     */
    secret: /*#__PURE__*/ v.optional(
      /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
        /*#__PURE__*/ v.stringLength(0, 256),
      ]),
    ),
    /**
     * Name of a server-managed signing secret created via place.wisp.v2.secret.create. Takes precedence over secret if both are present.
     */
    secretId: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.recordKeyString()),
    /**
     * HTTPS endpoint to POST the webhook payload to.
     * @maxLength 2048
     */
    url: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
      /*#__PURE__*/ v.stringLength(0, 2048),
    ]),
  }),
);

type atUri$schematype = typeof _atUriSchema;
type main$schematype = typeof _mainSchema;

export interface atUriSchema extends atUri$schematype {}
export interface mainSchema extends main$schematype {}

export const atUriSchema = _atUriSchema as atUriSchema;
export const mainSchema = _mainSchema as mainSchema;

export interface AtUri extends v.InferInput<typeof atUriSchema> {}
export interface Main extends v.InferInput<typeof mainSchema> {}

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "place.wisp.v2.wh": mainSchema;
  }
}
