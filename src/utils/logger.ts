import { AsyncLocalStorage } from 'async_hooks';

/**
 * Every job sets a per-job log context (the account email). Whether it's the
 * main process (Express, server.js) or a worker job, any Logger call will
 * automatically carry the email so the server's console interceptor
 * (server.js /api/logs) routes it into the correct account's Process Log.
 */
export const logContext = new AsyncLocalStorage<{ email?: string }>();

/**
 * Run a callback with a log context (usually the account email being processed).
 * All Logger.* calls inside `fn` (including async/awaited children) inherit it.
 */
export function withLogContext<T>(ctx: { email?: string }, fn: () => T): T {
    return logContext.run(ctx, fn);
}

export class Logger {
    private static format(message: string, context?: any): string {
        let msg = message;
        const ctx = logContext.getStore();
        if (ctx && ctx.email) {
            // Only append the email if the message doesn't already carry one,
            // to avoid duplicate addresses like a@b.com [a@b.com].
            if (!/@/.test(msg)) {
                msg = `[${ctx.email}] ${msg}`;
            } else if (!new RegExp(ctx.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(msg)) {
                msg = `${msg} [${ctx.email}]`;
            }
        }
        return msg;
    }

    static info(message: string, context?: any) {
        const timestamp = new Date().toISOString();
        console.log(`[INF] [${timestamp}] ${Logger.format(message, context)}`, context ? JSON.stringify(context) : '');
    }

    static error(message: string, error?: any) {
        const timestamp = new Date().toISOString();
        console.error(`[ERR] [${timestamp}] ${Logger.format(message, error)}`, error);
    }

    static warn(message: string, context?: any) {
        const timestamp = new Date().toISOString();
        console.warn(`[WRN] [${timestamp}] ${Logger.format(message, context)}`, context ? JSON.stringify(context) : '');
    }

    static debug(message: string, context?: any) {
        if (process.env.DEBUG === 'true') {
            const timestamp = new Date().toISOString();
            console.log(`[DBG] [${timestamp}] ${Logger.format(message, context)}`, context ? JSON.stringify(context) : '');
        }
    }
}