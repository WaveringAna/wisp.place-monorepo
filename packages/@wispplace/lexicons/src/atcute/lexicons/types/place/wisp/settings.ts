import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _customHeaderSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.wisp.settings#customHeader"),
  ),
  /**
   * HTTP header name (e.g., 'Cache-Control', 'X-Frame-Options')
   * @maxLength 100
   */
  name: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
    /*#__PURE__*/ v.stringLength(0, 100),
  ]),
  /**
   * Optional glob pattern to apply this header to specific paths (e.g., '*.html', '/assets/*'). If not specified, applies to all paths.
   * @maxLength 500
   */
  path: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
      /*#__PURE__*/ v.stringLength(0, 500),
    ]),
  ),
  /**
   * HTTP header value
   * @maxLength 1000
   */
  value: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
    /*#__PURE__*/ v.stringLength(0, 1000),
  ]),
});
const _mainSchema = /*#__PURE__*/ v.record(
  /*#__PURE__*/ v.string(),
  /*#__PURE__*/ v.object({
    $type: /*#__PURE__*/ v.literal("place.wisp.settings"),
    /**
     * Enable clean URL routing. When enabled, '/about' will attempt to serve '/about.html' or '/about/index.html' automatically.
     * @default false
     */
    cleanUrls: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean(), false),
    /**
     * Custom 404 error page file path. Incompatible with directoryListing and spaMode.
     * @maxLength 500
     */
    custom404: /*#__PURE__*/ v.optional(
      /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
        /*#__PURE__*/ v.stringLength(0, 500),
      ]),
    ),
    /**
     * Enable directory listing mode for paths that resolve to directories without an index file. Incompatible with spaMode.
     * @default false
     */
    directoryListing: /*#__PURE__*/ v.optional(
      /*#__PURE__*/ v.boolean(),
      false,
    ),
    /**
     * Custom HTTP headers to set on responses
     * @maxLength 50
     */
    get headers() {
      return /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.array(customHeaderSchema), [
          /*#__PURE__*/ v.arrayLength(0, 50),
        ]),
      );
    },
    /**
     * Ordered list of files to try when serving a directory. Defaults to ['index.html'] if not specified.
     * @maxLength 10
     */
    indexFiles: /*#__PURE__*/ v.optional(
      /*#__PURE__*/ v.constrain(
        /*#__PURE__*/ v.array(
          /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
            /*#__PURE__*/ v.stringLength(0, 255),
          ]),
        ),
        [/*#__PURE__*/ v.arrayLength(0, 10)],
      ),
    ),
    /**
     * File to serve for all routes (e.g., 'index.html'). When set, enables SPA mode where all non-file requests are routed to this file. Incompatible with directoryListing and custom404.
     * @maxLength 500
     */
    spaMode: /*#__PURE__*/ v.optional(
      /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
        /*#__PURE__*/ v.stringLength(0, 500),
      ]),
    ),
  }),
);

type customHeader$schematype = typeof _customHeaderSchema;
type main$schematype = typeof _mainSchema;

export interface customHeaderSchema extends customHeader$schematype {}
export interface mainSchema extends main$schematype {}

export const customHeaderSchema = _customHeaderSchema as customHeaderSchema;
export const mainSchema = _mainSchema as mainSchema;

export interface CustomHeader extends v.InferInput<typeof customHeaderSchema> {}
export interface Main extends v.InferInput<typeof mainSchema> {}

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "place.wisp.settings": mainSchema;
  }
}
