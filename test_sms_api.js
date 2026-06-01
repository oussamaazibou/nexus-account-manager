import axios from 'axios';

const API_KEY = '52f6060efdA770541bf3e867A6ccbdAb';
const URL = `https://hero-sms.com/stubs/handler_api.php?api_key=${API_KEY}&action=getBalance`;

console.log("Testing API connection...");

try {
    const response = await axios.get(URL);
    console.log("Response:", response.data);
} catch (error) {
    console.error("Error:", error.message);
    if (error.response) {
        console.error("Status:", error.response.status);
        console.error("Data:", error.response.data);
    }
}
