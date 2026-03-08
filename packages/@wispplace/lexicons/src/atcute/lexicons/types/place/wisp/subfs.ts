import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _directorySchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.subfs#directory"),
  ),
  /**
   * @maxLength 500
   */
  get entries() {
    return /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.array(entrySchema), [
      /*#__PURE__*/ v.arrayLength(0, 500),
    ]);
  },
  type: /*#__PURE__*/ v.literal("directory"),
});
const _entrySchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.subfs#entry"),
  ),
  /**
   * @maxLength 255
   */
  name: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
    /*#__PURE__*/ v.stringLength(0, 255),
  ]),
  get node() {
    return /*#__PURE__*/ v.variant([directorySchema, fileSchema, subfsSchema]);
  },
});
const _fileSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.subfs#file"),
  ),
  /**
   * True if blob content is base64-encoded (used to bypass PDS content sniffing)
   */
  base64: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
  /**
   * Content blob ref
   * @accept *\/*
   * @maxSize 1000000000
   */
  blob: /*#__PURE__*/ v.blob(),
  /**
   * Content encoding (e.g., gzip for compressed files)
   */
  encoding: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.literalEnum(["gzip"])),
  /**
   * Original MIME type before compression
   */
  mimeType: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
  type: /*#__PURE__*/ v.literal("file"),
});
const _mainSchema = /*#__PURE__*/ v.record(
  /*#__PURE__*/ v.string(),
  /*#__PURE__*/ v.object({
    $type: /*#__PURE__*/ v.literal("place.wisp.subfs"),
    createdAt: /*#__PURE__*/ v.datetimeString(),
    /**
     * @minimum 0
     * @maximum 1000
     */
    fileCount: /*#__PURE__*/ v.optional(
      /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [
        /*#__PURE__*/ v.integerRange(0, 1000),
      ]),
    ),
    get root() {
      return directorySchema;
    },
  }),
);
const _subfsSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.subfs#subfs"),
  ),
  /**
   * AT-URI pointing to another place.wisp.subfs record for nested subtrees. When expanded, the referenced record's root entries are merged (flattened) into the parent directory, allowing recursive splitting of large directory structures.
   */
  subject: /*#__PURE__*/ v.resourceUriString(),
  type: /*#__PURE__*/ v.literal("subfs"),
});

type directory$schematype = typeof _directorySchema;
type entry$schematype = typeof _entrySchema;
type file$schematype = typeof _fileSchema;
type main$schematype = typeof _mainSchema;
type subfs$schematype = typeof _subfsSchema;

export interface directorySchema extends directory$schematype {}
export interface entrySchema extends entry$schematype {}
export interface fileSchema extends file$schematype {}
export interface mainSchema extends main$schematype {}
export interface subfsSchema extends subfs$schematype {}

export const directorySchema = _directorySchema as directorySchema;
export const entrySchema = _entrySchema as entrySchema;
export const fileSchema = _fileSchema as fileSchema;
export const mainSchema = _mainSchema as mainSchema;
export const subfsSchema = _subfsSchema as subfsSchema;

export interface Directory extends v.InferInput<typeof directorySchema> {}
export interface Entry extends v.InferInput<typeof entrySchema> {}
export interface File extends v.InferInput<typeof fileSchema> {}
export interface Main extends v.InferInput<typeof mainSchema> {}
export interface Subfs extends v.InferInput<typeof subfsSchema> {}

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "place.wisp.subfs": mainSchema;
  }
}
