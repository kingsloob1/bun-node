import { describe, expect, it } from "bun:test";
import { firstValueFrom } from "rxjs";
import {
  AnyFilesInterceptor,
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
  getMultipartRequest,
  NoFilesInterceptor,
} from "../lib/interceptors";
import {
  makeCallHandler,
  makeExecutionContext,
  makeMultipartRequest,
} from "./helpers";

describe("getMultipartRequest", () => {
  it("returns the request for a multipart context", async () => {
    const req = await makeMultipartRequest((fd) => fd.set("a", "1"));
    const ctx = makeExecutionContext(req);
    expect(getMultipartRequest(ctx.switchToHttp())).toBe(req);
  });
});

describe("FileInterceptor", () => {
  it("attaches a single uploaded file to the request", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.set("avatar", new Blob(["bytes"]), "avatar.txt");
      fd.set("name", "kingsley");
    });
    const Interceptor = FileInterceptor("avatar", { storageType: "memory" });
    const result = await firstValueFrom(
      await new Interceptor().intercept(
        makeExecutionContext(req),
        makeCallHandler("done"),
      ),
    );

    expect(result).toBe("done");
    expect(req.storageFile).toBeDefined();
    expect((req.body as Record<string, unknown>).name).toBe("kingsley");
  });
});

describe("FilesInterceptor", () => {
  it("collects multiple files up to the limit", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.append("docs", new Blob(["1"]), "1.txt");
      fd.append("docs", new Blob(["2"]), "2.txt");
    });
    const Interceptor = FilesInterceptor("docs", 5, { storageType: "memory" });
    await firstValueFrom(
      await new Interceptor().intercept(
        makeExecutionContext(req),
        makeCallHandler(),
      ),
    );
    expect(Array.isArray(req.storageFiles)).toBe(true);
    expect((req.storageFiles as unknown[]).length).toBe(2);
  });
});

describe("AnyFilesInterceptor", () => {
  it("collects files from any field", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.set("a", new Blob(["x"]), "a.txt");
      fd.set("b", new Blob(["y"]), "b.txt");
    });
    const Interceptor = AnyFilesInterceptor({ storageType: "memory" });
    await firstValueFrom(
      await new Interceptor().intercept(
        makeExecutionContext(req),
        makeCallHandler(),
      ),
    );
    expect((req.storageFiles as unknown[]).length).toBe(2);
  });
});

describe("FileFieldsInterceptor", () => {
  it("groups files by declared field", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.set("avatar", new Blob(["x"]), "a.txt");
      fd.set("cover", new Blob(["y"]), "c.txt");
    });
    const Interceptor = FileFieldsInterceptor(
      [{ name: "avatar" }, { name: "cover" }],
      { storageType: "memory" },
    );
    await firstValueFrom(
      await new Interceptor().intercept(
        makeExecutionContext(req),
        makeCallHandler(),
      ),
    );
    const files = req.storageFiles as Record<string, unknown[]>;
    expect(files.avatar.length).toBe(1);
    expect(files.cover.length).toBe(1);
  });
});

describe("NoFilesInterceptor", () => {
  it("passes through field-only multipart requests", async () => {
    const req = await makeMultipartRequest((fd) => fd.set("name", "value"));
    const Interceptor = NoFilesInterceptor({ storageType: "memory" });
    const result = await firstValueFrom(
      await new Interceptor().intercept(
        makeExecutionContext(req),
        makeCallHandler("ok"),
      ),
    );
    expect(result).toBe("ok");
    expect((req.body as Record<string, unknown>).name).toBe("value");
  });

  it("rejects multipart requests that contain files", async () => {
    const req = await makeMultipartRequest((fd) => {
      fd.set("file", new Blob(["x"]), "x.txt");
    });
    const Interceptor = NoFilesInterceptor({ storageType: "memory" });
    await expect(
      new Interceptor().intercept(makeExecutionContext(req), makeCallHandler()),
    ).rejects.toThrow();
  });
});
