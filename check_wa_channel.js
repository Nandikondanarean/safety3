require('dotenv').config();
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function testWhatsAppNumbers() {
    const toPhone = '+919441568939';
    const personalNumber = process.env.TWILIO_PHONE_NUMBER;
    const sandboxNumber = '+14155238886'; // Standard Shared Sandbox
    
    console.log('--- WhatsApp Channel Discovery ---');
    
    // Test 1: Using your personal number
    try {
        console.log(`\nAttempt 1: Using Personal Number (whatsapp:${personalNumber})`);
        const msg1 = await client.messages.create({
            body: 'Test from Personal Number',
            from: `whatsapp:${personalNumber}`,
            to: `whatsapp:${toPhone}`
        });
        console.log('✅ SUCCESS with Personal Number!');
    } catch (err) {
        console.log('❌ FAILED with Personal Number:', err.message);
    }

    // Test 2: Using standard Sandbox number
    try {
        console.log(`\nAttempt 2: Using Sandbox Number (whatsapp:${sandboxNumber})`);
        const msg2 = await client.messages.create({
            body: 'Test from Sandbox Number',
            from: `whatsapp:${sandboxNumber}`,
            to: `whatsapp:${toPhone}`
        });
        console.log('✅ SUCCESS with Sandbox Number!');
    } catch (err) {
        console.log('❌ FAILED with Sandbox Number:', err.message);
    }
}

testWhatsAppNumbers();
