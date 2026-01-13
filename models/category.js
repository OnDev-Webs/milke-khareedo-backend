const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    // Used for case-insensitive lookups
    nameLower: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        unique: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

categorySchema.pre('validate', function (next) {
    if (this.name) {
        this.nameLower = this.name.toLowerCase();
    }
    next();
});

categorySchema.index({ nameLower: 1 }, { unique: true });

module.exports = mongoose.model('Category', categorySchema);
