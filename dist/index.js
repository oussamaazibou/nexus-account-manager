import { Queue } from 'bullmq';
import { PrepWorker } from './jobs/PrepWorker.js';
import { Logger } from './utils/logger.js';
import dotenv from 'dotenv';
import { Redis as IORedis } from 'ioredis';
dotenv.config();
const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    maxRetriesPerRequest: null
};
const connection = new IORedis(redisConfig);
const prepQueue = new Queue('prep-queue', { connection });
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    if (command === 'worker') {
        Logger.info("Starting Worker...");
        new PrepWorker(connection);
        // Keep alive
        setInterval(() => { }, 1000);
    }
    else if (command === 'prepare') {
        const projectId = args[1];
        const userEmail = args[2];
        if (!projectId || !userEmail) {
            console.error("Usage: node dist/index.js prepare <projectId> <userEmail> [saName]");
            process.exit(1);
        }
        const saName = args[3] || 'automation-sa';
        Logger.info(`Enqueuing job for ${projectId}...`);
        await prepQueue.add('prepare-workspace', {
            projectId,
            userEmail,
            saName,
            orgId: process.env.ORG_ID
        });
        Logger.info("Job Enqueued.");
        process.exit(0);
    }
    else if (command === 'prepare-file') {
        const filePath = args[1];
        const fs = await import('fs');
        const readline = await import('readline');
        if (!filePath) {
            console.error("Usage: node dist/index.js prepare-file <filePath>");
            process.exit(1);
        }
        try {
            const fileStream = fs.createReadStream(filePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });
            let count = 0;
            for await (const line of rl) {
                if (!line.trim())
                    continue;
                // Format: email:password
                const parts = line.split(':');
                if (parts.length < 2) {
                    Logger.error(`Skipping invalid line (no password): ${line}`);
                    continue;
                }
                const email = parts[0].trim();
                const password = parts.slice(1).join(':').trim(); // Handle passwords with ':'
                if (!email.includes('@')) {
                    Logger.error(`Skipping invalid email: ${email}`);
                    continue;
                }
                count++;
                // Generate Project ID: "user-domain-random"
                const userPart = email.split('@')[0].replace(/[^a-z0-9]/gi, '-').toLowerCase();
                const domainPart = email.split('@')[1].split('.')[0].replace(/[^a-z0-9]/gi, '-').toLowerCase();
                const randomId = Math.random().toString(36).substring(2, 7);
                const projectId = `${userPart}-${domainPart}-${randomId}`.substring(0, 30);
                const saName = 'automation-sa';
                try {
                    Logger.info(`Enqueuing job for ${email} (Project: ${projectId})...`);
                    await prepQueue.add('prepare-workspace', {
                        projectId,
                        userEmail: email,
                        userPassword: password, // Pass password for gcloud auth
                        saName,
                        orgId: process.env.ORG_ID
                    });
                }
                catch (queueError) {
                    Logger.error(`Failed to enqueue job for ${email}: ${queueError.message}`);
                }
            }
            Logger.info(`Enqueued ${count} jobs from ${filePath}.`);
            process.exit(0);
        }
        catch (error) {
            Logger.error("Failed to process file", error);
            process.exit(1);
        }
    }
    else {
        console.log("Commands: worker, prepare, prepare-file");
        process.exit(0);
    }
}
main().catch(err => Logger.error("Main Error", err));
