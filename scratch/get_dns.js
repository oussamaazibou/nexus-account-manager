import axios from 'axios';

const email = "abdo.charhamane@gmail.com";
const apiKey = "541da7b4fd89331cc0abe3cf712b1786e35ce";
const baseUrl = 'https://api.cloudflare.com/client/v4';

async function run() {
    try {
        const zoneRes = await axios.get(`${baseUrl}/zones`, {
            headers: {
                'X-Auth-Email': email,
                'X-Auth-Key': apiKey,
                'Content-Type': 'application/json'
            },
            params: { name: 'ibergest.co.uk', status: 'active' }
        });
        const zoneId = zoneRes.data.result[0].id;
        
        const dnsRes = await axios.get(`${baseUrl}/zones/${zoneId}/dns_records`, {
            headers: {
                'X-Auth-Email': email,
                'X-Auth-Key': apiKey,
                'Content-Type': 'application/json'
            }
        });

        const records = dnsRes.data.result;
        console.log("=== Target Domain Records ===");
        for (const r of records) {
            if (r.name.includes('mynext-zone')) {
                console.log(`[${r.type}] ${r.name} -> content: ${JSON.stringify(r.content)} (priority: ${r.priority}, id: ${r.id})`);
            }
        }
    } catch (err) {
        console.error(err);
    }
}

run();
