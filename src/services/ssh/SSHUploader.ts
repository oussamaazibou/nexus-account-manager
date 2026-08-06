import { Client } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';

export interface SSHConfig {
    host: string;
    port: number;
    username: string;
    password: string;
    basePath: string;
}

export class SSHUploader {
    private config: SSHConfig;

    constructor(config: SSHConfig) {
        this.config = config;
    }

    /**
     * Upload authenticator secret key to remote server
     * @param email - User email (used for directory name)
     * @param secretKey - The authenticator secret key
     */
    async uploadSecretKey(email: string, secretKey: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const conn = new Client();

            conn.on('ready', () => {
                console.log(`[SSH] Connected to ${this.config.host}`);

                const remotePath = `${this.config.basePath}/${email}`;
                const fileName = `${email}_authenticator_secret_key.txt`;
                const remoteFilePath = `${remotePath}/${fileName}`;

                // Create directory and upload file
                conn.exec(`mkdir -p ${remotePath}`, (err: any, stream: any) => {
                    if (err) {
                        conn.end();
                        return reject(new Error(`Failed to create directory: ${err.message}`));
                    }

                    stream.on('close', (code: number) => {
                        if (code !== 0) {
                            conn.end();
                            return reject(new Error(`mkdir command failed with code ${code}`));
                        }

                        console.log(`[SSH] Created directory: ${remotePath}`);

                        // Now upload the file using SFTP
                        conn.sftp((err: any, sftp: any) => {
                            if (err) {
                                conn.end();
                                return reject(new Error(`SFTP error: ${err.message}`));
                            }

                            const writeStream = sftp.createWriteStream(remoteFilePath);

                            writeStream.on('error', (err: any) => {
                                conn.end();
                                reject(new Error(`Failed to write file: ${err.message}`));
                            });

                            writeStream.on('close', () => {
                                console.log(`[SSH] ✅ Uploaded secret key to: ${remoteFilePath}`);
                                conn.end();
                                resolve();
                            });

                            // Write the secret key
                            writeStream.write(secretKey);
                            writeStream.end();
                        });
                    });

                    stream.on('data', (data: Buffer) => {
                        console.log(`[SSH] ${data.toString()}`);
                    });

                    stream.stderr.on('data', (data: Buffer) => {
                        console.error(`[SSH Error] ${data.toString()}`);
                    });
                });
            });

            conn.on('error', (err: any) => {
                reject(new Error(`SSH connection error: ${err.message}`));
            });

            // Connect to server
            conn.connect({
                host: this.config.host,
                port: this.config.port,
                username: this.config.username,
                password: this.config.password
            });
        });
    }

    /**
     * Test SSH connection
     */
    async testConnection(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const conn = new Client();

            conn.on('ready', () => {
                console.log('[SSH] Connection test successful!');
                conn.end();
                resolve(true);
            });

            conn.on('error', (err: any) => {
                console.error(`[SSH] Connection test failed: ${err.message}`);
                reject(err);
            });

            conn.connect({
                host: this.config.host,
                port: this.config.port,
                username: this.config.username,
                password: this.config.password
            });
        });
    }

    /**
     * Download secret key from remote server
     * @param email - User email
     */
    async downloadSecretKey(email: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const conn = new Client();

            conn.on('ready', () => {
                const remotePath = `${this.config.basePath}/${email}/${email}_authenticator_secret_key.txt`;

                conn.sftp((err: any, sftp: any) => {
                    if (err) {
                        conn.end();
                        return reject(new Error(`SFTP error: ${err.message}`));
                    }

                    sftp.readFile(remotePath, 'utf8', (err: any, data: string) => {
                        conn.end();
                        if (err) {
                            return reject(new Error(`Failed to read remote secret: ${err.message}`));
                        }
                        resolve(data.trim());
                    });
                });
            });

            conn.on('error', (err: any) => {
                reject(new Error(`SSH connection error: ${err.message}`));
            });

            conn.connect({
                host: this.config.host,
                port: this.config.port,
                username: this.config.username,
                password: this.config.password
            });
        });
    }
}
