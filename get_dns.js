import axios from 'axios';
import fs from 'fs';
import path from 'path';

const email = 'abdo.charhamane@gmail.com';
const apiKey = '541da7b4fd89331cc0abe3cf712b1786e35ce';
const baseUrl = 'https://api.cloudflare.com/client/v4';

async function getDnsRecords() {
    try {
        console.log('Querying Cloudflare zones...');
        const zoneResponse = await axios.get(`${baseUrl}/zones`, {
            headers: {
                'X-Auth-Email': email,
                'X-Auth-Key': apiKey,
                'Content-Type': 'application/json'
            },
            params: {
                name: 'ibergest.co.uk',
                status: 'active'
            }
        });

        if (!zoneResponse.data.success || zoneResponse.data.result.length === 0) {
            console.error('Zone ibergest.co.uk not found');
            return;
        }

        const zoneId = zoneResponse.data.result[0].id;
        console.log(`Zone ID for ibergest.co.uk is: ${zoneId}`);

        console.log('Fetching DNS records for zone...');
        const dnsResponse = await axios.get(`${baseUrl}/zones/${zoneId}/dns_records`, {
            headers: {
                'X-Auth-Email': email,
                'X-Auth-Key': apiKey,
                'Content-Type': 'application/json'
            },
            params: {
                per_page: 100
            }
        });

        if (dnsResponse.data.success) {
            const records = dnsResponse.data.result.filter(r => r.name.includes('mynext-zone'));
            console.log('\n=== DNS Records matching "mynext-zone" ===\n');
            records.forEach(r => {
                console.log(`Type: ${r.type}`);
                console.log(`Name: ${r.name}`);
                console.log(`Content: ${r.content}`);
                if (r.priority) console.log(`Priority: ${r.priority}`);
                console.log(`ID: ${r.id}`);
                console.log('------------------------');
            });
        }
    } catch (e) {
        console.error('Error querying Cloudflare:', e.message);
    }
}

getDnsRecords();
