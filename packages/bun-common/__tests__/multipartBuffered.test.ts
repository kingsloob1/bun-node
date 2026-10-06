/**
 * The buffered multipart parse (`lib/multipart/buffered.ts`) must answer
 * exactly what busboy answers, or hand the body to busboy. Checked here by
 * a seeded differential fuzz against busboy itself (with a negative
 * control), by bodies as clients send them (which must never be handed
 * off), and by `getMultiParts` answering the same through either parser.
 */
import type { BufferedMultipartConfig } from "../lib/multipart/buffered";
import { Buffer } from "node:buffer";
import { describe, expect, it, spyOn } from "bun:test";
import busboy from "busboy";
import { UploadError } from "../lib";
import * as buffered from "../lib/multipart/buffered";
import { makeRequest } from "./helpers";

const { parseBufferedMultipart } = buffered;

/** A seeded PRNG (mulberry32), so every run sees the same cases. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What busboy reports for a body: its parts in order, error and limit events. */
function viaBusboy(
  body: Buffer,
  contentType: string,
  config: BufferedMultipartConfig,
) {
  return new Promise<{ parts: unknown[]; error?: string; limits: string[] }>(
    (resolve) => {
      const parts: unknown[] = [];
      const limits: string[] = [];
      let bb: busboy.Busboy;
      try {
        bb = busboy({ headers: { "content-type": contentType }, ...config });
      } catch (error) {
        resolve({ parts, error: (error as Error).message, limits });
        return;
      }
      const pending: Promise<void>[] = [];
      let done = false;
      const finish = (error?: string) => {
        if (!done) {
          done = true;
          void Promise.all(pending).then(() =>
            resolve({ parts, error, limits }),
          );
        }
      };
      bb.on("field", (name, value, info) => {
        if (info.valueTruncated || info.nameTruncated) {
          limits.push("fieldTruncated");
        }
        parts.push({ kind: "field", name, value, info });
      });
      bb.on("file", (name, stream, info) => {
        const part: Record<string, unknown> = { kind: "file", name, info };
        parts.push(part);
        pending.push(
          new Promise((settle) => {
            const chunks: Buffer[] = [];
            stream.on("limit", () => limits.push("fileSize"));
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => {
              part.data = Buffer.concat(chunks).toString("hex");
              settle();
            });
            stream.on("error", () => settle());
          }),
        );
      });
      for (const event of ["partsLimit", "filesLimit", "fieldsLimit"]) {
        bb.on(event, () => limits.push(event));
      }
      bb.on("close", () => finish());
      bb.on("error", (error: Error) => finish(error.message));
      bb.end(body);
    },
  );
}

/** The buffered parse in busboy's shape, file bytes as hex. */
function viaBuffered(
  body: Buffer,
  contentType: string,
  config: BufferedMultipartConfig,
) {
  return parseBufferedMultipart(body, contentType, config)?.map((part) =>
    part.kind === "file"
      ? {
          kind: part.kind,
          name: part.name,
          info: part.info,
          data: part.data.toString("hex"),
        }
      : part,
  );
}

const BOUNDARIES = [
  "B",
  "----WebKitFormBoundaryABC123",
  "x-y_z",
  "ab'c",
  "é",
  "a b",
];
const NAMES = ["a", "field", "a[b]", "café", "", 'q\\"uote', "x y", "日本"];
const FILENAMES = [
  undefined,
  "x.txt",
  "",
  "C:\\dir\\x.txt",
  "../../etc/passwd",
  "naïve.txt",
  "..",
  "a/b/",
];
const TYPES = [
  undefined,
  "text/plain",
  "application/octet-stream",
  "image/png",
  "Text/Plain",
  "APPLICATION/OCTET-STREAM",
  "image/PNG",
  "a/b+c",
  "x/",
  "/y",
  "text/plain ",
  "text/plain;",
  "text/plain; charset=latin1",
  "text/plain; charset=utf-16le",
  "text/plain; charset=base64",
  "text/plain; charset=koi8-r",
  "application/json; charset=UTF-8",
  "bogus",
];
const VALUES = [
  "",
  "1",
  "hello world",
  "x\ny\r\nz",
  "é",
  "\r\n--",
  "\r\n-",
  "--",
  "\r",
  "\u0000\u00FF",
  "日本語",
];

