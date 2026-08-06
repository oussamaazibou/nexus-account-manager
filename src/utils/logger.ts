export class Logger {
    static info(message: string, context?: any) {
        const timestamp = new Date().toISOString();
        console.log(`[INF] [${timestamp}] ${message}`, context ? JSON.stringify(context) : '');
    }

    static error(message: string, error?: any) {
        const timestamp = new Date().toISOString();
        console.error(`[ERR] [${timestamp}] ${message}`, error);
    }

    static warn(message: string, context?: any) {
        const timestamp = new Date().toISOString();
        console.warn(`[WRN] [${timestamp}] ${message}`, context ? JSON.stringify(context) : '');
    }

    static debug(message: string, context?: any) {
        if (process.env.DEBUG === 'true') {
            const timestamp = new Date().toISOString();
            console.log(`[DBG] [${timestamp}] ${message}`, context ? JSON.stringify(context) : '');
        }
    }
}
