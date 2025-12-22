const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    phoneNumber: {
        type: String,
        required: true,
        index: true
    },
    countryCode: {
        type: String,
        required: true,
        default: '+91'
    },
    otp: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['registration', 'forgot_password', 'login'],
        required: true,
        default: 'registration'
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    expiresAt: {
        type: Date,
        required: true,
        index: { expireAfterSeconds: 0 } // Auto-delete expired OTPs
    },
    attempts: {
        type: Number,
        default: 0,
        max: 5 // Max 5 verification attempts
    }
}, {
    timestamps: true
});

// Index for faster queries
otpSchema.index({ userId: 1, type: 1, isVerified: 0 });
otpSchema.index({ phoneNumber: 1, type: 1, isVerified: 0 });
otpSchema.index({ expiresAt: 1 });

module.exports = mongoose.model('OTP', otpSchema);

