const mongoose = require("mongoose");

const DeveloperSchema = new mongoose.Schema({
    logo: {
        type: String,
        required: false,
        default: "",
    },
    developerName: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        default: "",
    },
    city: {
        type: String,
        required: true
    },
    establishedYear: {
        type: Number,
        required: true,
    },
    totalProjects: {
        type: Number,
        default: 0
    },
    website: {
        type: String
    },
    // Sourcing Manager Details
    sourcingManager: {
        name: {
            type: String,
            required: true
        },
        mobile: {
            type: String,
            required: true
        },
        email: {
            type: String,
            required: true,
            lowercase: true
        }
    }

}, {
    timestamps: true
});

module.exports = mongoose.model("Developer", DeveloperSchema);
