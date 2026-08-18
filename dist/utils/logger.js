export class Logger {
    static info(message, context) {
        const timestamp = new Date().toISOString();
        console.log(`[INF] [${timestamp}] ${message}`, context ? JSON.stringify(context) : '');
    }
    static error(message, error) {
        const timestamp = new Date().toISOString();
        console.error(`[ERR] [${timestamp}] ${message}`, error);
    }
    static warn(message, context) {
        const timestamp = new Date().toISOString();
        console.warn(`[WRN] [${timestamp}] ${message}`, context ? JSON.stringify(context) : '');
    }
    static debug(message, context) {
        if (process.env.DEBUG === 'true') {
            const timestamp = new Date().toISOString();
            console.log(`[DBG] [${timestamp}] ${message}`, context ? JSON.stringify(context) : '');
        }
    }
}
