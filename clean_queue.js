import { Queue } from 'bullmq';
import 'dotenv/config';

const redisConnection = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
};

async function cleanQueue() {
    console.log('Connecting to Redis...');
    const queue = new Queue('prep-queue', { connection: redisConnection });
    
    console.log('Obliterating prep-queue...');
    await queue.obliterate({ force: true });
    
    console.log('Queue cleared successfully!');
    await queue.close();
    process.exit(0);
}

cleanQueue().catch(err => {
    console.error('Failed to clean queue:', err);
    process.exit(1);
});
