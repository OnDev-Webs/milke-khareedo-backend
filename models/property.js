const mongoose = require('mongoose');
const crypto = require('crypto');

const connectivitySchema = new mongoose.Schema({
    name: String,
    latitude: Number,
    longitude: Number
});

const layoutSchema = new mongoose.Schema({
    configurationUnitType: {
        type: String,
        required: true
    },
    image: {
        type: String,
        required: true
    }
});

const configurationSchema = new mongoose.Schema({
    unitType: { type: String, required: true },
    carpetArea: String,
    builtUpArea: String,
    price: String,
    availabilityStatus: {
        type: String,
        enum: ['Available', 'Sold', 'Reserved'],
        default: 'Available'
    }
});

const propertySchema = new mongoose.Schema(
    {
        projectId: {
            type: String,
            unique: true
        },

        projectName: {
            type: String,
            required: true
        },

        developer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Developer',
            required: true
        },

        location: { type: String, required: true },

        projectSize: String,
        landParcel: String,
        possessionDate: Date,
        developerPrice: String,
        groupPrice: String,
        minGroupMembers: Number,

        reraId: String,
        reraQrImage: String,

        possessionStatus: {
            type: String,
            enum: ['Ready To Move', 'Under Construction']
        },

        description: String,

        configurations: [configurationSchema],

        images: [
            {
                url: String,
                isCover: { type: Boolean, default: false },
                order: { type: Number, default: 1 }
            }
        ],

        highlights: [String],
        amenities: [String],

        layouts: [layoutSchema],

        connectivity: {
            schools: [connectivitySchema],
            hospitals: [connectivitySchema],
            transportation: [connectivitySchema],
            restaurants: [connectivitySchema]
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

        isStatus: {
            type: Boolean,
            default: true
        }

    },
    { timestamps: true }
);

propertySchema.pre('save', async function (next) {
    if (!this.projectId) {
        const random = crypto.randomInt(10000, 99999);
        const formattedName = this.projectName.replace(/\s+/g, "");
        this.projectId = `#${formattedName}-${random}`;
    }
    next();
});

module.exports = mongoose.model('Property', propertySchema);
