const mongoose = require('mongoose');
const contactPreferencesSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true },

    fullAddress: String,  
    email: String,
    mobile: String,
    pinCode: String,
    city: String,
    state: String,
    country: String,

    preferredLocations: [
        {
            name: String,
            distance: Number
        }
    ],

    budgetMin: Number,
    budgetMax: Number,

    preferredHouseType: [String],
    preferredDirection: [String],

    preferredFloor: [Number]

}, { timestamps: true });

module.exports = mongoose.model('ContactPreferences', contactPreferencesSchema);
