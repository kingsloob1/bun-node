import type { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  DiskStorage,
  getBusBoyConfig,
  handleMultipartAnyFiles,
  handleMultipartFileFields,
  handleMultipartMultipleFiles,
  handleMultipartSingleFile,
  handleNoFiles,
  MemoryStorage,
  transformUploadOptions,
  uploadFieldsToMap,
} from "../lib";
import { makeRequest } from "./helpers";

function multipartRequest(build: (fd: FormData) => void) {
  const fd = new FormData();
  build(fd);
  return makeRequest({ method: "POST", body: fd });
}

let tmp = "";
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bun-common-multipart-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("multipart: option transforms", () => {
  it("transformUploadOptions selects a memory storage by default", () => {
    const opts = transformUploadOptions();
    expect(opts.storage).toBeInstanceOf(MemoryStorage);
  });

  it("transformUploadOptions selects disk storage", () => {
    const opts = transformUploadOptions({ storageType: "disk" });
    expect(opts.storage).toBeInstanceOf(DiskStorage);
  });

  it("transformUploadOptions requires a storage for custom type", () => {
    expect(() =>
      transformUploadOptions({ storageType: "custom" } as never),
    ).toThrow();
  });

  it("getBusBoyConfig strips storage-specific keys", () => {
    const config = getBusBoyConfig(
      transformUploadOptions({ storageType: "memory" }),
    );
    expect("storageType" in config).toBe(false);
    expect("storage" in config).toBe(false);
  });

  it("uploadFieldsToMap builds a field/limit map", () => {
    const map = uploadFieldsToMap([
      { name: "avatar" },
      { name: "docs", maxCount: 5 },
    ]);
    expect(map.get("avatar")).toEqual({ maxCount: 1 });
    expect(map.get("docs")).toEqual({ maxCount: 5 });
  });
});

describe("multipart: handleMultipartAnyFiles", () => {
  it("collects files and fields with memory storage", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("photo", new Blob(["image-bytes"]), "photo.txt");
      fd.set("name", "kingsley");
    });

    const { files, body } = await handleMultipartAnyFiles(
      req,
      transformUploadOptions({ storageType: "memory" }),
    );
    expect(files).toHaveLength(1);
    expect(files[0].fieldname).toBe("photo");
    expect(body.name).toBe("kingsley");
  });
});

describe("multipart: handleMultipartSingleFile", () => {
  it("accepts a single file on the named field", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("avatar", new Blob(["a"]), "a.txt");
    });
    const { file } = await handleMultipartSingleFile(
      req,
      "avatar",
      transformUploadOptions({ storageType: "memory" }),
    );
    expect(file?.fieldname).toBe("avatar");
  });

  it("rejects files on a foreign field", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("other", new Blob(["a"]), "a.txt");
    });
    await expect(
      handleMultipartSingleFile(
        req,
        "avatar",
        transformUploadOptions({ storageType: "memory" }),
      ),
    ).rejects.toThrow();
  });
});

describe("multipart: handleMultipartMultipleFiles", () => {
  it("enforces the max-count limit", async () => {
    const req = await multipartRequest((fd) => {
      fd.append("docs", new Blob(["1"]), "1.txt");
      fd.append("docs", new Blob(["2"]), "2.txt");
      fd.append("docs", new Blob(["3"]), "3.txt");
    });
    await expect(
      handleMultipartMultipleFiles(
        req,
        "docs",
        1,
        transformUploadOptions({ storageType: "memory" }),
      ),
    ).rejects.toThrow("max");
  });
});

describe("multipart: handleMultipartFileFields", () => {
  it("groups files by their field name", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("avatar", new Blob(["a"]), "a.txt");
      fd.set("cover", new Blob(["c"]), "c.txt");
    });
    const { files } = await handleMultipartFileFields(
      req,
      uploadFieldsToMap([{ name: "avatar" }, { name: "cover" }]),
      transformUploadOptions({ storageType: "memory" }),
    );
    expect(files.avatar).toHaveLength(1);
    expect(files.cover).toHaveLength(1);
  });
});

describe("multipart: handleNoFiles", () => {
  it("passes when there are no files", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("name", "value");
    });
    const { body } = await handleNoFiles(
      req,
      transformUploadOptions({ storageType: "memory" }),
    );
    expect(body.name).toBe("value");
  });

  it("rejects when files are present", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("file", new Blob(["x"]), "x.txt");
    });
    await expect(
      handleNoFiles(req, transformUploadOptions({ storageType: "memory" })),
    ).rejects.toThrow("not accepted");
  });
});

describe("multipart: storage", () => {
  it("MemoryStorage exposes the buffer and can remove it", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("file", new Blob(["payload"]), "f.txt");
    });
    const { files } = await handleMultipartAnyFiles(
      req,
      transformUploadOptions({ storageType: "memory" }),
    );
    const file = files[0] as unknown as { type: string; buffer?: Buffer };
    expect(file.type).toBe("memory");
    expect(file.buffer?.toString()).toBe("payload");

    await new MemoryStorage().removeFile(file);
    expect(file.buffer).toBeUndefined();
  });

  it("DiskStorage writes the file to disk and removes it", async () => {
    const req = await multipartRequest((fd) => {
      fd.set("file", new Blob(["disk-payload"]), "f.txt");
    });
    const options = transformUploadOptions({
      storageType: "disk",
      dest: tmp,
    });
    const { files } = await handleMultipartAnyFiles(req, options);
    const file = files[0] as unknown as { type: string; path: string };
    expect(file.type).toBe("disk");
    expect(await Bun.file(file.path).exists()).toBe(true);

    await (options.storage as DiskStorage).removeFile(file, true);
    expect(await Bun.file(file.path).exists()).toBe(false);
  });
});
