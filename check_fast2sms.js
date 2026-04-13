require('dotenv').config();
const axios = require('axios');

async function check() {
    try {
        const response = await axios.post('https://www.fast2sms.com/dev/bulkV2', {
            "message": "Test SMS",
            "language": "english",
            "route": "q",
            "numbers": "9441568939"
        }, {
            headers: { "authorization": process.env.FAST2SMS_API_KEY }
        });
        console.log('✅ RESPONSE:', response.data);
    } catch (err) {
        console.log('❌ ERROR:', err.response ? err.response.data : err.message);
    }
}
check();
