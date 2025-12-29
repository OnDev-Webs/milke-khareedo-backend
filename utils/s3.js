const sharp = require("sharp");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const path = require("path");

const s3 = new S3Client({
    region: process.env.AWS_BUCKET_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const uploadToS3 = async (file, folder = "developers") => {
    if (!file || !file.buffer) {
        throw new Error("No file provided");
    }

    try {
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        const fileName = `${folder}/${timestamp}_${file.originalname}`;

        // Optional: Image compression using sharp
        let fileBuffer = file.buffer;
        if (file.mimetype && file.mimetype.startsWith("image/")) {
            try {
                fileBuffer = await sharp(file.buffer).jpeg({ quality: 70 }).toBuffer();
            } catch (sharpError) {
                // If sharp fails, use original buffer
                console.warn('Sharp compression failed, using original buffer:', sharpError.message);
                fileBuffer = file.buffer;
            }
        }

        const params = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: fileName,
            Body: fileBuffer,
            ContentType: file.mimetype || 'application/octet-stream',
        };

        await s3.send(new PutObjectCommand(params));

        const url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_BUCKET_REGION}.amazonaws.com/${fileName}`;
        return url;
    } catch (error) {
        console.error('S3 Upload Error:', error);
        throw new Error(`Failed to upload file to S3: ${error.message}`);
    }
};

const uploadBufferToS3 = async (buffer, fileName, folder = "exports", contentType = "text/csv") => {
    if (!buffer) {
        throw new Error("No buffer provided");
    }

    try {
        const timestamp = Date.now();
        const fileKey = `${folder}/${timestamp}_${fileName}`;

        const params = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: fileKey,
            Body: buffer,
            ContentType: contentType,
        };

        await s3.send(new PutObjectCommand(params));

        const url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_BUCKET_REGION}.amazonaws.com/${fileKey}`;
        return url;
    } catch (error) {
        console.error('S3 Upload Error:', error);
        throw new Error(`Failed to upload file to S3: ${error.message}`);
    }
};

module.exports = { uploadToS3, uploadBufferToS3 };
