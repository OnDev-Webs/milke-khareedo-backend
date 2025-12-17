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
        latitude: { type: Number },
        longitude: { type: Number },

        projectSize: String,
        landParcel: String,
        possessionDate: Date,
        developerPrice: String,
        offerPrice: String,
        discountPercentage: { type: String, default: "00.00%" },
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

// Helper function to parse price string to number
const parsePriceToNumber = (priceStr) => {
    if (!priceStr) return 0;
    let priceNum = parseFloat(priceStr.replace(/[₹,\s]/g, '')) || 0;
    const priceStrLower = priceStr.toLowerCase();
    if (priceStrLower.includes('lakh') || priceStrLower.includes('l')) {
        priceNum = priceNum * 100000;
    } else if (priceStrLower.includes('cr') || priceStrLower.includes('crore')) {
        priceNum = priceNum * 10000000;
    }
    return priceNum;
};

propertySchema.pre('save', async function (next) {
    // Generate projectId if not exists
    if (!this.projectId) {
        const random = crypto.randomInt(10000, 99999);
        const formattedName = this.projectName.replace(/\s+/g, "");
        this.projectId = `#${formattedName}-${random}`;
    }

    // Calculate discount percentage if developerPrice and offerPrice exist
    if (this.developerPrice && this.offerPrice) {
        const devPrice = parsePriceToNumber(this.developerPrice);
        const offerPrice = parsePriceToNumber(this.offerPrice);

        if (devPrice > 0 && offerPrice > 0 && devPrice > offerPrice) {
            const discount = ((devPrice - offerPrice) / devPrice) * 100;
            this.discountPercentage = `${discount.toFixed(2)}%`;
        } else {
            this.discountPercentage = "00.00%";
        }
    } else {
        this.discountPercentage = "00.00%";
    }

    next();
});

module.exports = mongoose.model('Property', propertySchema);
