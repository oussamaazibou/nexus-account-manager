import axios from 'axios';

const email = "abdo.charhamane@gmail.com";
const apiKey = "541da7b4fd89331cc0abe3cf712b1786e35ce";
const baseUrl = 'https://api.cloudflare.com/client/v4';
const zoneId = "000d69c19075e98b069ff4843027130d"; // Zone ID for ibergest.co.uk
const recordId = "e7dd18e8d1509fec8a98ac05d9423c61";

async function run() {
    try {
        console.log("Deleting old quoted TXT record...");
        const delRes = await axios.delete(`${baseUrl}/zones/${zoneId}/dns_records/${recordId}`, {
            headers: {
                'X-Auth-Email': email,
                'X-Auth-Key': apiKey,
                'Content-Type': 'application/json'
            }
        });
        console.log("Delete result:", delRes.data);

        console.log("Adding new clean TXT record...");
        const addRes = await axios.post(`${baseUrl}/zones/${zoneId}/dns_records`, {
            type: 'TXT',
            name: 'mynext-zone.ibergest.co.uk',
            content: 'google-site-verification=MhSsMDP8-arEg3ChYEHh7jwnkgPFem_hUWXQSd2jx8Y',
            ttl: 120
        }, {
            headers: {
                'X-Auth-Email': email,
                'X-Auth-Key': apiKey,
                'Content-Type': 'application/json'
            }
        });
        console.log("Add result:", addRes.data);
    } catch (err) {
        console.error(err.response ? err.response.data : err);
    }
}

run();
