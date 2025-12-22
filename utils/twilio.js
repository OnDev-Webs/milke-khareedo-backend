const twilio = require('twilio');
const { logInfo, logError } = require('./logger');

// Initialize Twilio client
let twilioClient = null;

const initializeTwilio = () => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
        logError('Twilio credentials not found in environment variables');
        return null;
    }

    try {
        twilioClient = twilio(accountSid, authToken);
        logInfo('Twilio client initialized successfully');
        return twilioClient;
    } catch (error) {
        logError('Error initializing Twilio client', error);
        return null;
    }
};

// Get Twilio client (lazy initialization)
const getTwilioClient = () => {
    if (!twilioClient) {
        return initializeTwilio();
    }
    return twilioClient;
};

// Generate 6-digit OTP
const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// Send OTP via SMS
const sendOTP = async (phoneNumber, countryCode, otp, type = 'registration') => {
    try {
        const client = getTwilioClient();
        if (!client) {
            throw new Error('Twilio client not initialized');
        }

        // Format phone number with country code
        const formattedPhone = `${countryCode}${phoneNumber}`;

        // Get message template based on type
        let messageBody = '';
        switch (type) {
            case 'registration':
                messageBody = process.env.TWILIO_REGISTRATION_MESSAGE ||
                    `Your OTP for Milke Khareedo registration is ${otp}. This OTP is valid for 10 minutes. Do not share this OTP with anyone.`;
                break;
            case 'forgot_password':
                messageBody = process.env.TWILIO_FORGOT_PASSWORD_MESSAGE ||
                    `Your OTP for Milke Khareedo password reset is ${otp}. This OTP is valid for 10 minutes. Do not share this OTP with anyone.`;
                break;
            case 'login':
                messageBody = process.env.TWILIO_LOGIN_MESSAGE ||
                    `Your OTP for Milke Khareedo login is ${otp}. This OTP is valid for 10 minutes. Do not share this OTP with anyone.`;
                break;
            default:
                messageBody = `Your OTP for Milke Khareedo is ${otp}. This OTP is valid for 10 minutes. Do not share this OTP with anyone.`;
        }

        // Replace {{OTP}} placeholder if exists
        messageBody = messageBody.replace('{{OTP}}', otp);

        // Get Twilio phone number from env
        const fromNumber = process.env.TWILIO_PHONE_NUMBER;
        if (!fromNumber) {
            throw new Error('TWILIO_PHONE_NUMBER not found in environment variables');
        }

        // Send SMS
        const message = await client.messages.create({
            body: messageBody,
            from: fromNumber,
            to: formattedPhone
        });

        logInfo('OTP sent successfully via Twilio', {
            phoneNumber: formattedPhone,
            messageSid: message.sid,
            type
        });

        return {
            success: true,
            messageSid: message.sid,
            status: message.status
        };

    } catch (error) {
        logError('Error sending OTP via Twilio', error, {
            phoneNumber,
            countryCode,
            type
        });

        // Return error but don't throw (to handle gracefully)
        return {
            success: false,
            error: error.message
        };
    }
};

// Verify OTP (just for logging, actual verification happens in controller)
const verifyOTP = async (phoneNumber, countryCode, otp) => {
    // This is just a placeholder - actual verification is done in database
    // Twilio Verify API can be used here if needed
    return { success: true };
};

module.exports = {
    initializeTwilio,
    getTwilioClient,
    generateOTP,
    sendOTP,
    verifyOTP
};

