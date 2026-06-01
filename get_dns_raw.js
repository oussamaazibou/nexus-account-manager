import dns from 'dns';

dns.resolveTxt('mynext-zone.ibergest.co.uk', (err, records) => {
    if (err) {
        console.error('DNS Error:', err);
        return;
    }
    console.log('Raw DNS TXT Records:');
    console.log(JSON.stringify(records, null, 2));
});
