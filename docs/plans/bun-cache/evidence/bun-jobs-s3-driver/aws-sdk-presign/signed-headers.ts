// Which headers does the AWS SDK sign into a presigned URL for conditional writes? Offline: no request is sent.
// Run: cd aws-sdk-presign && bun install && bun signed-headers.ts   (SDK @aws-sdk/client-s3 3.1149.0)
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
const c = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "x" } });
const show = (u: string) => { const q = new URL(u).searchParams; console.log("SignedHeaders=", q.get("X-Amz-SignedHeaders"), "| query keys:", [...q.keys()].filter(k=>!k.startsWith("X-Amz-")).join(",")); };
show(await getSignedUrl(c, new PutObjectCommand({ Bucket: "b", Key: "k", IfNoneMatch: "*" }), { expiresIn: 60 }));
show(await getSignedUrl(c, new PutObjectCommand({ Bucket: "b", Key: "k", IfMatch: '"abc"' }), { expiresIn: 60 }));
show(await getSignedUrl(c, new PutObjectCommand({ Bucket: "b", Key: "k" }), { expiresIn: 60 }));
show(await getSignedUrl(c, new DeleteObjectCommand({ Bucket: "b", Key: "k", IfMatch: '"abc"' }), { expiresIn: 60 }));

