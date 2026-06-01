const { Client } = require('ssh2');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  conn.exec('find / -name "nexus-account-manager" -type d 2>/dev/null', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
      conn.end();
    }).on('data', (data) => {
      console.log('OUTPUT: ' + data);
    }).stderr.on('data', (data) => {
      console.log('STDERR: ' + data);
    });
  });
}).connect({
  host: config.sftpHost,
  port: 22,
  username: config.sftpUser || 'root',
  password: config.sftpPassword
});
