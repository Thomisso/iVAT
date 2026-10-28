/** The local and hosted Storage service's static per-object ceiling. */
export const MAX_SOURCE_FILE_BYTES = 50 * 1024 * 1024;

/** Source File ceiling plus multipart/form-data overhead for Next's request parser. */
export const UPLOAD_BODY_LIMIT = "51mb";
