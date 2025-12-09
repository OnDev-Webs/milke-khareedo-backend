import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import path from "path";

const s3 = new S3Client({
    region: process.env.AWS_BUCKET_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

export const uploadToS3 = async (file, folder = "developers") => {
    if (!file || !file.buffer) throw new Error("No file provided");

    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const fileName = `${folder}/${timestamp}_${file.originalname}`;

    // Optional: Image compression using sharp
    let fileBuffer = file.buffer;
    if (file.mimetype.startsWith("image/")) {
        fileBuffer = await sharp(file.buffer).jpeg({ quality: 70 }).toBuffer();
    }

    const params = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: fileName,
        Body: fileBuffer,
        ContentType: file.mimetype,
    };

    await s3.send(new PutObjectCommand(params));

    return `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_BUCKET_REGION}.amazonaws.com/${fileName}`;
};
