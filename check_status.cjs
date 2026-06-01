// Quick status checker
const fs = require('fs');
const { execSync } = require('child_process');

console.log('\n=== Worker Status Check ===\n');

// Check browser
try {
    const chrome = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV', { encoding: 'utf8' });
    const chromeLines = chrome.split('\n').filter(l => l.includes('chrome.exe'));
    console.log(`Browser: ${chromeLines.length > 0 ? 'RUNNING' : 'NOT RUNNING'} (${chromeLines.length} processes)`);
} catch (e) {
    console.log('Browser: ERROR checking');
}

// Check latest screenshot
try {
    const screenshots = fs.readdirSync('.').filter(f => f.endsWith('.png'));
    if (screenshots.length > 0) {
        const latest = screenshots
            .map(f => ({ name: f, time: fs.statSync(f).mtime }))
            .sort((a, b) => b.time - a.time)[0];

        const age = Math.floor((Date.now() - latest.time) / 1000);
        console.log(`\nLatest Screenshot: ${latest.name}`);
        console.log(`  Age: ${age} seconds ago`);
        console.log(`  Time: ${latest.time.toLocaleTimeString()}`);
    }
} catch (e) {
    console.log('\nScreenshots: ERROR checking');
}

// Check secrets folder
try {
    if (fs.existsSync('secrets')) {
        const secrets = fs.readdirSync('secrets');
        console.log(`\nSecrets folder: ${secrets.length} files`);
        if (secrets.length > 0) {
            const latest = secrets
                .map(f => ({ name: f, time: fs.statSync(`secrets/${f}`).mtime }))
                .sort((a, b) => b.time - a.time)[0];
            console.log(`  Latest: ${latest.name} (${Math.floor((Date.now() - latest.time) / 1000)}s ago)`);
        }
    }
} catch (e) {
    console.log('\nSecrets: ERROR checking');
}

// Check for domain JSON keys
try {
    const jsonKeys = fs.readdirSync('.').filter(f => f.endsWith('.json') && f.includes('.'));
    if (jsonKeys.length > 0) {
        console.log(`\nJSON Keys: ${jsonKeys.length} found`);
        jsonKeys.forEach(k => {
            const age = Math.floor((Date.now() - fs.statSync(k).mtime) / 1000);
            console.log(`  - ${k} (${age}s ago)`);
        });
    }
} catch (e) {
    console.log('\nJSON Keys: ERROR checking');
}

console.log('\n' + '='.repeat(50) + '\n');
