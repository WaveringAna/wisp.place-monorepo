import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _customRegistrationSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.domains#customRegistration"),
  ),
  /**
   * Challenge identifier used to derive DNS setup instructions.
   * @minLength 8
   * @maxLength 64
   */
  challengeId: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
    /*#__PURE__*/ v.stringLength(8, 64),
  ]),
  kind: /*#__PURE__*/ v.literal("custom"),
  get verification() {
    return verificationSchema;
  },
});
const _mainSchema = /*#__PURE__*/ v.record(
  /*#__PURE__*/ v.string(),
  /*#__PURE__*/ v.object({
    $type: /*#__PURE__*/ v.literal("place.wisp.v2.domains"),
    createdAt: /*#__PURE__*/ v.datetimeString(),
    /**
     * Lowercase FQDN for this registration (for example, alice.wisp.place or example.com).
     * @minLength 3
     * @maxLength 253
     */
    domain: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
      /*#__PURE__*/ v.stringLength(3, 253),
    ]),
    get registration() {
      return /*#__PURE__*/ v.variant([
        customRegistrationSchema,
        wispRegistrationSchema,
      ]);
    },
    /**
     * Optional place.wisp.fs record key currently mapped to this domain.
     */
    siteRkey: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.recordKeyString()),
    updatedAt: /*#__PURE__*/ v.datetimeString(),
  }),
);
const _verificationSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.domains#verification"),
  ),
  lastCheckedAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
  /**
   * @maxLength 1000
   */
  lastError: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
      /*#__PURE__*/ v.stringLength(0, 1000),
    ]),
  ),
  method: /*#__PURE__*/ v.literalEnum(["txt-did-v1"]),
  status: /*#__PURE__*/ v.literalEnum(["failed", "pending", "verified"]),
  verifiedAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
});
const _wispRegistrationSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.v2.domains#wispRegistration"),
  ),
  /**
   * Subdomain label only (for example, alice).
   * @minLength 3
   * @maxLength 63
   */
  handle: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
    /*#__PURE__*/ v.stringLength(3, 63),
  ]),
  kind: /*#__PURE__*/ v.literal("wisp"),
});

type customRegistration$schematype = typeof _customRegistrationSchema;
type main$schematype = typeof _mainSchema;
type verification$schematype = typeof _verificationSchema;
type wispRegistration$schematype = typeof _wispRegistrationSchema;

export interface customRegistrationSchema extends customRegistration$schematype {}
export interface mainSchema extends main$schematype {}
export interface verificationSchema extends verification$schematype {}
export interface wispRegistrationSchema extends wispRegistration$schematype {}

export const customRegistrationSchema =
  _customRegistrationSchema as customRegistrationSchema;
export const mainSchema = _mainSchema as mainSchema;
export const verificationSchema = _verificationSchema as verificationSchema;
export const wispRegistrationSchema =
  _wispRegistrationSchema as wispRegistrationSchema;

export interface CustomRegistration extends v.InferInput<
  typeof customRegistrationSchema
> {}
export interface Main extends v.InferInput<typeof mainSchema> {}
export interface Verification extends v.InferInput<typeof verificationSchema> {}
export interface WispRegistration extends v.InferInput<
  typeof wispRegistrationSchema
> {}

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "place.wisp.v2.domains": mainSchema;
  }
}
