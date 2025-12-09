const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema({
    projectName: {
        type: String,
        required: true,
        trim: true
    },
    developer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Developer',
        required: true
    },
    location: {
        type: String,
        required: true
    },
    projectSize: String,
    landParcel: Number,
    possessionDate: Date,
    developerPrice: Number,
    groupPrice: Number,
    minGroupMembers: Number,
    reraId: String,
    reraQrImage: String,
    possessionStatus: { type: String, enum: ['Ready To Move', 'Under Construction'] },
    description: String,
    configurations: [
        {
            unitType: String,
            carpetArea: Number,
            builtUpArea: Number,
            price: Number,
            availabilityStatus: {
                type: String,
                enum: ['Available', 'Sold', 'Reserved'],
                default: 'Available'
            }
        }
    ],
    images: [
        {
            url: { type: String },
            isCover: { type: Boolean, default: false },
            order:{ type: Number, default: 1 }
        }
    ],
    highlights: [String],
    amenities: [String],
    layouts: [
        {
            image: { type: String },
            carpetArea: Number,
            builtUpArea: Number,
            price: Number,
            availabilityStatus: { type: String, enum: ['Available', 'Sold', 'Reserved'], default: 'Available' }
        }
    ],
    connectivity: {
        schools: [{ name: String, }],
        hospitals: [{ name: String, }],
        transportation: [{ name: String, }],
        restaurants: [{ name: String, }]
    },
    relationshipManager: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },

    leadDistributionAgents: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        }
    ],
    status: {
        type: String,
        enum: ['Active', 'Inactive'],
        default: 'Inactive'
    }
}, { timestamps: true });

module.exports = mongoose.model('Property', propertySchema);
