import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import fs from 'fs';
import { Logger } from '../../utils/logger.js';
export class S3Uploader {
    constructor() {
        this.client = new S3Client({
            region: process.env.AWS_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
            }
        });
        this.bucketName = process.env.AWS_BUCKET_NAME || 'automation-keys-bucket';
    }
    async downloadJson(key) {
        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            Logger.info(`S3 Credentials not configured. Skipping download: ${key}`);
            return null;
        }
        const command = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
        const response = await this.client.send(command);
        const chunks = [];
        for await (const chunk of response.Body)
            chunks.push(Buffer.from(chunk));
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    async uploadFile(key, filePath) {
        try {
            if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
                Logger.info(`S3 Credentials not configured. Skipping upload for: ${key}`);
                return `local://${filePath}`;
            }
            Logger.info(`Uploading file to S3: ${key}`);
            const fileStream = fs.createReadStream(filePath);
            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: key,
                Body: fileStream
            });
            await this.client.send(command);
            Logger.info(`Upload successfully: ${key}`);
            return `s3://${this.bucketName}/${key}`;
        }
        catch (error) {
            Logger.error(`S3 Upload Failed`, error);
            throw error;
        }
    }
}
