/**
 * bun-common's and bun-nest's body parsing as the benchmark runs it: every
 * kind, with multipart parsed without sniffing each file's type, which no
 * other framework here does.
 */
export const BENCH_PARSE_BODY = {
  contentTypes: {
    json: true,
    urlencoded: true,
    text: true,
    raw: true,
    xml: true,
    multipart: { opts: { detectFileType: false } },
  },
};
