// Does the SDK bake an empty-body CRC32 into a presigned PUT URL by default? Offline.
// Run: bun checksum.ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
for (const rc of [undefined, "WHEN_REQUIRED"] as const) {
const c = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "x" }, ...(rc ? { requestChecksumCalculation: rc } : {}) });
const u = new URL(await getSignedUrl(c, new PutObjectCommand({ Bucket: "b", Key: "k", IfNoneMatch: "*" }), { expiresIn: 60 }));
console.log(rc ?? "default", "crc32=", u.searchParams.get("x-amz-checksum-crc32"), "signed=", u.searchParams.get("X-Amz-SignedHeaders"));
}
