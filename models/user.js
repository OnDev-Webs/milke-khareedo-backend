
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    profileImage: {
        type: String,
        default: null
    },
    firstName: {
        type: String,
        required: [true, 'Please provide a first name'],
        trim: true
    },
    lastName: {
        type: String,
        required: [true, 'Please provide a last name'],
        trim: true
    },
    // Keep name for backward compatibility (computed from firstName + lastName)
    name: {
        type: String,
        trim: true
    },
    email: {
        type: String,
        required: [true, 'Please provide an email'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email']
    },
    phoneNumber: {
        type: String,
        required: [true, 'Please provide a phone number'],
        match: [/^[0-9]{10}$/, "Phone number must be 10 digits"]
    },
    countryCode: {
        type: String,
        required: [true, 'Please provide a country code'],
        default: '+91',
        trim: true
    },
    // Profile fields (can be updated later)
    pincode: {
        type: String,
        trim: true
    },
    city: {
        type: String,
        trim: true
    },
    state: {
        type: String,
        trim: true
    },
    country: {
        type: String,
        trim: true,
        default: 'India'
    },
    password: {
        type: String,
        required: [true, 'Please provide a password'],
        minlength: 6,
        select: false
    },
    role: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Role',
        required: true
    },
}, {
    timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Auto-generate name from firstName + lastName before saving
userSchema.pre('save', function (next) {
    if (this.firstName && this.lastName) {
        this.name = `${this.firstName} ${this.lastName}`.trim();
    }
    next();
});

module.exports = mongoose.model('User', userSchema);
