const mongoose = require('mongoose');
const contactPreferencesSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true },

    // Preferences (from My Preferences section)
    preferredLocations: [
        {
            name: String, // Location name (e.g., "Hitech City")
            latitude: Number, // Latitude coordinate
            longitude: Number // Longitude coordinate
        }
    ],
    budgetMin: Number, // Minimum budget in rupees
    budgetMax: Number, // Maximum budget in rupees
    floorMin: Number, // Minimum floor preference (e.g., 6)
    floorMax: Number, // Maximum floor preference (e.g., 10)

    // Legacy fields (kept for backward compatibility)
    fullAddress: String,
    email: String,
    mobile: String,
    pinCode: String,
    city: String,
    state: String,
    country: String,
    preferredHouseType: [String],
    preferredDirection: [String]

}, { timestamps: true });

module.exports = mongoose.model('ContactPreferences', contactPreferencesSchema);
