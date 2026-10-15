import { FileTypeValidator, MaxFileSizeValidator, ParseFilePipe } from "@nestjs/common";
// 1x1 PNG
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a7e4b3a60000000049454e44ae426082", "hex");
const file = { fieldname: "f", originalname: "a.png", mimetype: "image/png", size: png.length, buffer: png };
const v = new FileTypeValidator({ fileType: "image/png" });
console.log("FileTypeValidator png ok:", await v.isValid(file as any));
const bad = { ...file, buffer: Buffer.from("not a png"), mimetype: "image/png" };
console.log("FileTypeValidator fake png:", await v.isValid(bad as any));
const pipe = new ParseFilePipe({ validators: [new MaxFileSizeValidator({ maxSize: 1000 }), v] });
console.log("ParseFilePipe:", (await pipe.transform(file as any)) === file);
console.log("ParseFilePipe null:", await pipe.transform(null as any).then(() => "accepted", (e) => e.constructor.name + ": " + e.message));