/** One random body, content type and busboy config. */
function makeCase(rnd: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const boundary = pick(BOUNDARIES);
  const chunks: Buffer[] = [];
  if (rnd() < 0.2) {
    chunks.push(Buffer.from(pick(["preamble\r\n", "\r\n", "x"])));
  }
  const count = Math.floor(rnd() * 5);
  for (let i = 0; i < count; i++) {
    const headers: string[] = [];
    const filename = pick(FILENAMES);
    let disposition = pick([
      "form-data",
      "form-data",
      "form-data",
      "attachment",
      "FORM-DATA",
      "Form-Data",
    ]);
    if (rnd() < 0.95) {
      disposition += `; name="${pick(NAMES)}"`;
    }
    if (filename !== undefined) {
      disposition +=
        rnd() < 0.2
          ? `; filename*=UTF-8''${encodeURIComponent(filename)}`
          : `; filename="${filename}"`;
    }
    if (rnd() < 0.95) {
      headers.push(
        `${pick(["Content-Disposition", "content-disposition", "CONTENT-DISPOSITION"])}:${pick([" ", "", "\t"])}${disposition}`,
      );
    }
    const type = pick(TYPES);
    if (type) {
      headers.push(
        `${pick(["Content-Type", "content-type", "CONTENT-TYPE"])}:${pick([" ", "", "\t", "  "])}${type}`,
      );
    }
    if (rnd() < 0.1) {
      headers.reverse();
    }
    if (rnd() < 0.1) {
      headers.push(
        `Content-Transfer-Encoding: ${pick(["binary", "BASE64", "8bit"])}`,
      );
    }
    if (rnd() < 0.05) {
      headers.push("X-Folded: a\r\n b");
    }
    if (rnd() < 0.03) {
      headers.push("Bad Header: x");
    }
    if (rnd() < 0.03) {
      headers.push("NoColon");
    }
    let value: Buffer;
    if (rnd() < 0.2) {
      value = Buffer.alloc(Math.floor(rnd() * 3000));
      for (let k = 0; k < value.length; k++) {
        value[k] = Math.floor(rnd() * 256);
      }
    } else {
      value = Buffer.from(
        pick(VALUES) + (rnd() < 0.1 ? `\r\n--${boundary}x` : ""),
        pick(["utf8", "latin1"] as const),
      );
    }
    const junk = rnd() < 0.03 ? pick(["  ", "\n", "x"]) : "";
    chunks.push(
      Buffer.from(`--${boundary}${junk}\r\n${headers.join("\r\n")}\r\n\r\n`),
    );
    chunks.push(value);
    chunks.push(Buffer.from("\r\n"));
  }
  if (rnd() < 0.95) {
    chunks.push(
      Buffer.from(
        `--${boundary}${pick(["--", "--", "--\r\n", "--epilogue", "-", ""])}`,
      ),
    );
  }
  let body = Buffer.concat(chunks);
  if (rnd() < 0.05) {
    body = body.subarray(0, Math.floor(rnd() * body.length));
  }
  const quoted = /[ '"]/.test(boundary) || /[^\x21-\x7E]/.test(boundary);
  const contentType =
    rnd() < 0.15
      ? pick([
          "multipart/form-data",
          "text/plain",
          `multipart/form-data; boundary="${boundary}"`,
          `Multipart/Form-Data; Boundary=${boundary}`,
          `multipart/form-data ;boundary=${boundary}`,
          `multipart/form-data;\tboundary=${boundary}  `,
          `multipart/form-data; boundary=${boundary}; charset=utf-8`,
          `multipart/form-data; boundary=${boundary} x`,
        ])
      : `multipart/form-data; boundary=${quoted ? `"${boundary}"` : boundary}`;
  const config: BufferedMultipartConfig = {};
  if (rnd() < 0.3) {
    const limits: NonNullable<BufferedMultipartConfig["limits"]> = {};
    if (rnd() < 0.5) {
      limits.fileSize = Math.floor(rnd() * 3000);
    }
    if (rnd() < 0.3) {
      limits.fieldSize = Math.floor(rnd() * 12);
    }
    if (rnd() < 0.3) {
      limits.files = Math.floor(rnd() * 3);
    }
    if (rnd() < 0.3) {
      limits.fields = Math.floor(rnd() * 3);
    }
    if (rnd() < 0.3) {
      limits.parts = Math.floor(rnd() * 4);
    }
    config.limits = limits;
  }
  if (rnd() < 0.2) {
    config.defParamCharset = pick(["utf8", "latin1"]);
  }
  if (rnd() < 0.1) {
    config.defCharset = pick(["latin1", "utf8"]);
  }
  if (rnd() < 0.1) {
    config.preservePath = true;
  }
  return { body, contentType, config };
}

/**
 * Runs `cases` random bodies through `parse` and busboy: every body `parse`
 * answers must be answered identically by busboy, with no error and no limit.
 */
async function differential(
  seed: number,
  cases: number,
  parse: typeof viaBuffered,
) {
  const rnd = random(seed);
  let answered = 0;
  const mismatches: string[] = [];
  for (let i = 0; i < cases; i++) {
    const { body, contentType, config } = makeCase(rnd);
    const mine = parse(body, contentType, config);
    if (mine === undefined) {
      continue;
    }
    answered++;
    const reference = await viaBusboy(body, contentType, config);
    if (
      reference.error !== undefined ||
      reference.limits.length > 0 ||
      JSON.stringify(mine) !== JSON.stringify(reference.parts)
    ) {
      mismatches.push(
        `case ${i}: ${JSON.stringify(contentType)} ${JSON.stringify(config)}\n  body ${JSON.stringify(body.toString("latin1").slice(0, 300))}\n  busboy ${JSON.stringify(reference).slice(0, 400)}\n  buffered ${JSON.stringify(mine).slice(0, 400)}`,
      );
    }
  }
  return { answered, mismatches };
}

describe("parseBufferedMultipart: exactly busboy, or busboy's to answer", () => {
  for (const seed of [1, 2, 3]) {
    it(`agrees with busboy on every body it answers (seed ${seed})`, async () => {
      const { answered, mismatches } = await differential(
        seed,
        4000,
        viaBuffered,
      );
      expect(mismatches.slice(0, 3)).toEqual([]);
      // It must actually answer a good share, or the check proves nothing.
      expect(answered).toBeGreaterThan(1000);
    });
  }

  it("negative control: a parse that keeps file paths is caught", async () => {
    // busboy strips a file name to its last segment; one that does not
    // must be told apart by the same check.
    const keepsPaths: typeof viaBuffered = (body, contentType, config) =>
      viaBuffered(body, contentType, { ...config, preservePath: true });
    const { mismatches } = await differential(1, 4000, keepsPaths);
    expect(mismatches.length).toBeGreaterThan(0);
  });

  it("answers every body as clients encode it, never handing one to busboy", async () => {
    const shapes: ((fd: FormData) => void)[] = [
      (fd) => fd.append("a", "1"),
      (fd) => {
        fd.append("field", "value");
        fd.append(
          "file",
          new File(["x".repeat(1024)], "a.bin", {
            type: "application/octet-stream",
          }),
        );
      },
      (fd) => {
        fd.append("café", "naïve ✓");
        fd.append("f", new File(["hi"], "naïve.txt", { type: "text/plain" }));
      },
      (fd) => {
        for (let i = 0; i < 50; i++) {
          fd.append(`k${i}`, `v\r\n${i}`);
        }
      },
      (fd) => {
        for (let i = 0; i < 3; i++) {
          fd.append(
            "f",
            new File(
              [crypto.getRandomValues(new Uint8Array(50000))],
              `f${i}.bin`,
            ),
          );
        }
      },
      (fd) => fd.append("f", new File([], "", { type: "" })),
      (fd) => {
        fd.append("user[name]", "Ada");
        fd.append("user[langs][]", "js");
      },
    ];
    for (const build of shapes) {
      const fd = new FormData();
      build(fd);
      const encoded = new Response(fd);
      const contentType = encoded.headers.get("content-type")!;
      const body = Buffer.from(await encoded.arrayBuffer());
      const mine = viaBuffered(body, contentType, {});
      expect(mine).toBeDefined();
      const reference = (await viaBusboy(body, contentType, {})).parts;
      expect(JSON.stringify(mine)).toBe(JSON.stringify(reference));
    }
  });

  it("a header of blanks cannot stall the parse (no backtracking)", () => {
    // 15,000 blanks then a byte busboy refuses: an earlier header regex
    // backtracked over them quadratically (820 ms for 16 KB, measured).
    const body = Buffer.from(
      `--B\r\nContent-Disposition: form-data; name="a"\r\nX:${" ".repeat(15000)}\u0001\r\n\r\nv\r\n--B--`,
      "latin1",
    );
    const started = performance.now();
    expect(
      parseBufferedMultipart(body, "multipart/form-data; boundary=B"),
    ).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("hands busboy what busboy reports: a truncated body, a limit, junk", () => {
    const type = "multipart/form-data; boundary=B";
    const part =
      '--B\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue\r\n';
    const whole = Buffer.from(`${part}--B--`);
    expect(parseBufferedMultipart(whole, type)).toHaveLength(1);
    // No closing boundary: busboy's "Unexpected end of form".
    expect(parseBufferedMultipart(Buffer.from(part), type)).toBeUndefined();
    // A value reaching fieldSize: busboy truncates it.
    expect(
      parseBufferedMultipart(whole, type, { limits: { fieldSize: 5 } }),
    ).toBeUndefined();
    expect(
      parseBufferedMultipart(whole, type, { limits: { fieldSize: 6 } }),
    ).toHaveLength(1);
    // A part over the parts limit.
    expect(
      parseBufferedMultipart(whole, type, { limits: { parts: 1 } }),
    ).toBeUndefined();
    // A part with no headers: busboy's "Malformed part header".
    expect(
      parseBufferedMultipart(Buffer.from("--B\r\n\r\nvalue\r\n--B--"), type),
    ).toBeUndefined();
    // No boundary parameter.
    expect(
      parseBufferedMultipart(whole, "multipart/form-data"),
    ).toBeUndefined();
  });
});

/** The leading bytes of a JPEG (JFIF), enough for `file-type`. */
const JPEG_HEAD = [255, 216, 255, 224, 0, 16, 74, 70, 73, 70];

describe("getMultiParts: the same answer through either parser", () => {
  /** Each body, parsed by a request with the buffered parse on and off. */
  async function both(build: (fd: FormData) => void, options = {}) {
    const parse = async () => {
      const fd = new FormData();
      build(fd);
      const req = await makeRequest({ method: "POST", body: fd });
      const result = await req.getMultiParts(options);
      return {
        fields: result.fields,
        files: [...result.files].map(([record, paths]) => ({
          ...record,
          file: record.file.toString("hex"),
          paths: [...paths],
        })),
      };
    };
    const fast = await parse();
    const spy = spyOn(buffered, "parseBufferedMultipart").mockReturnValue(
      undefined,
    );
    try {
      const slow = await parse();
      expect(spy).toHaveBeenCalled();
      return { fast, slow };
    } finally {
      spy.mockRestore();
    }
  }

  /** A form exercising every inflation path: plain, nested, repeated, JSON, files. */
  const richForm = (fd: FormData) => {
    fd.append("name", "Ada");
    fd.append("count", "7");
    fd.append("meta", '{"a":[1,2]}');
    fd.append("tag", "x");
    fd.append("tag", "x");
    fd.append("user[langs][]", "js");
    fd.append("user[langs][]", "ts");
    fd.append("address.city", "London");
    fd.append(
      "photo",
      new File([new Uint8Array(JPEG_HEAD)], "C:\\pics\\me.jpg", {
        type: "application/octet-stream",
      }),
    );
    fd.append("docs[]", new File(["one"], "a.txt", { type: "text/plain" }));
    fd.append("docs[passport]", new File(["two"], "b.txt"));
  };

  it("without sniffing (the synchronous parse): every inflation path", async () => {
    const { fast, slow } = await both(richForm, { detectFileType: false });
    expect(fast).toEqual(slow);
    expect(fast.files.map((file) => file.paths)).toEqual([
      ["[photo]"],
      ["[docs]"],
      ["[docs][passport]"],
    ]);
    expect(fast.fields).toMatchObject({ count: 7, tag: ["x", "x"] });
  });

  it("without sniffing or inflation (the synchronous parse)", async () => {
    const { fast, slow } = await both(richForm, {
      detectFileType: false,
      inflate: false,
    });
    expect(fast).toEqual(slow);
    expect(fast.fields).toMatchObject({
      count: "7",
      "user[langs][]": ["js", "ts"],
    });
  });

  it("refuses a name over fieldNameSize the same way through either parser", async () => {
    const refusal = async () => {
      const fd = new FormData();
      fd.append("short", "1");
      fd.append("a-much-longer-name", "2");
      const req = await makeRequest({ method: "POST", body: fd });
      const options = {
        detectFileType: false,
        limits: { fieldNameSize: 5 },
      };
      const first = await req.getMultiParts(options).catch((e: unknown) => e);
      // Remembered: asking again with the same options refuses again.
      const again = await req.getMultiParts(options).catch((e: unknown) => e);
      return [first, again].map((error) =>
        error instanceof UploadError ? [error.code, error.field] : error,
      );
    };
    const fast = await refusal();
    const spy = spyOn(buffered, "parseBufferedMultipart").mockReturnValue(
      undefined,
    );
    try {
      expect(fast).toEqual(await refusal());
    } finally {
      spy.mockRestore();
    }
    expect(fast).toEqual([
      ["LIMIT_FIELD_KEY", undefined],
      ["LIMIT_FIELD_KEY", undefined],
    ]);
  });

  it("parses while the request is built, with nothing left to await", async () => {
    const fd = new FormData();
    fd.append("field", "v");
    fd.append("file", new File(["x".repeat(64)], "a.bin"));
    const req = await makeRequest({
      method: "POST",
      body: fd,
      options: {
        parseBody: {
          contentTypes: { multipart: { opts: { detectFileType: false } } },
        },
      },
    });
    const first = await req.getMultiParts({});
    expect(first.fields).toEqual({ field: "v" });
    expect([...first.files.keys()][0].file.length).toBe(64);
    // The cached result, the very same object.
    expect(await req.getMultiParts({})).toBe(first);
  });

  it("fields, nested names, several files and sniffed types", async () => {
    const { fast, slow } = await both((fd) => {
      fd.append("name", "Ada");
      fd.append("count", "7");
      fd.append("meta", '{"a":[1,2]}');
      fd.append("user[langs][]", "js");
      fd.append("user[langs][]", "ts");
      fd.append(
        "photo",
        new File([new Uint8Array(JPEG_HEAD)], "C:\\pics\\me.jpg", {
          type: "application/octet-stream",
        }),
      );
      fd.append("docs[]", new File(["one"], "a.txt", { type: "text/plain" }));
      fd.append("docs[]", new File(["two"], "b.txt", { type: "text/plain" }));
    });
    expect(fast).toEqual(slow);
    expect(fast.files.map((file) => file.originalFilename)).toEqual([
      "me.jpg",
      "a.txt",
      "b.txt",
    ]);
    expect(fast.files[0].validatedMimeType?.mime).toBe("image/jpeg");
  });

  it("raw values with inflate off, and UTF-8 names", async () => {
    const { fast, slow } = await both(
      (fd) => {
        fd.append("café", "naïve");
        fd.append("a[b]", "1");
        fd.append("a[b]", "1");
      },
      { inflate: false, defParamCharset: "utf8" },
    );
    expect(fast).toEqual(slow);
    expect(fast.fields).toEqual({ café: "naïve", "a[b]": ["1", "1"] });
  });
});
