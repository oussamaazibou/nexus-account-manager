import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import fs from 'fs';
import { Logger } from '../../utils/logger.js';

export class S3Uploader {
    private getRuntimeS3() {
        let config: any = {};
        try {
            const configPath = `${process.cwd()}/config.json`;
            if (fs.existsSync(configPath)) {
                config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        } catch (error: any) {
            Logger.warn(`Failed to reload S3 config: ${error.message}`);
        }

        const accessKeyId = config.awsAccessKey || process.env.AWS_ACCESS_KEY_ID || '';
        const secretAccessKey = config.awsSecretKey || process.env.AWS_SECRET_ACCESS_KEY || '';
        const region = config.awsRegion || process.env.AWS_REGION || 'us-east-1';
        const readBucket = config.awsBucket || process.env.AWS_BUCKET_NAME || 'dev-app-passwords';
        const writeBucket = config.awsWriteBucket || config.awsBucket || process.env.AWS_WRITE_BUCKET || readBucket;

        const client = new S3Client({
            region,
            credentials: { accessKeyId, secretAccessKey }
        });

        return { client, accessKeyId, secretAccessKey, readBucket, writeBucket };
    }

    async downloadJson(key: string): Promise<any> {
        const { client, accessKeyId, secretAccessKey, readBucket, writeBucket } = this.getRuntimeS3();
        if (!accessKeyId || !secretAccessKey) {
            Logger.info(`S3 Credentials not configured. Skipping download: ${key}`);
            return null;
        }
        // Try write bucket first, fallback to read bucket
        for (const bucket of [...new Set([writeBucket, readBucket])]) {
            try {
                const command = new GetObjectCommand({ Bucket: bucket, Key: key });
                const response = await client.send(command);
                const chunks: Buffer[] = [];
                for await (const chunk of response.Body as any) chunks.push(Buffer.from(chunk));
                return JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (e: any) {
                if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) continue;
                throw e;
            }
        }
        Logger.warn(`Key not found in any bucket: ${key}`);
        return null;
    }

    async uploadFile(key: string, filePath: string): Promise<string> {
        try {
            const { client, accessKeyId, secretAccessKey, writeBucket } = this.getRuntimeS3();
            if (!accessKeyId || !secretAccessKey) {
                Logger.info(`S3 Credentials not configured. Skipping upload for: ${key}`);
                return `local://${filePath}`;
            }
            Logger.info(`Uploading file to S3: ${key}`);
            const fileStream = fs.createReadStream(filePath);

            const command = new PutObjectCommand({
                Bucket: writeBucket,
                Key: key,
                Body: fileStream
            });

            await client.send(command);
            Logger.info(`Upload successfully: ${key}`);
            return `s3://${writeBucket}/${key}`;

        } catch (error: any) {
            Logger.error(`S3 Upload Failed`, error);
            throw error;
        }
    }
}
